import type { BlockContext, BlockShareLinkResult, BlockToParentMessage, ParentToBlockMessage } from '@civitai/app-sdk/blocks';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { DEFAULT_ACTIVE_INVITATIONS, MIB } from '../protocol/layout.ts';
import { liveFileAccept, prepareLiveSource, requireSaveCandidate, verifyLiveFile } from './live-files.ts';
import type { LiveFile } from './live-files.ts';
import {
  applyLiveAnswer, chatCode, chatMessageLimit, createLiveAnswer, createLiveOffer, createLivePeer, liveDataLabel,
  pickupFromHash, pickupHash, pickupWindowMs, readLiveOffer,
} from './live-signaling.ts';

const chunkSize = 16 * 1024;
const maxQueued = 512 * 1024;
const moveSaveAt = 64 * MIB;
const shaPattern = /^[0-9a-f]{64}$/;
const senderExpired = 'This handoff expired after 24 hours.';
const receiverExpired = 'This pickup offer expired.';

interface SenderInvitation {
  label: string;
  savedAt?: number;
  close(keepPeer?: boolean, reason?: 'expired' | 'closed'): void;
}

interface Handoff {
  file?: File;
  descriptor: LiveFile;
  expiresAt: number;
  elapsedDeadline: number;
  timer: ReturnType<typeof setTimeout>;
  recipients: SenderInvitation[];
  end: HTMLButtonElement;
}

function timeRemaining(wall: number, elapsed: number) {
  return Math.max(0, Math.min(wall - Date.now(), elapsed - performance.now()));
}

function part<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function action(text: string, kind = '') {
  const button = part('button', ('button ' + kind).trim(), text);
  button.type = 'button';
  return button;
}

function field(text: string, control: HTMLElement) {
  const label = part('label', 'field', text);
  label.append(control);
  return label;
}

function report(output: HTMLElement, text: string, isError = false) {
  output.textContent = text;
  output.classList.toggle('error', isError);
}

function status() {
  const output = part('p', 'status');
  output.setAttribute('role', 'status');
  return output;
}

function readPacket(data: unknown): Record<string, unknown> {
  if (typeof data !== 'string' || data.length > 2048) throw new Error('The pickup message is invalid.');
  const value: unknown = JSON.parse(data);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The pickup message is invalid.');
  return value as Record<string, unknown>;
}

function descriptor(message: Record<string, unknown>): LiveFile {
  const { name, size, sha256: digest } = message;
  if (message.type !== 'file' || typeof name !== 'string' || typeof size !== 'number' ||
    typeof digest !== 'string' || !shaPattern.test(digest)) throw new Error('The sender did not provide a valid file description.');
  requireSaveCandidate(name, size);
  return { name, size, sha256: digest };
}

async function sendFile(channel: RTCDataChannel, info: LiveFile, useFile: () => File, progress: (sent: number) => void) {
  useFile();
  channel.send(JSON.stringify({ type: 'file', ...info }));
  let lastUpdate = 0;
  for (let offset = 0; offset < info.size; offset += chunkSize) {
    const deadline = performance.now() + 15000;
    while (channel.bufferedAmount > maxQueued) {
      useFile();
      if (channel.readyState !== 'open' || performance.now() >= deadline) throw new Error('The direct connection stopped. Issue a fresh offer.');
      await new Promise<void>((resolve) => setTimeout(resolve, 8));
    }
    const chunk = await useFile().slice(offset, offset + chunkSize).arrayBuffer();
    useFile();
    channel.send(chunk);
    const sent = offset + chunk.byteLength;
    if (sent === info.size || sent - lastUpdate >= MIB) {
      lastUpdate = sent;
      progress(sent);
    }
  }
  useFile();
  channel.send(JSON.stringify({ type: 'end' }));
}

