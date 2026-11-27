import type { BlockContext, BlockShareLinkResult, BlockToParentMessage, ParentToBlockMessage } from '@civitai/app-sdk/blocks';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { DEFAULT_ACTIVE_INVITATIONS, MIB } from '../protocol/layout.ts';
import { liveFileAccept, prepareLiveSource, previewLiveArchive, requireSaveCandidate, verifyLiveFile } from './live-files.ts';
import type { LiveArchivePreview, LiveFile } from './live-files.ts';
import { createDropoffRequest, readDropoffRequest } from './dropoff-request.ts';
import {
  chatCode, chatMessageLimit, createLiveAnswer, createLiveOffer, createLivePeer, liveDataLabel,
  pickupFromHash, pickupHash, pickupWindowMs, readLiveAnswer, readLiveOffer,
} from './live-signaling.ts';

const chunkSize = 16 * 1024;
const maxQueued = 512 * 1024;
const moveSaveAt = 64 * MIB;
const shaPattern = /^[0-9a-f]{64}$/;
const senderExpired = 'This handoff expired after 24 hours.';
const receiverExpired = 'This pickup offer expired.';
const dropoffExpired = 'This drop-off request expired.';

type DropoffRequest = ReturnType<typeof createDropoffRequest> & { elapsedDeadline: number };

interface SenderInvitation {
  label: string;
  savedAt?: number;
  revoked?: true;
  close(keepPeer?: boolean, reason?: 'expired' | 'closed' | 'revoked'): void;
}

interface Handoff {
  file?: File;
  descriptor: LiveFile;
  expiresAt: number;
  elapsedDeadline: number;
  expiryMessage: string;
  timer: ReturnType<typeof setTimeout>;
  recipients: SenderInvitation[];
  end: HTMLButtonElement;
  receipts: HTMLButtonElement;
}