export function mountLivePickup(root: HTMLElement, sendToHost: (message: BlockToParentMessage, transfer?: Transferable[]) => void) {
  const source = root.querySelector<HTMLInputElement>('#live-source')!;
  const recipients = root.querySelector<HTMLTextAreaElement>('#live-recipients')!;
  const start = root.querySelector<HTMLButtonElement>('#live-start')!;
  const senderStatus = root.querySelector<HTMLElement>('#live-sender-status')!;
  const senderRows = root.querySelector<HTMLElement>('#live-sender-rows')!;
  const senderForm = root.querySelector<HTMLElement>('#live-sender-form')!;
  const offerInput = root.querySelector<HTMLTextAreaElement>('#live-offer')!;
  const connect = root.querySelector<HTMLButtonElement>('#live-accept')!;
  const receiverStatus = root.querySelector<HTMLElement>('#live-receiver-status')!;
  const receiverArea = root.querySelector<HTMLElement>('#live-receiver-area')!;
  const receiverForm = root.querySelector<HTMLElement>('#live-receiver-form')!;
  source.accept = liveFileAccept;
  let owner: Handoff | undefined;
  let closeGuest: (() => void) | undefined;
  let checkGuestDeadline: (() => void) | undefined;
  let checkOfferDeadline: (() => void) | undefined;
  let offerTimer: ReturnType<typeof setTimeout> | undefined;
  let saveRequest: { id: string; complete(message?: string): void; timer: ReturnType<typeof setTimeout> } | undefined;
  let shareRequest: { id: string; complete(result?: BlockShareLinkResult): void; timer: ReturnType<typeof setTimeout> } | undefined;
  let shareView: { origin: string; path: string } | undefined;
  let hostInitialized = false;
  const supported = typeof RTCPeerConnection === 'function' && typeof CompressionStream === 'function' && Boolean(crypto.subtle);

  function savedThroughHost(name: string, bytes: ArrayBuffer, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (saveRequest) { reject(new Error('Wait for the current browser save.')); return; }
      const id = crypto.randomUUID();
      const complete = (message?: string) => {
        if (saveRequest?.id !== id) return;
        clearTimeout(saveRequest.timer);
        saveRequest = undefined;
        signal?.removeEventListener('abort', cancel);
        if (message) reject(new Error(message));
        else resolve();
      };
      const cancel = () => complete('The pickup has closed.');
      saveRequest = { id, complete, timer: setTimeout(() => complete('Civitai did not start the file save.'), 90000) };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      try { sendToHost({ type: 'SAVE_IMAGE', payload: { requestId: id, filename: name, bytes } }, bytes.byteLength >= moveSaveAt ? [bytes] : undefined); }
      catch { complete('Civitai could not receive the file for saving.'); }
    });
  }

  function clearOfferDeadline() {
    clearTimeout(offerTimer);
    checkOfferDeadline = undefined;
  }

  function clearPickupRoute() {
    if (shareView) sendToHost({ type: 'NAVIGATE', payload: { path: '/', scope: 'app', target: 'current', replace: true } });
  }

  function loadPickupHash(hash: unknown) {
    const code = pickupFromHash(hash);
    if (!supported || !code || code === offerInput.value) return;
    clearOfferDeadline();
    offerInput.value = code;
    void readLiveOffer(code).then(({ expiresAt }) => {
      if (offerInput.value !== code) return;
      const elapsedDeadline = performance.now() + Math.min(pickupWindowMs, expiresAt - Date.now());
      const check = () => {
        if (timeRemaining(expiresAt, elapsedDeadline)) return;
        if (offerInput.value === code) {
          offerInput.value = '';
          clearPickupRoute();
          if (!closeGuest) report(receiverStatus, receiverExpired);
        }
        clearOfferDeadline();
      };
      checkOfferDeadline = check;
      offerTimer = setTimeout(check, timeRemaining(expiresAt, elapsedDeadline));
      check();
      if (offerInput.value === code && !closeGuest) {
        report(receiverStatus, 'Pickup offer loaded. Create your reply to continue.');
        root.querySelector('#pickup')?.scrollIntoView({ block: 'nearest' });
      }
    }).catch(() => {
      if (offerInput.value === code) {
        offerInput.value = '';
        clearPickupRoute();
        if (!closeGuest) report(receiverStatus, 'This pickup link is invalid. Ask the sender for a fresh offer.', true);
      }
    });
  }
  offerInput.addEventListener('input', clearOfferDeadline);

  function sharePickup(hash: string) {
    return new Promise<BlockShareLinkResult>((resolve, reject) => {
      if (shareRequest) { reject(new Error('Wait for Civitai to finish the current share.')); return; }
      const id = crypto.randomUUID();
      const complete = (result?: BlockShareLinkResult) => {
        if (shareRequest?.id !== id) return;
        clearTimeout(shareRequest.timer);
        shareRequest = undefined;
        if (!result) reject(new Error('Share the pickup offer code in private Civitai chat.'));
        else resolve(result);
      };
      shareRequest = { id, complete, timer: setTimeout(complete, 5000) };
      try { sendToHost({ type: 'SHARE_LINK', payload: { requestId: id, subPath: '', hash } }); }
      catch { complete(); }
    });
  }

  function endHandoff(current: Handoff, text: string) {
    if (!current.file) return;
    current.file = undefined;
    clearTimeout(current.timer);
    for (const invite of current.recipients) invite.close(invite.savedAt !== undefined, text === senderExpired ? 'expired' : 'closed');
    current.end.disabled = true;
    current.end.hidden = true;
    current.end.onclick = null;
    owner = undefined;
    senderForm.hidden = false;
    start.disabled = false;
    report(senderStatus, text);
  }

  function requireSource(current: Handoff) {
    if (current.file && !timeRemaining(current.expiresAt, current.elapsedDeadline)) {
      endHandoff(current, senderExpired);
    }
    if (!current.file) throw new Error('This handoff is closed.');
    return current.file;
  }

  function invitationRow(current: Handoff, label: string) {
    const row = part('article', 'row');
    const prepare = action('Create pickup offer', 'primary');
    const offer = part('textarea');
    offer.readOnly = true;
    offer.rows = 2;
    offer.onfocus = () => offer.select();
    const offerField = field('Pickup offer for ' + label, offer);
    offerField.classList.add('hidden');
    const share = action('Copy pickup link');
    share.classList.add('hidden');
    const link = part('input');
    link.readOnly = true;
    link.onfocus = () => link.select();
    const linkField = field('Pickup link for ' + label, link);
    linkField.classList.add('hidden');
    const answer = part('textarea');
    answer.rows = 2;
    const answerField = field('Pickup reply from ' + label, answer);
    answerField.classList.add('hidden');
    const accept = action('Connect recipient');
    accept.disabled = accept.hidden = true;
    const feedback = status();
    row.append(part('h3', '', label), feedback, prepare, share, linkField, offerField, answerField, accept);
    senderRows.append(row);
    let peer: RTCPeerConnection | undefined;
    let activeChannel: RTCDataChannel | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const clearShare = () => {
      share.classList.add('hidden');
      share.onclick = null;
      link.value = '';
      linkField.classList.add('hidden');
    };
    const invitation: SenderInvitation = {
      label,
      close(keepPeer = false, reason) {
        if (!keepPeer) {
          clearTimeout(closeTimer);
          const ending = peer;
          peer = undefined;
          if (reason && activeChannel?.readyState === 'open') {
            try {
              activeChannel.send(JSON.stringify({ type: 'pickup-closed', reason }));
              activeChannel.close();
              closeTimer = setTimeout(() => ending?.close(), 1500);
            } catch { ending?.close(); }
          } else ending?.close();
        }
        activeChannel = undefined;
        offer.value = answer.value = '';
        offerField.classList.add('hidden');
        answerField.classList.add('hidden');
        clearShare();
        accept.onclick = prepare.onclick = null;
        accept.disabled = prepare.disabled = true;
        prepare.hidden = accept.hidden = true;
        if (!invitation.savedAt) report(feedback, 'Pickup closed.');
      },
    };

    prepare.onclick = () => {
      prepare.disabled = accept.disabled = accept.hidden = true;
      offer.value = answer.value = '';
      offerField.classList.add('hidden');
      answerField.classList.add('hidden');
      clearShare();
      const previous = peer;
      peer = undefined;
      activeChannel = undefined;
      previous?.close();
      let session: RTCPeerConnection | undefined;
      void (async () => {
        requireSource(current);
        session = peer = createLivePeer();
        const channel = activeChannel = session.createDataChannel(liveDataLabel, { ordered: true });
        let fileSent = false;
        let saveAllowed = false;
        const onFailure = (error: unknown) => {
          if (current.file && peer === session && !invitation.savedAt) {
            report(feedback, error instanceof Error ? error.message : 'The direct connection stopped.', true);
            prepare.disabled = false;
            prepare.textContent = 'Create fresh offer';
          }
          if (current.file || peer !== session) session?.close();
        };
        channel.onclose = () => {
          if (current.file && peer === session && !invitation.savedAt) onFailure(new Error('Connection closed. Create a fresh pickup offer.'));
        };
        channel.onerror = () => onFailure(new Error('The direct connection stopped. Issue a fresh offer.'));
        session.onconnectionstatechange = () => {
          if (session?.connectionState === 'failed') onFailure(new Error('A direct connection could not be made.'));
        };
        const sendCurrent = () => {
          if (peer !== session) return;
          fileSent = saveAllowed = false;
          report(feedback, 'Sending file…');
          void sendFile(channel, current.descriptor, () => {
            if (peer !== session) throw new Error('This pickup offer was replaced.');
            return requireSource(current);
          }, (sent) => report(feedback, 'Sent ' + Math.floor(sent / current.descriptor.size * 100) + '%')).then(() => {
            fileSent = true;
            report(feedback, 'Delivered to browser. Waiting for a verified save.');
          }).catch(onFailure);
        };
        channel.onopen = sendCurrent;
        channel.onmessage = ({ data }) => {
          try {
            if (peer !== session || invitation.savedAt) return;
            requireSource(current);
            const receipt = readPacket(data);
            if (fileSent && receipt.type === 'request-save') {
              saveAllowed = true;
              channel.send(JSON.stringify({ type: 'save-authorized' }));
              return;
            }
            if (fileSent && saveAllowed && current.descriptor.size >= moveSaveAt && receipt.type === 'request-file') {
              sendCurrent();
              return;
            }
            if (!fileSent || !saveAllowed || receipt.type !== 'saved' || receipt.sha256 !== current.descriptor.sha256 ||
              receipt.size !== current.descriptor.size) throw new Error('The recipient sent an invalid pickup receipt.');
            invitation.savedAt = Date.now();
            report(feedback, 'Verified save · ' + new Date(invitation.savedAt).toLocaleString());
            invitation.close(true);
            const verified = current.recipients.filter((item) => item.savedAt !== undefined).length;
            const allSaved = verified === current.recipients.length;
            if (allSaved) endHandoff(current, 'All recipients verified their saves. This handoff is closed.');
            else report(senderStatus, `${verified} of ${current.recipients.length} verified · Expires ${new Date(current.expiresAt).toLocaleString()}`);
            channel.send(JSON.stringify({ type: 'saved-confirmed' }));
            channel.close();
            peer = undefined;
            closeTimer = setTimeout(() => session?.close(), 1500);
          } catch (error) { onFailure(error); }
        };
        const ticket = await createLiveOffer(session, current.expiresAt);
        requireSource(current);
        offer.value = chatCode(ticket.code);
        offerField.classList.remove('hidden');
        answerField.classList.remove('hidden');
        const view = shareView;
        const hash = pickupHash(ticket.code);
        if (view && (view.origin + view.path + '/' + hash).length <= chatMessageLimit) {
          share.disabled = false;
          share.classList.remove('hidden');
          share.onclick = () => {
            try { requireSource(current); } catch { return; }
            share.disabled = true;
            const isCurrentOffer = () => Boolean(current.file && peer === session && offer.value);
            void sharePickup(hash).then((result) => {
              if (!isCurrentOffer()) return;
              requireSource(current);
              const url = new URL(result.url);
              if (url.origin !== view.origin || url.username || url.password || url.search || url.hash !== hash ||
                (url.pathname !== view.path && url.pathname !== view.path + '/') || url.href.length > chatMessageLimit) {
                throw new Error('Civitai did not return this pickup link. Share the offer code in private chat.');
              }
              link.value = url.href;
              linkField.classList.remove('hidden');
              report(feedback, result.copied ? 'Pickup link copied. Send it in private Civitai chat.' :
                result.method === 'share' ? 'Civitai opened sharing. Use private Civitai chat.' :
                  'Copy the displayed pickup link into private Civitai chat.');
            }).catch((error: unknown) => {
              if (isCurrentOffer()) report(feedback, error instanceof Error ? error.message : 'Share the offer code in private Civitai chat.', true);
            }).finally(() => { if (isCurrentOffer()) share.disabled = false; });
          };
        }
        accept.disabled = accept.hidden = false;
        prepare.disabled = false;
        report(feedback, 'Send the offer in private Civitai chat. Paste the reply when it arrives.');
        accept.onclick = () => {
          accept.disabled = true;
          void (async () => {
            requireSource(current);
            if (peer !== session || !session) throw new Error('Create a fresh pickup offer.');
            await applyLiveAnswer(session, ticket.offer, answer.value);
            requireSource(current);
            if (peer !== session) return;
            offer.value = answer.value = '';
            offerField.classList.add('hidden');
            answerField.classList.add('hidden');
            accept.hidden = true;
            clearShare();
            report(feedback, 'Connecting directly…');
          })().catch((error: unknown) => {
            if (!current.file || peer !== session) return;
            report(feedback, error instanceof Error ? error.message : 'The pickup reply was rejected.', true);
            accept.disabled = false;
          });
        };
      })().catch((error: unknown) => {
        session?.close();
        if (!current.file) return;
        prepare.disabled = false;
        report(feedback, error instanceof Error ? error.message : 'Could not create a pickup offer.', true);
      });
    };
    current.recipients.push(invitation);
  }

  start.onclick = () => {
    if (!supported || owner?.file || start.disabled) return;
    start.disabled = true;
    report(senderStatus, 'Checking the file…');
    void (async () => {
      const files = Array.from(source.files ?? []);
      const names = recipients.value.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
      if (!names.length || names.length > DEFAULT_ACTIVE_INVITATIONS || names.some((name) => name.length > 80) ||
        new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
        throw new Error('Enter 1 to 20 distinct recipients, one per line.');
      }
      const { file, info } = await prepareLiveSource(files);
      const end = action('Close handoff', 'danger');
      const current: Handoff = { file, descriptor: info, expiresAt: Date.now() + pickupWindowMs,
        elapsedDeadline: performance.now() + pickupWindowMs, recipients: [], end,
        timer: setTimeout(() => endHandoff(current, senderExpired), pickupWindowMs) };
      owner = current;
      source.value = '';
      recipients.value = '';
      senderForm.hidden = true;
      senderRows.replaceChildren();
      for (const name of names) invitationRow(current, name);
      end.onclick = () => endHandoff(current, 'This handoff was closed by the sender.');
      senderRows.append(end);
      report(senderStatus, 'Ready to share until ' + new Date(current.expiresAt).toLocaleString() + '. ' + info.name);
    })().catch((error: unknown) => {
      start.disabled = false;
      report(senderStatus, error instanceof Error ? error.message : 'Could not prepare the handoff.', true);
    });
  };

  connect.onclick = () => {
    if (!supported || connect.disabled) return;
    if (!offerInput.value.trim()) { offerInput.focus(); return; }
    closeGuest?.();
    connect.disabled = true;
    receiverArea.replaceChildren();
    report(receiverStatus, 'Preparing your pickup reply…');
    void (async () => {
      const code = offerInput.value;
      const offer = await readLiveOffer(code);
      if (Date.now() >= offer.expiresAt) {
        clearOfferDeadline();
        offerInput.value = '';
        clearPickupRoute();
        report(receiverStatus, receiverExpired);
        return;
      }
      const peer = createLivePeer();
      const reply = part('textarea');
      reply.rows = 2;
      reply.readOnly = true;
      reply.onfocus = () => reply.select();
      const replyField = field('Your pickup reply', reply);
      const output = part('div', 'stack');
      const cancel = action('Cancel pickup');
      receiverArea.append(replyField, output, cancel);
      let receiptPending = false;
      let receiptConfirmed = false;
      let closed = false;
      let bytes: Uint8Array<ArrayBuffer> | undefined;
      let downloadedFile: LiveFile | undefined;
      let offset = 0;
      let hash = sha256.create();
      const abort = new AbortController();
      const elapsedDeadline = performance.now() + Math.min(pickupWindowMs, offer.expiresAt - Date.now());
      let resolveSave: (() => void) | undefined;
      let cancelSave: (() => void) | undefined;
      function checkDeadline() {
        if (!closed && !timeRemaining(offer.expiresAt, elapsedDeadline)) {
          close();
          report(receiverStatus, receiverExpired);
        }
      }
      const expire = setTimeout(checkDeadline, timeRemaining(offer.expiresAt, elapsedDeadline));
      function close() {
        if (closed) return;
        closed = true;
        clearTimeout(expire);
        closeGuest = checkGuestDeadline = undefined;
        abort.abort();
        cancelSave?.();
        peer.close();
        bytes = undefined;
        downloadedFile = undefined;
        hash.destroy();
        if (offerInput.value === code) {
          offerInput.value = '';
          clearOfferDeadline();
          clearPickupRoute();
        }
        reply.value = '';
        replyField.classList.add('hidden');
        output.replaceChildren();
        cancel.remove();
        receiverForm.hidden = false;
      }
      closeGuest = close;
      checkGuestDeadline = checkDeadline;
      receiverForm.hidden = true;
      cancel.onclick = () => { close(); report(receiverStatus, 'Pickup canceled.'); };
      function fail(error: unknown) {
        if (closed) return;
        close();
        report(receiverStatus, error instanceof Error ? error.message : 'Pickup ended before verification.', true);
      }
      function requireOpen() {
        checkDeadline();
        if (closed) throw new Error('This pickup offer is closed.');
      }
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'failed') fail(new Error('A direct connection could not be made.'));
      };
      peer.ondatachannel = ({ channel }) => {
        if (channel.label !== liveDataLabel || !channel.ordered) {
          fail(new Error('This pickup uses an incompatible connection.'));
          return;
        }
        peer.ondatachannel = ({ channel: extra }) => extra.close();
        channel.binaryType = 'arraybuffer';
        channel.onopen = () => {
          reply.value = '';
          replyField.classList.add('hidden');
          report(receiverStatus, 'Receiving the file…');
        };
        channel.onclose = () => {
          if (!receiptConfirmed) fail(new Error(receiptPending ? 'The receipt was sent. Ask the sender to confirm it arrived.' :
            'The sender closed the connection before verification.'));
        };
        channel.onerror = () => fail(new Error('The direct connection stopped.'));
        let completed = false;
        channel.onmessage = ({ data }) => {
          try {
            requireOpen();
            const packet = typeof data === 'string' ? readPacket(data) : undefined;
            if (packet?.type === 'pickup-closed') {
              throw new Error(packet.reason === 'expired' ? receiverExpired : 'The sender closed the connection before verification.');
            }
            if (packet?.type === 'save-authorized') {
              if (!resolveSave) throw new Error('The sender returned an unexpected save authorization.');
              resolveSave();
              return;
            }
            if (!downloadedFile) {
              if (!packet) throw new Error('The sender did not provide a valid file description.');
              downloadedFile = descriptor(packet);
              bytes = new Uint8Array(downloadedFile.size);
              return;
            }
            if (data instanceof ArrayBuffer) {
              if (completed || !bytes || !data.byteLength || data.byteLength > chunkSize || data.byteLength > bytes.length - offset) {
                throw new Error('The received file did not match its declared length.');
              }
              const chunk = new Uint8Array(data);
              bytes.set(chunk, offset);
              hash.update(chunk);
              offset += chunk.length;
              return;
            }
            if (completed) {
              if (!receiptPending || packet?.type !== 'saved-confirmed') throw new Error('The sender sent an invalid receipt confirmation.');
              receiptConfirmed = true;
              close();
              report(receiverStatus, 'Verified save confirmed by the sender.');
              return;
            }
            if (packet?.type !== 'end' || offset !== downloadedFile.size || bytesToHex(hash.digest()) !== downloadedFile.sha256) {
              throw new Error('The received file did not match the sender’s SHA-256.');
            }
            completed = true;
            const info = downloadedFile;
            const save = action('Save file', 'primary');
            const verify = part('input');
            verify.type = 'file';
            verify.disabled = true;
            const verification = field('Verify saved file', verify);
            verification.hidden = true;
            output.append(part('h3', '', info.name), save, verification);
            report(receiverStatus, 'Incoming file verified. Save it, then select the saved copy.');
            save.onclick = () => {
              save.disabled = true;
              void (async () => {
                requireOpen();
                if (!bytes) {
                  hash = sha256.create();
                  offset = 0;
                  completed = false;
                  downloadedFile = undefined;
                  output.replaceChildren();
                  report(receiverStatus, 'Receiving a fresh copy…');
                  try { channel.send(JSON.stringify({ type: 'request-file' })); }
                  catch { fail(new Error('Ask the sender for a fresh offer.')); }
                  return;
                }
                await new Promise<void>((resolve, reject) => {
                  const reset = () => {
                    clearTimeout(timer);
                    resolveSave = cancelSave = undefined;
                  };
                  const cancel = () => {
                    reset();
                    reject(new Error('The sender did not authorize the save.'));
                  };
                  const timer = setTimeout(cancel, 10000);
                  resolveSave = () => { reset(); resolve(); };
                  cancelSave = cancel;
                  try { channel.send(JSON.stringify({ type: 'request-save' })); } catch { cancel(); }
                });
                requireOpen();
                if (!bytes) throw new Error('The pickup has closed.');
                const buffer = bytes.buffer;
                try { await savedThroughHost(info.name, buffer, abort.signal); }
                finally {
                  if (buffer.byteLength === 0) {
                    bytes = undefined;
                    save.textContent = 'Get a fresh copy';
                    save.classList.remove('primary');
                  }
                }
                requireOpen();
                verify.disabled = false;
                verification.hidden = false;
                report(receiverStatus, 'Civitai started the save. Select the finished file to verify it on disk.');
              })().catch((error: unknown) => {
                if (closed) return;
                report(receiverStatus, error instanceof Error ? error.message : 'Civitai refused to save the file.', true);
              }).finally(() => { if (!closed && !receiptPending) save.disabled = false; });
            };
            verify.onchange = () => {
              const saved = verify.files?.[0];
              verify.value = '';
              if (!saved || receiptPending) return;
              verify.disabled = save.disabled = true;
              void (async () => {
                requireOpen();
                if (!await verifyLiveFile(saved, info, abort.signal)) throw new Error('The saved file did not match the sender’s SHA-256.');
                requireOpen();
                channel.send(JSON.stringify({ type: 'saved', size: info.size, sha256: info.sha256 }));
                bytes = undefined;
                receiptPending = true;
                report(receiverStatus, 'Verified save. Waiting for the sender to confirm the receipt.');
              })().catch((error: unknown) => {
                if (closed) return;
                verify.disabled = save.disabled = false;
                report(receiverStatus, error instanceof Error ? error.message : 'Could not verify the saved file.', true);
              });
            };
          } catch (error) { fail(error); }
        };
      };
      try {
        const answer = await createLiveAnswer(peer, offer);
        requireOpen();
        reply.value = chatCode(answer);
        if (offerInput.value === code) {
          offerInput.value = '';
          clearOfferDeadline();
          clearPickupRoute();
        }
        report(receiverStatus, 'Send this reply to the sender through Civitai chat. Keep this tab open.');
      } catch (error) {
        if (closed) return;
        close();
        throw error;
      }
    })().catch((error: unknown) => report(receiverStatus, error instanceof Error ? error.message : 'Could not open the pickup offer.', true))
      .finally(() => { connect.disabled = false; });
  };

  function checkDeadlines() {
    if (owner && !timeRemaining(owner.expiresAt, owner.elapsedDeadline)) endHandoff(owner, senderExpired);
    checkGuestDeadline?.();
    checkOfferDeadline?.();
  }
  document.addEventListener('visibilitychange', checkDeadlines);
  document.addEventListener('resume', checkDeadlines);
  window.addEventListener('focus', checkDeadlines);
  window.addEventListener('pageshow', checkDeadlines);
  window.addEventListener('pagehide', () => {
    if (owner) endHandoff(owner, 'The sender closed this tab.');
    closeGuest?.();
    offerInput.value = '';
    clearOfferDeadline();
  });

  return {
    saveFile: savedThroughHost,
    hostReady(origin: string, context: BlockContext) {
      if (hostInitialized) return;
      hostInitialized = true;
      if ('search' in context && typeof context.search === 'string' && 'slug' in context &&
        typeof context.slug === 'string' && /^[a-z0-9-]+$/.test(context.slug)) {
        shareView = { origin, path: '/apps/run/' + context.slug };
      }
      if ('hash' in context) loadPickupHash(context.hash);
      if (!supported) {
        report(senderStatus, 'This browser does not support live pickup in the app frame.', true);
        return;
      }
      if (!owner?.file) start.disabled = false;
      connect.disabled = false;
    },
    handleSave(message: Extract<ParentToBlockMessage, { type: 'SAVE_IMAGE_RESULT' }>) {
      if (message.payload?.requestId === saveRequest?.id) {
        saveRequest?.complete(message.payload.ok ? undefined : message.payload.error || 'Civitai refused to save the file.');
      }
    },
    handleShare(message: Extract<ParentToBlockMessage, { type: 'SHARE_LINK_RESULT' }>) {
      if (message.payload?.requestId === shareRequest?.id) shareRequest?.complete(message.payload.result);
    },
    loadPickupHash,
  };
}