interface RetainedPickup {
  transferId: string;
  offerId: string;
  expiresAt: number;
  elapsedDeadline: number;
  file: LiveFile;
  bytes: Uint8Array<ArrayBuffer>;
  offset: number;
  hash: ReturnType<typeof sha256.create>;
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

function packagePreview(info: LiveFile, archive?: LiveArchivePreview) {
  const preview = part('div', 'stack live-package');
  preview.append(part('strong', '', info.name), part('p', 'quiet muted', info.size.toLocaleString() + ' bytes'));
  if (archive) {
    const details = part('details');
    details.append(part('summary', '', archive.entryCount + (archive.entryCount === 1 ? ' archive entry' : ' archive entries')));
    const entries = part('ul', 'package-entries');
    for (const entry of archive.entries) {
      entries.append(part('li', '', entry.name + ' · ' + entry.size.toLocaleString() + ' bytes'));
    }
    details.append(entries);
    if (archive.entries.length < archive.entryCount) {
      details.append(part('p', 'quiet muted', 'Showing the first ' + archive.entries.length + ' entries.'));
    }
    preview.append(details);
  }
  return preview;
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

async function sendFile(channel: RTCDataChannel, info: LiveFile, startOffset: number, useFile: () => File, progress: (sent: number) => void) {
  useFile();
  channel.send(JSON.stringify({ type: 'file', ...info, ...(startOffset ? { offset: startOffset } : {}) }));
  let lastUpdate = startOffset;
  for (let offset = startOffset; offset < info.size; offset += chunkSize) {
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
  const senderPreview = root.querySelector<HTMLElement>('#live-sender-preview')!;
  const senderRows = root.querySelector<HTMLElement>('#live-sender-rows')!;
  const senderForm = root.querySelector<HTMLElement>('#live-sender-form')!;
  const senderTitle = root.querySelector<HTMLElement>('#send-title')!;
  const recipientField = root.querySelector<HTMLElement>('#recipient-field')!;
  const recipientHint = root.querySelector<HTMLElement>('#recipients-hint')!;
  const requestedFiles = root.querySelector<HTMLElement>('#requested-files')!;
  const requestedList = root.querySelector<HTMLUListElement>('#requested-file-list')!;
  const cancelDropoff = root.querySelector<HTMLButtonElement>('#cancel-dropoff')!;
  const requestButton = root.querySelector<HTMLButtonElement>('#create-dropoff')!;
  const requestChecklist = root.querySelector<HTMLTextAreaElement>('#dropoff-checklist')!;
  const requestLink = root.querySelector<HTMLInputElement>('#dropoff-link')!;
  const requestField = root.querySelector<HTMLElement>('#dropoff-link-field')!;
  const requestStatus = root.querySelector<HTMLElement>('#dropoff-status')!;
  const offerInput = root.querySelector<HTMLTextAreaElement>('#live-offer')!;
  const connect = root.querySelector<HTMLButtonElement>('#live-accept')!;
  const discardPartial = root.querySelector<HTMLButtonElement>('#discard-partial')!;
  const receiverStatus = root.querySelector<HTMLElement>('#live-receiver-status')!;
  const receiverArea = root.querySelector<HTMLElement>('#live-receiver-area')!;
  const receiverForm = root.querySelector<HTMLElement>('#live-receiver-form')!;
  source.accept = liveFileAccept;
  let owner: Handoff | undefined;
  let closeGuest: (() => void) | undefined;
  let checkGuestDeadline: (() => void) | undefined;
  let checkOfferDeadline: (() => void) | undefined;
  let offerTimer: ReturnType<typeof setTimeout> | undefined;
  let incomingDropoff: DropoffRequest | undefined;
  let incomingTimer: ReturnType<typeof setTimeout> | undefined;
  let issuedDropoff: DropoffRequest | undefined;
  let issuedTimer: ReturnType<typeof setTimeout> | undefined;
  let retained: RetainedPickup | undefined;
  let retentionTimer: ReturnType<typeof setTimeout> | undefined;
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

  function dropoffDeadline(request: ReturnType<typeof createDropoffRequest>): DropoffRequest {
    return { ...request, elapsedDeadline: performance.now() + Math.min(pickupWindowMs, request.expiresAt - Date.now()) };
  }

  function setDropoff(request?: DropoffRequest) {
    clearTimeout(incomingTimer);
    if (incomingDropoff !== request && (incomingDropoff || request)) source.value = '';
    incomingDropoff = request;
    recipientField.hidden = recipientHint.hidden = Boolean(request);
    cancelDropoff.hidden = !request;
    requestedList.replaceChildren(...(request?.items ?? []).map((item) => part('li', '', item)));
    requestedFiles.hidden = !request?.items.length;
    senderTitle.textContent = request ? 'Drop off a file' : 'Send files';
    start.textContent = request ? 'Prepare drop-off' : 'Prepare handoff';
    if (request) incomingTimer = setTimeout(checkDeadlines, Math.ceil(timeRemaining(request.expiresAt, request.elapsedDeadline)));
  }

  function clearIssuedRequest() {
    clearTimeout(issuedTimer);
    issuedDropoff = undefined;
    requestLink.value = '';
    requestField.hidden = true;
  }

  function loadRouteHash(hash: unknown) {
    try {
      const request = readDropoffRequest(hash);
      if (!request) {
        if (incomingDropoff && pickupFromHash(hash) && !start.disabled) setDropoff();
        loadPickupHash(hash);
        return;
      }
      if (!supported || owner?.file || start.disabled || incomingDropoff?.hash === request.hash) return;
      setDropoff(dropoffDeadline(request));
      report(senderStatus, 'Choose a file, then return its pickup link in the private chat where you got this request.');
      root.querySelector('#send')?.scrollIntoView({ block: 'nearest' });
    } catch (error) {
      if (typeof hash !== 'string' || !hash.startsWith('#dropoff=') || owner?.file || start.disabled) return;
      setDropoff();
      clearPickupRoute();
      report(senderStatus, error instanceof Error ? error.message : 'Could not open the drop-off request.', true);
    }
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

  function sharePickup(hash: string, fallback = 'Share the pickup offer code in private Civitai chat.') {
    return new Promise<BlockShareLinkResult>((resolve, reject) => {
      if (shareRequest) { reject(new Error('Wait for Civitai to finish the current share.')); return; }
      const id = crypto.randomUUID();
      const complete = (result?: BlockShareLinkResult) => {
        if (shareRequest?.id !== id) return;
        clearTimeout(shareRequest.timer);
        shareRequest = undefined;
        if (!result) reject(new Error(fallback));
        else resolve(result);
      };
      shareRequest = { id, complete, timer: setTimeout(complete, 5000) };
      try { sendToHost({ type: 'SHARE_LINK', payload: { requestId: id, subPath: '', hash } }); }
      catch { complete(); }
    });
  }

  function ownShareUrl(url: string, view: NonNullable<typeof shareView>, hash: string) {
    const address = new URL(url);
    if (address.origin !== view.origin || address.username || address.password || address.search || address.hash !== hash ||
      (address.pathname !== view.path && address.pathname !== view.path + '/') || address.href.length > chatMessageLimit) {
      throw new Error('Civitai did not return the requested app link.');
    }
    return address.href;
  }

  requestLink.onfocus = () => requestLink.select();
  requestButton.onclick = () => {
    const view = shareView;
    if (!view || requestButton.disabled) return;
    let request: DropoffRequest;
    try { request = dropoffDeadline(createDropoffRequest(requestChecklist.value)); }
    catch (error) {
      report(requestStatus, error instanceof Error ? error.message : 'Could not create a drop-off request.', true);
      return;
    }
    clearIssuedRequest();
    issuedDropoff = request;
    issuedTimer = setTimeout(checkDeadlines, Math.ceil(timeRemaining(request.expiresAt, request.elapsedDeadline)));
    requestLink.value = view.origin + view.path + request.hash;
    requestField.hidden = false;
    requestButton.disabled = true;
    const shareAdvice = 'Copy the request link into private Civitai chat. It expires in 24 hours.';
    report(requestStatus, shareAdvice);
    void sharePickup(request.hash, shareAdvice).then((result) => {
      if (issuedDropoff !== request || !timeRemaining(request.expiresAt, request.elapsedDeadline)) return;
      requestLink.value = ownShareUrl(result.url, view, request.hash);
      if (result.copied) report(requestStatus, 'Request link copied. Send it in private Civitai chat.');
    }).catch(() => {
      if (issuedDropoff === request) report(requestStatus, shareAdvice);
    }).finally(() => { requestButton.disabled = false; });
  };

  cancelDropoff.onclick = () => {
    setDropoff();
    clearPickupRoute();
    report(senderStatus, '');
  };

  function endHandoff(current: Handoff, text: string) {
    if (!current.file) return;
    current.file = undefined;
    clearTimeout(current.timer);
    for (const invite of current.recipients) {
      if (invite.savedAt === undefined && !invite.revoked) invite.close(false, text === current.expiryMessage ? 'expired' : 'closed');
    }
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
      endHandoff(current, current.expiryMessage);
    }
    if (!current.file) throw new Error('This handoff is closed.');
    return current.file;
  }

  function saveReceiptDocument(button: HTMLButtonElement, feedback: HTMLElement, filename: string, document: object) {
    if (button.disabled) return;
    button.disabled = true;
    report(feedback, '');
    const bytes = new TextEncoder().encode(JSON.stringify(document, null, 2) + '\n');
    void savedThroughHost(filename, bytes.buffer)
      .then(() => report(feedback, 'Receipt download started.'))
      .catch((error: unknown) => report(feedback, error instanceof Error ? error.message : 'Could not save the receipts.', true))
      .finally(() => { button.disabled = false; });
  }

  function updateSenderProgress(current: Handoff) {
    const required = current.recipients.filter((item) => !item.revoked);
    const verified = required.filter((item) => item.savedAt !== undefined).length;
    current.receipts.hidden = !verified;
    if (!required.length) endHandoff(current, 'Every pickup was revoked. This handoff is closed.');
    else if (verified === required.length) {
      const subject = required.length === current.recipients.length ? 'All recipients' : 'All remaining recipients';
      endHandoff(current, subject + ' verified their saves. This handoff is closed.');
    } else report(senderStatus, `${verified} of ${required.length} verified · Expires ${new Date(current.expiresAt).toLocaleString()}`);
  }

  function invitationRow(current: Handoff, label: string, showLink = false) {
    const row = part('article', 'row');
    const prepare = action('Create pickup offer', 'primary');
    const revoke = action('Revoke pickup');
    revoke.setAttribute('aria-label', 'Revoke pickup for ' + label);
    const saveReceipt = action('Save receipt');
    saveReceipt.setAttribute('aria-label', 'Save receipt for ' + label);
    saveReceipt.hidden = true;
    const receiptStatus = status();
    const receiptFilename = 'civitai-safe-pickup-receipt-' + (current.recipients.length + 1) + '.json';
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
    row.append(part('h3', '', label), feedback, prepare, share, linkField, offerField, answerField, accept, revoke, saveReceipt, receiptStatus);
    senderRows.append(row);
    const transferId = crypto.randomUUID();
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
        accept.onclick = prepare.onclick = revoke.onclick = null;
        accept.disabled = prepare.disabled = revoke.disabled = true;
        prepare.hidden = accept.hidden = revoke.hidden = true;
        saveReceipt.hidden = invitation.savedAt === undefined;
        if (invitation.savedAt === undefined) report(feedback, invitation.revoked ? 'Pickup revoked.' : 'Pickup closed.');
      },
    };

    revoke.onclick = () => {
      try { requireSource(current); } catch { return; }
      if (invitation.revoked || invitation.savedAt !== undefined) return;
      invitation.revoked = true;
      invitation.close(false, 'revoked');
      updateSenderProgress(current);
    };
    saveReceipt.onclick = () => {
      if (invitation.savedAt === undefined || saveReceipt.disabled) return;
      const receipt = {
        type: 'civitai-safe.pickup-receipt',
        version: 1,
        recipientLabel: invitation.label,
        verifiedAt: new Date(invitation.savedAt).toISOString(),
        verification: 'saved-file-sha256',
        file: current.descriptor,
      };
      saveReceiptDocument(saveReceipt, receiptStatus, receiptFilename, receipt);
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
        let resumeOffset = 0;
        const onFailure = (error: unknown) => {
          if (current.file && peer === session && !invitation.savedAt) {
            peer = undefined;
            activeChannel = undefined;
            offer.value = answer.value = '';
            offerField.classList.add('hidden');
            answerField.classList.add('hidden');
            clearShare();
            accept.disabled = accept.hidden = true;
            report(feedback, error instanceof Error ? error.message : 'The direct connection stopped.', true);
            prepare.disabled = false;
            prepare.textContent = 'Create fresh offer';
          }
          if (current.file || peer !== session) session?.close();
        };
        channel.onclose = () => {
          if (current.file && peer === session && !invitation.savedAt) {
            onFailure(new Error('Connection closed. Create a fresh offer and send it back to this recipient.'));
          }
        };
        channel.onerror = () => onFailure(new Error('The direct connection stopped. Issue a fresh offer.'));
        session.onconnectionstatechange = () => {
          if (session?.connectionState === 'failed') onFailure(new Error('A direct connection could not be made.'));
        };
        const sendCurrent = (startOffset = 0) => {
          if (peer !== session) return;
          fileSent = saveAllowed = false;
          report(feedback, startOffset ? 'Resuming at ' + startOffset.toLocaleString() + ' bytes…' : 'Sending file…');
          void sendFile(channel, current.descriptor, startOffset, () => {
            if (peer !== session) throw new Error('This pickup offer was replaced.');
            return requireSource(current);
          }, (sent) => report(feedback, 'Sent ' + Math.floor(sent / current.descriptor.size * 100) + '%')).then(() => {
            if (peer !== session) return;
            fileSent = true;
            report(feedback, 'Delivered to browser. Waiting for a verified save.');
          }).catch(onFailure);
        };
        channel.onopen = () => sendCurrent(resumeOffset);
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
            updateSenderProgress(current);
            channel.send(JSON.stringify({ type: 'saved-confirmed' }));
            channel.close();
            peer = undefined;
            closeTimer = setTimeout(() => session?.close(), 1500);
          } catch (error) { onFailure(error); }
        };
        const ticket = await createLiveOffer(session, current.expiresAt, transferId);
        requireSource(current);
        if (peer !== session) return;
        offer.value = chatCode(ticket.code);
        offerField.classList.remove('hidden');
        answerField.classList.remove('hidden');
        const view = shareView;
        const hash = pickupHash(ticket.code);
        if (view && (view.origin + view.path + '/' + hash).length <= chatMessageLimit) {
          if (showLink) {
            link.value = view.origin + view.path + hash;
            linkField.classList.remove('hidden');
          }
          share.disabled = false;
          share.classList.remove('hidden');
          share.onclick = () => {
            try { requireSource(current); } catch { return; }
            share.disabled = true;
            const isCurrentOffer = () => Boolean(current.file && peer === session && offer.value);
            void sharePickup(hash).then((result) => {
              if (!isCurrentOffer()) return;
              requireSource(current);
              link.value = ownShareUrl(result.url, view, hash);
              linkField.classList.remove('hidden');
              report(feedback, result.copied ? 'Pickup link copied. Send it in private Civitai chat.' :
                result.method === 'share' ? 'Civitai opened sharing. Use private Civitai chat.' :
                  'Copy the displayed pickup link into private Civitai chat.');
            }).catch((error: unknown) => {
              if (!isCurrentOffer()) return;
              if (link.value) report(feedback, 'Copy the displayed pickup link into private Civitai chat.');
              else report(feedback, error instanceof Error ? error.message : 'Share the offer code in private Civitai chat.', true);
            }).finally(() => { if (isCurrentOffer()) share.disabled = false; });
          };
        }
        accept.disabled = accept.hidden = false;
        prepare.disabled = false;
        report(feedback, link.value ? 'Send the pickup link in private Civitai chat. Paste the reply when it arrives.' :
          'Send the offer in private Civitai chat. Paste the reply when it arrives.');
        accept.onclick = () => {
          accept.disabled = true;
          void (async () => {
            requireSource(current);
            if (peer !== session || !session) throw new Error('Create a fresh pickup offer.');
            const reply = await readLiveAnswer(ticket.offer, answer.value);
            requireSource(current);
            if (peer !== session) return;
            const point = reply.resume;
            resumeOffset = point && point.sha256 === current.descriptor.sha256 && point.offset <= current.descriptor.size &&
              (point.offset === current.descriptor.size || point.offset % chunkSize === 0) ? point.offset : 0;
            await session.setRemoteDescription({ type: 'answer', sdp: reply.sdp });
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
        if (!current.file || peer !== session) return;
        prepare.disabled = false;
        report(feedback, error instanceof Error ? error.message : 'Could not create a pickup offer.', true);
      });
    };
    current.recipients.push(invitation);
    return prepare;
  }

  start.onclick = () => {
    if (!supported || owner?.file || start.disabled) return;
    const dropoff = incomingDropoff;
    if (dropoff && !timeRemaining(dropoff.expiresAt, dropoff.elapsedDeadline)) { checkDeadlines(); return; }
    start.disabled = true;
    report(senderStatus, 'Checking the file…');
    void (async () => {
      const files = Array.from(source.files ?? []);
      const names = dropoff ? ['Requester'] : recipients.value.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
      if (!names.length || names.length > DEFAULT_ACTIVE_INVITATIONS || names.some((name) => name.length > 80) ||
        new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
        throw new Error('Enter 1 to 20 distinct recipients, one per line.');
      }
      const { file, info, archive } = await prepareLiveSource(files);
      if (dropoff && (incomingDropoff !== dropoff || !timeRemaining(dropoff.expiresAt, dropoff.elapsedDeadline))) {
        throw new Error(incomingDropoff ? dropoffExpired : 'The drop-off request closed while the file was being prepared.');
      }
      const end = action('Close handoff', 'danger');
      const receipts = action('Save all receipts');
      const receiptStatus = status();
      receipts.hidden = true;
      const expiresAt = dropoff?.expiresAt ?? Date.now() + pickupWindowMs;
      const elapsedDeadline = dropoff?.elapsedDeadline ?? performance.now() + pickupWindowMs;
      const expiryMessage = dropoff ? dropoffExpired : senderExpired;
      const current: Handoff = { file, descriptor: info, expiresAt, elapsedDeadline, expiryMessage, recipients: [], end, receipts,
        timer: setTimeout(() => endHandoff(current, expiryMessage), Math.ceil(timeRemaining(expiresAt, elapsedDeadline))) };
      owner = current;
      source.value = '';
      recipients.value = '';
      senderForm.hidden = true;
      senderPreview.replaceChildren(packagePreview(info, archive));
      senderRows.replaceChildren();
      for (const name of names) {
        const prepare = invitationRow(current, name, Boolean(dropoff));
        if (dropoff) prepare.click();
      }
      end.onclick = () => endHandoff(current, 'This handoff was closed by the sender.');
      receipts.onclick = () => {
        const verified = current.recipients.flatMap(({ label, savedAt }) => savedAt === undefined ? [] : [
          { recipientLabel: label, verifiedAt: new Date(savedAt).toISOString() },
        ]);
        if (!verified.length) return;
        saveReceiptDocument(receipts, receiptStatus, 'civitai-safe-pickup-receipts.json', {
          type: 'civitai-safe.pickup-receipts', version: 1, verification: 'saved-file-sha256', file: info, recipients: verified,
        });
      };
      senderRows.append(receipts, receiptStatus, end);
      if (dropoff) {
        setDropoff();
        clearPickupRoute();
      }
      report(senderStatus, (dropoff ? 'Drop-off ready until ' : 'Ready to share until ') + new Date(current.expiresAt).toLocaleString() + '. ' + info.name);
    })().catch((error: unknown) => {
      start.disabled = false;
      report(senderStatus, error instanceof Error ? error.message : 'Could not prepare the handoff.', true);
    });
  };

  function takeRetained() {
    const previous = retained;
    clearTimeout(retentionTimer);
    retained = undefined;
    discardPartial.hidden = true;
    return previous;
  }

  function checkRetainedDeadline() {
    if (retained && !timeRemaining(retained.expiresAt, retained.elapsedDeadline)) {
      takeRetained()?.hash.destroy();
      if (!closeGuest) report(receiverStatus, receiverExpired);
    }
  }

  discardPartial.onclick = () => {
    takeRetained()?.hash.destroy();
    report(receiverStatus, 'Partial file discarded.');
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
        checkRetainedDeadline();
        clearOfferDeadline();
        offerInput.value = '';
        clearPickupRoute();
        report(receiverStatus, receiverExpired);
        return;
      }
      checkRetainedDeadline();
      if (retained && (retained.transferId !== offer.transferId || retained.expiresAt !== offer.expiresAt)) {
        takeRetained()?.hash.destroy();
      }
      if (retained?.offerId === offer.id) throw new Error('Get a fresh offer from the sender to resume this pickup.');
      const resume = retained ? { offset: retained.offset, sha256: retained.file.sha256 } : undefined;
      const resumeDeadline = retained?.elapsedDeadline ?? Infinity;
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
      let reportedOffset = 0;
      let completed = false;
      let hash = sha256.create();
      const abort = new AbortController();
      const elapsedDeadline = Math.min(resumeDeadline,
        performance.now() + Math.min(pickupWindowMs, offer.expiresAt - Date.now()));
      let resolveSave: (() => void) | undefined;
      let cancelSave: (() => void) | undefined;
      function checkDeadline() {
        if (!closed && !timeRemaining(offer.expiresAt, elapsedDeadline)) {
          close();
          report(receiverStatus, receiverExpired);
        }
      }
      const expire = setTimeout(checkDeadline, Math.ceil(timeRemaining(offer.expiresAt, elapsedDeadline)));
      function close(keepPartial = false) {
        if (closed) return;
        closed = true;
        clearTimeout(expire);
        closeGuest = checkGuestDeadline = undefined;
        abort.abort();
        cancelSave?.();
        peer.close();
        if (keepPartial && !completed && offer.transferId && downloadedFile && bytes && offset &&
          (offset === downloadedFile.size || offset % chunkSize === 0) && timeRemaining(offer.expiresAt, elapsedDeadline)) {
          takeRetained()?.hash.destroy();
          retained = { transferId: offer.transferId, offerId: offer.id, expiresAt: offer.expiresAt, elapsedDeadline,
            file: downloadedFile, bytes, offset, hash };
          retentionTimer = setTimeout(checkRetainedDeadline, Math.ceil(timeRemaining(offer.expiresAt, elapsedDeadline)));
          discardPartial.hidden = false;
        } else {
          if (!keepPartial) takeRetained()?.hash.destroy();
          hash.destroy();
        }
        bytes = undefined;
        downloadedFile = undefined;
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
      closeGuest = () => close();
      checkGuestDeadline = checkDeadline;
      receiverForm.hidden = true;
      cancel.onclick = () => { close(); report(receiverStatus, 'Pickup canceled.'); };
      function fail(error: unknown, reconnectable = false) {
        if (closed) return;
        close(reconnectable);
        if (retained) {
          report(receiverStatus, 'Connection interrupted. ' + retained.offset.toLocaleString() +
            ' bytes retained. Open a fresh offer from the sender in this tab to resume.', true);
          return;
        }
        report(receiverStatus, error instanceof Error ? error.message : 'Pickup ended before verification.', true);
      }
      function requireOpen() {
        checkDeadline();
        if (closed) throw new Error('This pickup offer is closed.');
      }
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'failed') fail(new Error('A direct connection could not be made. Ask the sender for a fresh offer.'), true);
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
            'Connection closed before verification. Ask the sender for a fresh offer.'), !receiptPending);
        };
        channel.onerror = () => fail(new Error('The direct connection stopped. Ask the sender for a fresh offer.'), true);
        channel.onmessage = ({ data }) => {
          try {
            requireOpen();
            const packet = typeof data === 'string' ? readPacket(data) : undefined;
            if (packet?.type === 'pickup-closed') {
              if (packet.reason === 'revoked') throw new Error('The sender revoked this pickup.');
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
              const startOffset = packet.offset ?? 0;
              if (startOffset) {
                const checkpoint = retained;
                if (!resume || !checkpoint || checkpoint.transferId !== offer.transferId || startOffset !== resume.offset ||
                  startOffset !== checkpoint.offset ||
                  downloadedFile.sha256 !== checkpoint.file.sha256 || downloadedFile.name !== checkpoint.file.name ||
                  downloadedFile.size !== checkpoint.file.size) throw new Error('The resumed file does not match the partial pickup.');
                takeRetained();
                hash.destroy();
                hash = checkpoint.hash;
                offset = reportedOffset = checkpoint.offset;
                bytes = checkpoint.bytes;
                report(receiverStatus, 'Resuming at ' + offset.toLocaleString() + ' bytes…');
              } else {
                if (startOffset !== 0) throw new Error('The sender supplied an invalid resume point.');
                takeRetained()?.hash.destroy();
                bytes = new Uint8Array(downloadedFile.size);
              }
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
              if (offset - reportedOffset >= MIB) {
                reportedOffset = offset;
                report(receiverStatus, 'Received ' + Math.floor(offset / downloadedFile.size * 100) + '%');
              }
              return;
            }
            if (completed) {
              if (!receiptPending || packet?.type !== 'saved-confirmed') throw new Error('The sender sent an invalid receipt confirmation.');
              receiptConfirmed = true;
              close();
              report(receiverStatus, 'Verified save confirmed by the sender.');
              return;
            }
            if (packet?.type !== 'end' || !bytes || offset !== downloadedFile.size || bytesToHex(hash.digest()) !== downloadedFile.sha256) {
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
            output.append(packagePreview(info, previewLiveArchive(info.name, bytes.buffer)), save, verification);
            report(receiverStatus, 'Incoming file verified. Save it, then select the saved copy.');
            save.onclick = () => {
              save.disabled = true;
              void (async () => {
                requireOpen();
                if (!bytes) {
                  hash = sha256.create();
                  offset = reportedOffset = 0;
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
                if (bytes) save.textContent = 'Save file';
                report(receiverStatus, 'Civitai started the save. Select the finished file to verify it on disk.');
              })().catch((error: unknown) => {
                if (closed) return;
                if (bytes) save.textContent = 'Retry save';
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
        const answer = await createLiveAnswer(peer, offer, resume);
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
        close(Boolean(resume));
        throw error;
      }
    })().catch((error: unknown) => report(receiverStatus, error instanceof Error ? error.message : 'Could not open the pickup offer.', true))
      .finally(() => { connect.disabled = false; });
  };

  function checkDeadlines() {
    if (owner && !timeRemaining(owner.expiresAt, owner.elapsedDeadline)) endHandoff(owner, owner.expiryMessage);
    if (incomingDropoff && !timeRemaining(incomingDropoff.expiresAt, incomingDropoff.elapsedDeadline)) {
      setDropoff();
      clearPickupRoute();
      report(senderStatus, dropoffExpired, true);
    }
    if (issuedDropoff && !timeRemaining(issuedDropoff.expiresAt, issuedDropoff.elapsedDeadline)) {
      clearIssuedRequest();
      report(requestStatus, dropoffExpired);
    }
    checkGuestDeadline?.();
    checkRetainedDeadline();
    checkOfferDeadline?.();
  }
  document.addEventListener('visibilitychange', checkDeadlines);
  document.addEventListener('resume', checkDeadlines);
  window.addEventListener('focus', checkDeadlines);
  window.addEventListener('pageshow', checkDeadlines);
  window.addEventListener('pagehide', () => {
    if (owner) endHandoff(owner, 'The sender closed this tab.');
    closeGuest?.();
    takeRetained()?.hash.destroy();
    offerInput.value = '';
    clearOfferDeadline();
    setDropoff();
    clearIssuedRequest();
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
      requestButton.disabled = !shareView;
      if (!supported) {
        report(senderStatus, 'This browser does not support live pickup in the app frame.', true);
        return;
      }
      if (!owner?.file) start.disabled = false;
      connect.disabled = false;
      if ('hash' in context) loadRouteHash(context.hash);
    },
    handleSave(message: Extract<ParentToBlockMessage, { type: 'SAVE_IMAGE_RESULT' }>) {
      if (message.payload?.requestId === saveRequest?.id) {
        saveRequest?.complete(message.payload.ok ? undefined : message.payload.error || 'Civitai refused to save the file.');
      }
    },
    handleShare(message: Extract<ParentToBlockMessage, { type: 'SHARE_LINK_RESULT' }>) {
      if (message.payload?.requestId === shareRequest?.id) shareRequest?.complete(message.payload.result);
    },
    loadRouteHash,
  };
}
