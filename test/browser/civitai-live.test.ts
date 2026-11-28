import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { crc32, gunzipSync, gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { unzipSync } from 'fflate';
import { test } from 'node:test';
import { chromium, firefox, webkit } from 'playwright';
import type { Browser, Frame, Page } from 'playwright';
import { requireSaveCandidate } from '../../src/civitai/live-files.ts';
import { pickupWindowMs } from '../../src/civitai/live-signaling.ts';
import { MIB } from '../../src/protocol/layout.ts';
import { chromiumProcessId, sampleProcessTree } from './browser-memory.ts';
import { digestFile } from './file-digest.ts';

const siteCom = 'https://civitai.com';
const siteRed = 'https://civitai.red';
const blockOrigin = 'https://safe-live-fixture.civit.ai/';
const blockSlug = 'civitai-safe-handoff';
const runPath = '/apps/run/' + blockSlug;
const label = 'Civitai SAFE';
const name = 'synthetic-workflow.json';
const reference = Buffer.from(JSON.stringify({ nodes: [], fixture: 'safe'.repeat(32768) }));
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const expected = digest(reference);
const configuredBrowser = process.env.SAFE_CIVITAI_LIVE_BROWSER ?? 'chrome';
const configuredGuest = process.env.SAFE_CIVITAI_LIVE_GUEST_BROWSER ?? configuredBrowser;
const pairing = configuredBrowser === configuredGuest ? configuredBrowser : configuredBrowser + '-to-' + configuredGuest;
const boundary = process.env.SAFE_CIVITAI_LIVE_BOUNDARY;
const retryBoundarySave = process.env.SAFE_CIVITAI_VERIFY_SAVE_RETRY === '1';
const captureScreenshots = process.env.SAFE_CIVITAI_CAPTURE_SCREENSHOTS === '1';
const captureCandidate = process.env.SAFE_CIVITAI_CAPTURE_V040 === '1';
const narrowViewport = process.env.SAFE_CIVITAI_NARROW === '1' ? { width: 390, height: 844 } : undefined;
const resumeAtFullLimit = process.env.SAFE_CIVITAI_RESUME_BOUNDARY === '1';

async function optionalArtifact(path: string) {
  try { return await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function launch(kind = configuredBrowser) {
  if (kind === 'firefox') return firefox.launch();
  if (kind === 'webkit') return webkit.launch();
  if (kind === 'chromium') return chromium.launch();
  return chromium.launch({ channel: kind });
}

async function hostScript({ holdSave = false, refuseShare = false, legacyLocation = false, refuseFirstSave = false } = {}) {
  const result = await build({
    bundle: true, write: false, platform: 'browser', format: 'iife',
    stdin: {
      resolveDir: process.cwd(), sourcefile: 'civitai-live-host-fixture.js',
      contents: `import { inspectSaveBytes } from './src/civitai/live-files.ts';
const frame = document.querySelector('iframe');
const locationFields = () => ({ subPath: '', search: location.search, hash: location.hash });
window.addEventListener('hashchange', () => frame.contentWindow.postMessage({type: 'ROUTE_CHANGED', payload: locationFields()}, '*'));
window.saves = [];
let saveAttempts = 0;
window.addEventListener('message', async ({source, data}) => {
  if (source !== frame.contentWindow || !data) return;
  if (data.type === 'BLOCK_HELLO') {
    frame.contentWindow.postMessage({type: 'BLOCK_INIT', payload: {
      blockInstanceId: 'live-fixture', context: {slotId: 'app.page', slug: '${blockSlug}'${legacyLocation ? '' : ', ...locationFields()'}}, viewer: null
    }}, '*');
  }
  if (data.type === 'SHARE_LINK') {
    const {requestId, subPath, hash} = data.payload;
    if (subPath !== '' || typeof hash !== 'string' || hash.length > 2048 || !hash.startsWith('#')) return;
    const result = { url: location.origin + '${runPath}' + hash, method: 'none', copied: false };
    frame.contentWindow.postMessage({type: 'SHARE_LINK_RESULT', payload: {requestId,
      ${refuseShare ? "error: 'sharing is not available here'" : 'result'}
    }}, '*');
  }
  if (data.type === 'NAVIGATE' && data.payload.path === '/' && data.payload.scope === 'app' && data.payload.replace) {
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (data.type === 'SAVE_IMAGE') {
    const {requestId, filename, bytes} = data.payload;
    try {
      ${refuseFirstSave ? "if (++saveAttempts === 1) throw new Error('Browser save was refused.');" : ''}
      await inspectSaveBytes(filename, bytes);
      ${holdSave ? 'await new Promise(resolve => { window.releaseHeldSave = resolve; });' : ''}
      window.saves.push({ filename, bytes: bytes.byteLength });
      const url = URL.createObjectURL(new Blob([bytes], {type: 'application/octet-stream'}));
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.append(link);
        link.click();
        link.remove();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 15000);
      }
      frame.contentWindow.postMessage({type:'SAVE_IMAGE_RESULT', payload:{requestId, ok:true}}, '*');
    } catch (error) {
      frame.contentWindow.postMessage({type:'SAVE_IMAGE_RESULT', payload:{requestId, ok:false, error:error.message}}, '*');
    }
  }
});`,
    },
  });
  return result.outputFiles[0].text;
}

interface Mounted {
  page: Page;
  frame: Frame;
  site: string;
}

interface TransferTrace {
  received: number;
  interrupted: boolean;
  outgoing: { offset: number; bytes: number }[];
}

async function mount(browser: Browser, site: string, block: string, script: string, path = '/', clock = false,
  probe?: { interruptAfterBytes?: number }): Promise<Mounted> {
  const profile = await browser.newContext({ acceptDownloads: true, ...(narrowViewport ? { viewport: narrowViewport } : {}) });
  if (probe) {
    await profile.addInitScript(({ interruptAfterBytes }) => {
      const trace: TransferTrace = { received: 0, interrupted: false, outgoing: [] };
      Object.defineProperty(window, 'transferTrace', { value: trace });
      const Peer = window.RTCPeerConnection;
      if (typeof Peer !== 'function') return;
      window.RTCPeerConnection = class extends Peer {
        constructor(options?: RTCConfiguration) {
          super(options);
          this.addEventListener('datachannel', ({ channel }) => {
            channel.addEventListener('message', ({ data }) => {
              if (!(data instanceof ArrayBuffer)) return;
              trace.received += data.byteLength;
              if (!trace.interrupted && interruptAfterBytes && trace.received >= interruptAfterBytes) {
                trace.interrupted = true;
                channel.close();
              }
            });
          });
        }
        override createDataChannel(label: string, options?: RTCDataChannelInit) {
          const channel = super.createDataChannel(label, options);
          const originalSend = channel.send.bind(channel);
          const attempt = { offset: 0, bytes: 0 };
          trace.outgoing.push(attempt);
          channel.send = ((data: string | ArrayBuffer) => {
            if (typeof data === 'string') {
              const packet = JSON.parse(data);
              if (packet.type === 'file') attempt.offset = packet.offset ?? 0;
              originalSend(data);
            } else {
              originalSend(data);
              attempt.bytes += data.byteLength;
            }
          }) as RTCDataChannel['send'];
          return channel;
        }
      };
    }, probe);
  }
  const html = `<!doctype html><iframe title="${label}" sandbox="allow-scripts" src="${blockOrigin}" width="100%" height="2000"></iframe><script>${script}</script>`;
  await profile.route('**/*', (route) => {
    if ([site + '/', site + runPath].includes(route.request().url())) return route.fulfill({ contentType: 'text/html', body: html });
    if (route.request().url() === blockOrigin) return route.fulfill({ contentType: 'text/html', body: block });
    return route.abort();
  });
  const page = await profile.newPage();
  page.setDefaultTimeout(12000);
  if (clock) await page.clock.install();
  await page.goto(site + path);
  const frame = page.frame({ url: blockOrigin })!;
  const prepareButton = frame.getByRole('button', { name: /Prepare (handoff|drop-off)/ });
  await prepareButton.waitFor();
  await frame.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#live-start')?.disabled ||
    Boolean(document.querySelector('#live-sender-status')?.classList.contains('error')));
  assert.ok(await prepareButton.isEnabled(), await frame.locator('#live-sender-status').textContent() ?? '');
  return { page, frame, site };
}

async function transferTrace(app: Mounted) {
  return app.frame.evaluate(() => (window as unknown as { transferTrace: TransferTrace }).transferTrace);
}

async function prepare(sender: Mounted, recipients: string) {
  await sender.frame.getByLabel('Files or ZIP').setInputFiles({ name, mimeType: 'application/json', buffer: reference });
  const recipientField = sender.frame.getByLabel('Recipients', { exact: true });
  await recipientField.fill(recipients);
  const prepareButton = sender.frame.getByRole('button', { name: 'Prepare handoff' });
  if (narrowViewport) {
    await recipientField.press('Tab');
    assert.equal(await sender.frame.evaluate(() => document.activeElement?.id), 'live-start');
    await sender.page.keyboard.press('Enter');
  } else await prepareButton.click();
  try {
    await sender.frame.waitForFunction(() => {
      const output = document.querySelector('#live-sender-status');
      return Boolean(output?.classList.contains('error') || output?.textContent?.startsWith('Ready to share until'));
    });
  } catch (error) {
    throw new Error('Sender preparation status: ' + await sender.frame.locator('#live-sender-status').textContent(), { cause: error });
  }
  assert.match(await sender.frame.locator('#live-sender-status').textContent() ?? '', /^Ready to share until/);
}

function recipientRow(sender: Mounted, name: string) {
  return sender.frame.getByRole('article').filter({ has: sender.frame.getByRole('heading', { name, exact: true }) });
}

async function assertContentFits(app: Mounted) {
  const { width, scrollWidth } = await app.frame.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(width < 680 && scrollWidth <= width, `${app.site} iframe width ${width}, content width ${scrollWidth}`);
}

async function prepareReply(sender: Mounted, guest: Mounted, name: string) {
  const row = recipientRow(sender, name);
  await row.getByRole('button', { name: /Create (pickup|fresh) offer/ }).click();
  const offerField = row.getByLabel('Pickup offer for ' + name);
  await offerField.waitFor();
  const offer = await offerField.inputValue();
  assert.ok(offer.startsWith('SAFE1.') && offer.split('\n').every((part) => part.length <= 1800));
  await guest.frame.getByLabel('Pickup offer', { exact: true }).fill(offer);
  await guest.frame.getByRole('button', { name: 'Create pickup reply' }).click();
  await guest.frame.getByText('Send this reply to the sender').waitFor();
  const reply = await guest.frame.getByLabel('Your pickup reply').inputValue();
  assert.ok(reply.startsWith('SAFE1.') && reply.split('\n').every((part) => part.length <= 1800));
  return { offer, reply };
}

async function connect(sender: Mounted, name: string, reply: string) {
  const row = recipientRow(sender, name);
  await row.getByLabel('Pickup reply from ' + name).fill(reply);
  await row.getByRole('button', { name: 'Connect recipient' }).click();
}

async function verifyGuest(guest: Mounted, wrongFile = false, screenshot = false) {
  const download = guest.page.waitForEvent('download');
  const save = guest.frame.getByRole('button', { name: 'Save file', exact: true });
  if (wrongFile) await save.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  else if (narrowViewport) await save.press('Enter');
  else await save.click();
  const saved = await download;
  assert.equal(saved.suggestedFilename(), name);
  const path = await saved.path();
  const bytes = await readFile(path);
  assert.equal(bytes.length, reference.length);
  assert.equal(digest(bytes), expected);
  await guest.frame.getByText('Civitai started the save.').waitFor();
  if (screenshot) await guest.frame.locator('#pickup').screenshot({ path: 'site/assets/pickup.png', animations: 'disabled' });
  assert.equal(await guest.page.evaluate(() => (window as Window & { saves?: unknown[] }).saves?.length), 1);
  const verification = guest.frame.getByLabel('Verify saved file');
  if (wrongFile) {
    await verification.setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.alloc(reference.length, 33) });
    await guest.frame.getByText('The saved file did not match the sender’s SHA-256.').waitFor();
  }
  await verification.setInputFiles(path);
  await guest.frame.getByText('Verified save confirmed by the sender.').waitFor();
  return bytes.length;
}

async function verifyReceiptBatch(sender: Mounted, labels: string[]) {
  const download = sender.page.waitForEvent('download');
  await sender.frame.getByRole('button', { name: 'Save all receipts' }).press('Enter');
  const saved = await download;
  assert.equal(saved.suggestedFilename(), 'civitai-safe-pickup-receipts.json');
  const bytes = await readFile(await saved.path());
  const { recipients, ...receipt } = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(receipt, {
    type: 'civitai-safe.pickup-receipts', version: 1, verification: 'saved-file-sha256',
    file: { name, size: reference.byteLength, sha256: expected },
  });
  assert.deepEqual(recipients.map((item: { recipientLabel: string; verifiedAt: string }) => {
    assert.equal(item.verifiedAt, new Date(item.verifiedAt).toISOString());
    return item.recipientLabel;
  }), labels);
  return digest(bytes);
}

test('the Civitai-only app sends one file to three profiles and closes on the last verified save', { timeout: 60000 }, async (ctx) => {
  const block = await readFile('dist/civitai-app/index.html', 'utf8');
  const script = await hostScript();
  const browser = await launch();
  ctx.after(() => browser.close());
  const guestBrowser = configuredGuest === configuredBrowser ? browser : await launch(configuredGuest);
  if (guestBrowser !== browser) ctx.after(() => guestBrowser.close());
  const [sender, a, b, c] = await Promise.all([
    mount(browser, siteCom, block, script), mount(guestBrowser, siteRed, block, script),
    mount(guestBrowser, siteCom, block, script), mount(guestBrowser, siteRed, block, script),
  ]);
  const opaqueSandbox = await a.frame.evaluate(() => window.origin === 'null' && window.isSecureContext);
  assert.ok(opaqueSandbox);
  if (narrowViewport) await Promise.all([sender, a, b, c].map(assertContentFits));
  await prepare(sender, 'Guest A\nGuest B\nGuest C');
  assert.equal(await sender.frame.getByRole('button', { name: 'Save all receipts' }).count(), 0);
  if (captureScreenshots) {
    await mkdir('site/assets', { recursive: true });
    await sender.page.setViewportSize({ width: 1280, height: 1160 });
    await sender.frame.locator('#live-pickup').screenshot({ path: 'site/assets/sender.png', animations: 'disabled' });
  }
  const offers = [];
  for (const [guest, name] of [[a, 'Guest A'], [b, 'Guest B'], [c, 'Guest C']] as const) {
    offers.push(await prepareReply(sender, guest, name));
  }
  await connect(sender, 'Guest A', offers[1].reply);
  await recipientRow(sender, 'Guest A').getByText('This reply belongs to a different pickup offer.').waitFor();
  assert.equal(await a.frame.getByRole('button', { name: 'Save file', exact: true }).count(), 0);
  for (const [guest, name, index] of [[a, 'Guest A', 0], [b, 'Guest B', 1], [c, 'Guest C', 2]] as const) {
    await connect(sender, name, offers[index].reply);
    await guest.frame.getByRole('button', { name: 'Save file', exact: true }).waitFor();
    if (narrowViewport) await assertContentFits(guest);
    assert.equal(await recipientRow(sender, name).getByText(/^Verified save ·/).count(), 0);
    await verifyGuest(guest, index === 0, captureScreenshots && index === 0);
    await recipientRow(sender, name).getByText('Verified save ·').waitFor();
    if (index === 0) await verifyReceiptBatch(sender, ['Guest A']);
    if (index < 2) assert.ok(await sender.frame.getByRole('button', { name: 'Close handoff' }).isEnabled());
  }
  await sender.frame.getByText('All recipients verified their saves. This handoff is closed.').waitFor();
  const receiptBatchSha256 = await verifyReceiptBatch(sender, ['Guest A', 'Guest B', 'Guest C']);
  if (captureScreenshots) await sender.frame.locator('#send').screenshot({ path: 'site/assets/receipts.png', animations: 'disabled' });
  if (captureCandidate) await sender.frame.locator('#live-sender-summary').screenshot({
    path: 'docs/evidence/civitai-only/v0.4.0-batch-receipts.png', animations: 'disabled',
  });
  for (const name of ['Guest A', 'Guest B', 'Guest C']) {
    const row = recipientRow(sender, name);
    assert.deepEqual(await row.getByRole('button').allTextContents(), ['Save receipt']);
    assert.equal(await row.getByLabel('Pickup offer for ' + name).inputValue(), '');
  }
  const evidence = {
    browser: configuredBrowser, browserVersion: browser.version(), guestBrowser: configuredGuest, guestVersion: guestBrowser.version(),
    separateBrowserProcesses: guestBrowser !== browser, buildSha256: digest(Buffer.from(block)),
    sandbox: 'allow-scripts', opaqueSandbox, hostOrigins: [siteCom, siteRed], hostContract: 'simulated',
    ...(narrowViewport ? { viewport: narrowViewport, noHorizontalOverflow: true, keyboardPreparationAndSave: true } : {}),
    referenceBytes: reference.length, sourceAndSavedSha256: expected, verifiedSavedRecipients: 3,
    crossInvitationReplyRejected: true, wrongDiskFileRejected: true, cutoffOnLastReceipt: true,
    batchExportBeforeAndAfterClosure: true, receiptBatchSha256,
    offerCharacters: offers.map((item) => item.offer.length), replyCharacters: offers.map((item) => item.reply.length),
  };
  await mkdir('.validation', { recursive: true });
  await writeFile('.validation/civitai-live-' + pairing + (narrowViewport ? '-narrow' : '') + '.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
});

test('the Civitai-only app completes all twenty recipient slots and refuses a twenty-first', {
  skip: process.env.SAFE_CIVITAI_LIVE_CAPACITY !== '1', timeout: 150000,
}, async (ctx) => {
  const block = await readFile('dist/civitai-app/index.html', 'utf8');
  const script = await hostScript();
  const browser = await launch();
  ctx.after(() => browser.close());
  const sender = await mount(browser, siteCom, block, script);
  const names = Array.from({ length: 20 }, (_, index) => `Capacity guest ${index + 1}`);
  await sender.frame.getByLabel('Files or ZIP').setInputFiles({ name, mimeType: 'application/json', buffer: reference });
  await sender.frame.getByLabel('Recipients', { exact: true }).fill([...names, 'Overflow guest'].join('\n'));
  await sender.frame.getByRole('button', { name: 'Prepare handoff' }).click();
  await sender.frame.getByText('Enter 1 to 20 distinct recipients, one per line.').waitFor();
  assert.equal(await sender.frame.getByRole('article').count(), 0);

  await prepare(sender, names.join('\n'));
  assert.equal(await sender.frame.getByRole('article').count(), names.length);
  const offers = new Set<string>();
  for (const [index, guestName] of names.entries()) {
    const guest = await mount(browser, index % 2 ? siteCom : siteRed, block, script);
    try {
      const ticket = await prepareReply(sender, guest, guestName);
      offers.add(ticket.offer);
      await connect(sender, guestName, ticket.reply);
      await verifyGuest(guest);
      await recipientRow(sender, guestName).getByText('Verified save ·').waitFor();
      if (index < names.length - 1) assert.ok(await sender.frame.getByRole('button', { name: 'Close handoff' }).isEnabled());
    } finally {
      await guest.page.context().close();
    }
  }
  assert.equal(offers.size, names.length);
  await sender.frame.getByText('All recipients verified their saves. This handoff is closed.').waitFor();
  assert.equal(await sender.frame.getByText(/^Verified save ·/).count(), names.length);
  const evidence = { browser: configuredBrowser, browserVersion: browser.version(), buildSha256: digest(Buffer.from(block)),
    hostContract: 'simulated', hostOrigins: [siteCom, siteRed], distinctRecipientProfiles: names.length,
    verifiedSavedRecipients: names.length, distinctOffers: offers.size, twentyFirstRecipientRejected: true,
    cutoffOnLastReceipt: true, referenceBytes: reference.length, sourceAndSavedSha256: expected };
  await writeFile('.validation/civitai-live-capacity-' + configuredBrowser + '.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
});

test('revoking one pickup closes only its grant and the sender can download a verified receipt', { timeout: 45000 }, async (ctx) => {
  const block = await readFile('dist/civitai-app/index.html', 'utf8');
  const script = await hostScript();
  const browser = await launch();
  ctx.after(() => browser.close());
  const [sender, revoked, recipient] = await Promise.all([
    mount(browser, siteCom, block, script), mount(browser, siteRed, block, script), mount(browser, siteCom, block, script),
  ]);
  await prepare(sender, 'Guest A\nGuest B\nGuest C');
  const a = recipientRow(sender, 'Guest A');
  const b = recipientRow(sender, 'Guest B');
  const c = recipientRow(sender, 'Guest C');
  const active = await prepareReply(sender, revoked, 'Guest A');
  const sibling = await prepareReply(sender, recipient, 'Guest C');
  await connect(sender, 'Guest A', active.reply);
  await revoked.frame.getByRole('button', { name: 'Save file', exact: true }).waitFor();

  await a.getByRole('button', { name: 'Revoke pickup for Guest A' }).press('Enter');
  await revoked.frame.getByText('The sender revoked this pickup.').waitFor();
  assert.equal(await revoked.frame.getByRole('button', { name: 'Save file', exact: true }).count(), 0);
  assert.equal(await revoked.page.evaluate(() => (window as Window & { saves?: unknown[] }).saves?.length), 0);
  assert.equal(await a.getByLabel('Pickup offer for Guest A').inputValue(), '');
  assert.equal(await a.getByRole('button').count(), 0);
  assert.ok(await sender.frame.getByRole('button', { name: 'Close handoff' }).isEnabled());

  await b.getByRole('button', { name: 'Create pickup offer' }).press('Enter');
  await b.getByRole('button', { name: 'Revoke pickup for Guest B' }).press('Enter');
  await b.getByText('Pickup revoked.').waitFor();
  assert.equal(await c.getByRole('button', { name: 'Save receipt for Guest C' }).count(), 0);
  await connect(sender, 'Guest C', sibling.reply);
  await verifyGuest(recipient);
  await sender.frame.getByText('All remaining recipients verified their saves. This handoff is closed.').waitFor();
  assert.equal(await b.getByLabel('Pickup offer for Guest B').inputValue(), '');
  assert.equal(await b.getByRole('button').count(), 0);
  assert.equal(await sender.frame.getByRole('button', { name: 'Close handoff' }).count(), 0);
  if (captureScreenshots) {
    await sender.frame.locator('#send').screenshot({ path: 'docs/evidence/civitai-only/v0.3.0-review-receipts.png', animations: 'disabled' });
  }

  const download = sender.page.waitForEvent('download');
  await c.getByRole('button', { name: 'Save receipt for Guest C' }).press('Enter');
  const saved = await download;
  assert.equal(saved.suggestedFilename(), 'civitai-safe-pickup-receipt-3.json');
  const bytes = await readFile(await saved.path());
  const { verifiedAt, ...payload } = JSON.parse(bytes.toString('utf8'));
  assert.equal(verifiedAt, new Date(verifiedAt).toISOString());
  assert.deepEqual(payload, {
    type: 'civitai-safe.pickup-receipt', version: 1, recipientLabel: 'Guest C', verification: 'saved-file-sha256',
    file: { name, size: reference.byteLength, sha256: expected },
  });
  await c.getByText('Receipt download started.').waitFor();
  await verifyReceiptBatch(sender, ['Guest C']);

  await prepare(sender, 'Last recipient');
  await recipientRow(sender, 'Last recipient').getByRole('button', { name: 'Revoke pickup for Last recipient' }).press('Enter');
  await sender.frame.getByText('Every pickup was revoked. This handoff is closed.').waitFor();
  const proof = { browser: configuredBrowser, browserVersion: browser.version(), buildSha256: digest(Buffer.from(block)),
    hostOrigins: [siteCom, siteRed], hostContract: 'simulated', revokedActivePickupBeforeSave: true,
    revokedPickupOfferCleared: true, siblingOfferStillWorked: true, lastRequiredReceiptClosedHandoff: true,
    revokedRecipientsHadNoReceipt: true, downloadedReceiptMatchesVerifiedFile: true, finalRevocationClosedHandoff: true,
    batchExportExcludedRevokedRecipients: true,
    verifiedFileSha256: expected, receiptJsonSha256: digest(bytes) };
  await writeFile('.validation/civitai-revocation-receipts-' + configuredBrowser + '.json', JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
});

test('the sender ends an active Civitai pickup at the 24-hour deadline', { timeout: 35000 }, async (ctx) => {
  const block = await readFile('dist/civitai-app/index.html', 'utf8');
  const browser = await launch();
  ctx.after(() => browser.close());
  const script = await hostScript();
  const [sender, guest] = await Promise.all([mount(browser, siteRed, block, script), mount(browser, siteCom, block, script)]);
  await sender.page.clock.install();
  await prepare(sender, 'Guest A');
  const invite = await prepareReply(sender, guest, 'Guest A');
  await connect(sender, 'Guest A', invite.reply);
  await guest.frame.getByRole('button', { name: 'Save file', exact: true }).waitFor();
  await sender.page.clock.fastForward(pickupWindowMs);
  await sender.frame.getByText('This handoff expired after 24 hours.').waitFor();
  await guest.frame.getByText('This pickup offer expired.').waitFor();
  assert.equal(await guest.frame.getByRole('button', { name: 'Save file', exact: true }).count(), 0);
  const row = recipientRow(sender, 'Guest A');
  assert.equal(await row.getByRole('button').count(), 0);
  assert.equal(await row.getByLabel('Pickup offer for Guest A').inputValue(), '');
  assert.equal(await guest.frame.getByLabel('Your pickup reply').inputValue(), '');
  assert.equal(await guest.page.evaluate(() => (window as Window & { saves?: unknown[] }).saves?.length), 0);
  const result = {
    browser: configuredBrowser, browserVersion: browser.version(), buildSha256: digest(Buffer.from(block)),
    simulatedElapsedMilliseconds: pickupWindowMs, hostOrigins: [siteRed, siteCom],
    activeChannelClosed: true, unsavedBytesRemovedFromGuestView: true, hostSavesAfterCutoff: 0,
  };
  await writeFile('.validation/civitai-live-expiry-' + configuredBrowser + '.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
});

test('expiry clears an unclaimed offer when either tab resumes after the deadline', { timeout: 35000 }, async (ctx) => {
  const block = await readFile('dist/civitai-app/index.html', 'utf8');
  const browser = await launch();
  ctx.after(() => browser.close());
  const script = await hostScript();
  const sender = await mount(browser, siteRed, block, script);
  await sender.page.clock.install();
  const startedAt = await sender.frame.evaluate(() => Date.now());
  await prepare(sender, 'Guest A');
  const row = recipientRow(sender, 'Guest A');
  await row.getByRole('button', { name: 'Create pickup offer' }).click();
  await row.getByRole('button', { name: 'Copy pickup link' }).click();
  await row.getByText('Copy the displayed pickup link').waitFor();
  const url = new URL(await row.getByLabel('Pickup link for Guest A').inputValue());
  const guest = await mount(browser, siteRed, block, script, runPath + url.hash, true);
  await guest.frame.getByText('Pickup offer loaded.').waitFor();
  const afterExpiry = startedAt + pickupWindowMs + 10000;
  for (const tab of [sender, guest]) await tab.page.clock.setSystemTime(afterExpiry);
  assert.equal(await row.getByLabel('Pickup link for Guest A').inputValue(), url.href);
  await Promise.all([sender, guest].map((tab) => tab.frame.evaluate(() => document.dispatchEvent(new Event('resume')))));
  await sender.frame.getByText('This handoff expired after 24 hours.').waitFor();
  await guest.frame.getByText('This pickup offer expired.').waitFor();
  assert.equal(await row.getByLabel('Pickup link for Guest A').inputValue(), '');
  assert.equal(await row.getByLabel('Pickup offer for Guest A').inputValue(), '');
  assert.equal(await guest.frame.getByLabel('Pickup offer', { exact: true }).inputValue(), '');
  assert.equal(new URL(guest.page.url()).hash, '');
  assert.equal(await row.getByRole('button').count(), 0);
  const result = { browser: configuredBrowser, browserVersion: browser.version(), buildSha256: digest(Buffer.from(block)),
    resumedAfterDeadline: true, unusedOfferClearedFromBothTabs: true,
    fragmentReplacedInGuestTab: true, newPickupUnavailable: true };
  await writeFile('.validation/civitai-expiry-resume-' + configuredBrowser + '.json', JSON.stringify(result, null, 2) + '\n');
});

test('the sender bundles selected files in the app and the recipient verifies the saved ZIP', { timeout: 30000 }, async (ctx) => {
  const block = await readFile('dist/civitai-app/index.html', 'utf8');
  const browser = await launch();
  ctx.after(() => browser.close());
  const script = await hostScript();
  const [sender, guest] = await Promise.all([mount(browser, siteCom, block, script), mount(browser, siteRed, block, script)]);
  const files = [
    { name, mimeType: 'application/json', buffer: reference },
    { name: 'caption-風.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic caption\n') },
    { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
  ];
  await sender.frame.getByLabel('Files or ZIP').setInputFiles(files);
  await sender.frame.getByLabel('Recipients', { exact: true }).fill('Archive guest');
  await sender.frame.getByRole('button', { name: 'Prepare handoff' }).press('Enter');
  await sender.frame.getByText(/Ready to share until .*\.zip/).waitFor();
  const preview = sender.frame.locator('#live-sender-preview');
  await preview.getByText('3 archive entries').click();
  for (const { name } of files) await preview.getByText(name, { exact: false }).waitFor();
  const invite = await prepareReply(sender, guest, 'Archive guest');
  await connect(sender, 'Archive guest', invite.reply);
  const receivedPackage = guest.frame.locator('#live-receiver-area .live-package');
  await receivedPackage.getByText('3 archive entries').click();
  for (const { name } of files) await receivedPackage.getByText(name, { exact: false }).waitFor();
  if (captureCandidate) await receivedPackage.screenshot({
    path: 'docs/evidence/civitai-only/v0.4.0-archive-preview.png', animations: 'disabled',
  });
  const downloading = guest.page.waitForEvent('download');
  await guest.frame.getByRole('button', { name: 'Save file', exact: true }).press('Enter');
  const archive = await downloading;
  assert.equal(archive.suggestedFilename(), 'civitai-safe-handoff.zip');
  const diskPath = await archive.path();
  const bytes = await readFile(diskPath);
  const members = unzipSync(bytes);
  assert.deepEqual(Object.keys(members).sort(), files.map(({ name }) => name).sort());
  for (const member of files) assert.deepEqual(Buffer.from(members[member.name]), member.buffer);
  await guest.frame.getByText('Civitai started the save.').waitFor();
  await guest.frame.getByLabel('Verify saved file').setInputFiles(diskPath);
  await guest.frame.getByText('Verified save confirmed by the sender.').waitFor();
  await sender.frame.getByText('All recipients verified their saves. This handoff is closed.').waitFor();
  const result = {
    browser: configuredBrowser, browserVersion: browser.version(), buildSha256: digest(Buffer.from(block)),
    size: bytes.length, sha256: digest(bytes), files: files.map(({ name, buffer }) => ({ name, size: buffer.length, sha256: digest(buffer) })),
    authorBundledInBrowser: true, allOriginalBytesVerifiedOnDisk: true, archiveReceipt: true, bothPackagePreviews: true,
    hostOrigins: [siteCom, siteRed], hostContract: 'simulated',
  };
  await writeFile('.validation/civitai-live-bundle-' + configuredBrowser + '.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
});

test('an interrupted pickup can be replaced while the handoff remains active', { timeout: 45000 }, async (ctx) => {
  const block = await readFile('dist/civitai-app/index.html', 'utf8');
  const browser = await launch();
  ctx.after(() => browser.close());
  const script = await hostScript({ legacyLocation: true });
  const [sender, interrupted] = await Promise.all([mount(browser, siteCom, block, script), mount(browser, siteRed, block, script)]);
  await interrupted.frame.getByLabel('Pickup offer', { exact: true }).fill('Malformed code');
  await interrupted.frame.getByRole('button', { name: 'Create pickup reply' }).click();
  try {
    await interrupted.frame.locator('#live-receiver-status.error').waitFor();
    assert.match(await interrupted.frame.locator('#live-receiver-status').textContent() ?? '', /pickup code/i);
  } catch (error) {
    throw new Error('Malformed offer status: ' + await interrupted.frame.locator('#live-receiver-status').textContent(), { cause: error });
  }
  await prepare(sender, 'Guest A');
  const previous = await prepareReply(sender, interrupted, 'Guest A');
  await connect(sender, 'Guest A', previous.reply);
  await interrupted.frame.getByRole('button', { name: 'Save file', exact: true }).waitFor();
  await interrupted.page.close();
  assert.ok(await sender.frame.getByRole('button', { name: 'Close handoff' }).isEnabled());
  const guest = await mount(browser, siteRed, block, script);
  const fresh = await prepareReply(sender, guest, 'Guest A');
  assert.notEqual(fresh.offer, previous.offer);
  await connect(sender, 'Guest A', previous.reply);
  await recipientRow(sender, 'Guest A').getByText('This reply belongs to a different pickup offer.').waitFor();
  await connect(sender, 'Guest A', fresh.reply);
  await guest.frame.getByRole('button', { name: 'Save file', exact: true }).waitFor();
  await verifyGuest(guest);
  await sender.frame.getByText('All recipients verified their saves. This handoff is closed.').waitFor();
});

test('a fresh offer resumes the same pickup from its retained byte offset', { timeout: 240000 }, async (ctx) => {
  const root = await realpath(resolve('.validation'));
  const directory = await mkdtemp(join(root, 'civitai-live-resume-'));
  ctx.after(async () => {
    assert.equal(dirname(await realpath(directory)), root);
    await rm(directory, { recursive: true, force: true });
  });
  const size = (resumeAtFullLimit ? 256 : 8) * MIB;
  const interruptAfterBytes = (resumeAtFullLimit ? 64 : 2) * MIB;
  const path = join(directory, 'resume-fixture.zip');
  await writeBoundaryFile(path, 'zip', size);
  const referenceHash = await digestFile(path);
  const block = await readFile('dist/civitai-app/index.html', 'utf8');
  const controlArtifact = resumeAtFullLimit ? undefined : await optionalArtifact('dist/civitai-safe-handoff-0.3.0-candidate.zip');
  const control = controlArtifact && new TextDecoder().decode(unzipSync(controlArtifact)['index.html']);
  if (control) assert.equal(digest(Buffer.from(control)), 'e8eb05b5ad159ce9dc4e083273d28e0ab01f35ff509dad09cbe18175b50e146b');
  const browser = await launch();
  ctx.after(() => browser.close());
  const script = await hostScript({ refuseFirstSave: !resumeAtFullLimit });
  const results = [];
  for (const [html, canResume] of [[control, false], [block, true]] as const) {
    if (!html) continue;
    const [sender, guest] = await Promise.all([
      mount(browser, siteCom, html, script, '/', false, {}),
      mount(browser, siteRed, html, script, '/', false, { interruptAfterBytes }),
    ]);
    try {
      sender.page.setDefaultTimeout(110000);
      guest.page.setDefaultTimeout(110000);
      await sender.frame.getByLabel('Files or ZIP').setInputFiles(path);
      await sender.frame.getByLabel('Recipients', { exact: true }).fill('Resume guest');
      await sender.frame.getByRole('button', { name: 'Prepare handoff' }).press('Enter');
      await sender.frame.getByText('Ready to share until').waitFor();
      const first = await prepareReply(sender, guest, 'Resume guest');
      await connect(sender, 'Resume guest', first.reply);
      if (canResume) await guest.frame.getByText(/bytes retained\. Open a fresh offer/).waitFor();
      else await guest.frame.getByText('The sender closed the connection before verification.').waitFor();
      await recipientRow(sender, 'Resume guest').getByRole('button', { name: 'Create fresh offer' }).waitFor();
      const interrupted = await transferTrace(guest);
      assert.ok(interrupted.interrupted && interrupted.received >= interruptAfterBytes && interrupted.received < size);
      assert.equal(await guest.frame.getByRole('button', { name: 'Save file', exact: true }).count(), 0);
      if (canResume) {
        assert.ok(await guest.frame.getByRole('button', { name: 'Discard partial file' }).isVisible());
        if (captureCandidate) await guest.frame.locator('#pickup').screenshot({
          path: 'docs/evidence/civitai-only/v0.4.0-resume-prompt.png', animations: 'disabled',
        });
        await guest.frame.getByLabel('Pickup offer', { exact: true }).fill(first.offer);
        await guest.frame.getByRole('button', { name: 'Create pickup reply' }).press('Enter');
        await guest.frame.getByText('Get a fresh offer from the sender to resume this pickup.').waitFor();
      }

      const fresh = await prepareReply(sender, guest, 'Resume guest');
      assert.notEqual(fresh.offer, first.offer);
      if (canResume) {
        const encoded = fresh.reply.replace(/\s/g, '').slice('SAFE1.'.length);
        const message = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64url')).toString('utf8'));
        assert.equal(message.resume.offset, interrupted.received);
        assert.equal(message.resume.sha256, referenceHash);
        message.resume.offset += 16 * 1024;
        const changedReply = 'SAFE1.' + gzipSync(JSON.stringify(message)).toString('base64url');
        await connect(sender, 'Resume guest', changedReply);
        await recipientRow(sender, 'Resume guest').getByText('This reply belongs to a different pickup offer.').waitFor();
        assert.equal((await transferTrace(sender)).outgoing[1].bytes, 0);
      }
      const resumeStarted = performance.now();
      await connect(sender, 'Resume guest', fresh.reply);
      const save = guest.frame.getByRole('button', { name: 'Save file', exact: true });
      await save.waitFor();
      if (!resumeAtFullLimit) {
        await save.press('Enter');
        await guest.frame.getByText('Browser save was refused.').waitFor();
      }
      const downloading = guest.page.waitForEvent('download');
      const saveAction = !resumeAtFullLimit && canResume ? guest.frame.getByRole('button', { name: 'Retry save' }) : save;
      await saveAction.press('Enter');
      const disk = await (await downloading).path();
      assert.equal(await digestFile(disk), referenceHash);
      await guest.frame.getByLabel('Verify saved file').setInputFiles(disk);
      await guest.frame.getByText('Verified save confirmed by the sender.').waitFor();
      await sender.frame.getByText('All recipients verified their saves. This handoff is closed.').waitFor();

      const trace = await transferTrace(sender);
      assert.equal(trace.outgoing.length, 2);
      const second = trace.outgoing[1];
      assert.equal(second.offset, canResume ? interrupted.received : 0);
      assert.equal(second.bytes, size - second.offset);
      assert.equal(await guest.frame.getByRole('button', { name: 'Discard partial file' }).count(), 0);
      results.push({ buildSha256: digest(Buffer.from(html)), mode: canResume ? 'resume' : 'restart-control',
        interruptionReceivedBytes: interrupted.received, firstAttemptSentBytes: trace.outgoing[0].bytes,
        resumeOffsetBytes: second.offset, secondAttemptSentBytes: second.bytes,
        verifiedResumeAndSaveMs: Math.round(performance.now() - resumeStarted), verifiedSave: true,
        ...(canResume ? { changedResumeReplyRejectedBeforePayload: true } : {}) });
    } finally {
      await Promise.all([sender.page.context().close(), guest.page.context().close()]);
    }
  }
  const proof = { browser: configuredBrowser, browserVersion: browser.version(), buildSha256: digest(Buffer.from(block)),
    hostOrigins: [siteCom, siteRed], hostContract: 'simulated', bytes: size, interruptAfterBytes, sourceAndSavedSha256: referenceHash,
    sameRecipientTab: true, senderStayedOnline: true, refusedSmallSaveRetried: !resumeAtFullLimit, results };
  await writeFile('.validation/civitai-live-resume-' + configuredBrowser + '-' + (size / MIB) + 'mib.json', JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
});

test('a partial pickup loses its resume point at the original deadline', { timeout: 40000 }, async (ctx) => {
  const block = await readFile('dist/civitai-app/index.html', 'utf8');
  const browser = await launch();
  ctx.after(() => browser.close());
  const script = await hostScript();
  const [sender, guest] = await Promise.all([
    mount(browser, siteCom, block, script, '/', true),
    mount(browser, siteRed, block, script, '/', true, { interruptAfterBytes: 32 * 1024 }),
  ]);
  await prepare(sender, 'Expire guest');
  const first = await prepareReply(sender, guest, 'Expire guest');
  await connect(sender, 'Expire guest', first.reply);
  await guest.frame.getByText(/bytes retained/).waitFor();
  const replacement = await prepareReply(sender, guest, 'Expire guest');
  assert.notEqual(replacement.offer, first.offer);
  await Promise.all([sender, guest].map(({ page }) => page.clock.fastForward(pickupWindowMs + 1000)));
  await sender.frame.getByText('This handoff expired after 24 hours.').waitFor();
  await guest.frame.getByText('This pickup offer expired.').waitFor();
  assert.equal(await guest.frame.getByRole('button', { name: 'Discard partial file' }).count(), 0);
  assert.equal(await recipientRow(sender, 'Expire guest').getByRole('button').count(), 0);
  await guest.frame.getByLabel('Pickup offer', { exact: true }).fill(first.offer);
  await guest.frame.getByRole('button', { name: 'Create pickup reply' }).press('Enter');
  await guest.frame.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>('#live-offer')?.value);
  assert.equal(await guest.frame.getByLabel('Your pickup reply').count(), 0);
});

test('discarding a partial pickup or using a sibling offer starts a new copy', { timeout: 45000 }, async (ctx) => {
  const block = await readFile('dist/civitai-app/index.html', 'utf8');
  const browser = await launch();
  ctx.after(() => browser.close());
  const script = await hostScript();
  for (const mode of ['discard', 'sibling'] as const) {
    const [sender, guest] = await Promise.all([
      mount(browser, siteCom, block, script, '/', false, {}),
      mount(browser, siteRed, block, script, '/', false, { interruptAfterBytes: 32 * 1024 }),
    ]);
    try {
      await prepare(sender, mode === 'discard' ? 'Guest A' : 'Guest A\nGuest B');
      const first = await prepareReply(sender, guest, 'Guest A');
      await connect(sender, 'Guest A', first.reply);
      await guest.frame.getByText(/bytes retained/).waitFor();
      if (mode === 'discard') {
        await guest.frame.getByRole('button', { name: 'Discard partial file' }).press('Enter');
        await guest.frame.getByText('Partial file discarded.').waitFor();
      }
      const next = mode === 'discard' ? 'Guest A' : 'Guest B';
      const fresh = await prepareReply(sender, guest, next);
      await connect(sender, next, fresh.reply);
      await verifyGuest(guest);
      assert.deepEqual((await transferTrace(sender)).outgoing[1], { offset: 0, bytes: reference.length });
      if (mode === 'sibling') await recipientRow(sender, 'Guest A').getByRole('button', { name: 'Revoke pickup for Guest A' }).press('Enter');
      assert.equal(await guest.frame.getByRole('button', { name: 'Discard partial file' }).count(), 0);
    } finally {
      await Promise.all([sender.page.context().close(), guest.page.context().close()]);
    }
  }
});

test('the packaged live release interoperates with the new direct pickup protocol in both directions', { timeout: 45000 }, async (ctx) => {
  const block = await readFile('dist/civitai-app/index.html', 'utf8');
  const archive = await optionalArtifact('dist/civitai-safe-handoff-0.2.0-submission.zip');
  const live = archive ? new TextDecoder().decode(unzipSync(archive)['index.html']) : await readFile('submission/index.html', 'utf8');
  assert.equal(digest(Buffer.from(live)), '6be131c4375476476a7a99273836996ae20fe417be440e5ae36c74e043a7550a');
  const browser = await launch();
  ctx.after(() => browser.close());
  const script = await hostScript();
  for (const [source, destination] of [[live, block], [block, live]]) {
    const [sender, guest] = await Promise.all([mount(browser, siteCom, source, script), mount(browser, siteRed, destination, script)]);
    try {
      await prepare(sender, 'Legacy guest');
      const invite = await prepareReply(sender, guest, 'Legacy guest');
      await connect(sender, 'Legacy guest', invite.reply);
      await verifyGuest(guest);
    } finally {
      await Promise.all([sender.page.context().close(), guest.page.context().close()]);
    }
  }
});

test('Civitai pickup links preload one offer on both domains without opening a transfer', { timeout: 40000 }, async (ctx) => {
  const block = await readFile('dist/civitai-app/index.html', 'utf8');
  const script = await hostScript();
  const browser = await launch();
  ctx.after(() => browser.close());
  const evidence = [];
  for (const [site, initialLoad] of [[siteCom, true], [siteRed, false]] as const) {
    const sender = await mount(browser, site, block, script);
    await prepare(sender, 'Guest A');
    const row = recipientRow(sender, 'Guest A');
    await row.getByRole('button', { name: 'Create pickup offer' }).click();
    await row.getByRole('button', { name: 'Copy pickup link' }).click();
    await row.getByText('Copy the displayed pickup link into private Civitai chat.').waitFor();
    const code = await row.getByLabel('Pickup offer for Guest A').inputValue();
    const url = new URL(await row.getByLabel('Pickup link for Guest A').inputValue());
    assert.equal(url.origin, site);
    assert.equal(url.pathname, runPath);
    assert.equal(url.hash, '#pickup=' + code);
    assert.equal(url.search, '');
    assert.ok(url.href.length <= 2000);
    const guest = await mount(browser, site, block, script, initialLoad ? runPath + url.hash : runPath);
    if (!initialLoad) await guest.page.evaluate((hash) => { location.hash = hash; }, url.hash);
    await guest.frame.getByText('Pickup offer loaded. Create your reply to continue.').waitFor();
    assert.equal(await guest.frame.getByLabel('Pickup offer', { exact: true }).inputValue(), code);
    assert.equal(await guest.frame.getByLabel('Your pickup reply').count(), 0);
    await guest.frame.getByRole('button', { name: 'Create pickup reply' }).click();
    await guest.frame.getByText('Send this reply to the sender').waitFor();
    assert.equal(new URL(guest.page.url()).hash, '');
    const reply = await guest.frame.getByLabel('Your pickup reply').inputValue();
    await connect(sender, 'Guest A', reply);
    await verifyGuest(guest);
    assert.equal(await row.getByLabel('Pickup link for Guest A').inputValue(), '');
    await sender.frame.getByText('All recipients verified their saves. This handoff is closed.').waitFor();
    evidence.push({ site, loadedBy: initialLoad ? 'BLOCK_INIT' : 'ROUTE_CHANGED', linkCharacters: url.href.length,
      fragmentOnly: true, requiredExplicitReply: true, verifiedSave: true });
  }
  const result = { browser: configuredBrowser, browserVersion: browser.version(), buildSha256: digest(Buffer.from(block)), evidence };
  await writeFile('.validation/civitai-live-share-links-' + configuredBrowser + '.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
});

test('a drop-off request opens after the requester closes and prepares a verified return handoff', { timeout: 45000 }, async (ctx) => {
  const block = await readFile('dist/civitai-app/index.html', 'utf8');
  const script = await hostScript();
  const browser = await launch();
  ctx.after(() => browser.close());
  const requester = await mount(browser, siteCom, block, script);
  await requester.frame.getByRole('link', { name: 'Request a drop-off' }).click();
  const requested = ['ComfyUI workflow.json', 'Version note – 注記', 'Reference named <thumbnail>'];
  await requester.frame.getByText('Add a file checklist').click();
  await requester.frame.getByRole('textbox', { name: 'Requested files' }).fill(requested.join('\n'));
  await requester.frame.getByRole('button', { name: 'Create request link' }).click();
  const requestField = requester.frame.getByLabel('Drop-off request link');
  await requestField.waitFor();
  const request = new URL(await requestField.inputValue());
  assert.equal(request.origin, siteCom);
  assert.equal(request.pathname, runPath);
  assert.match(request.hash, /^#dropoff=/);
  assert.equal(request.search, '');
  await requester.page.context().close();
  assert.ok(requester.page.isClosed());

  const responder = await mount(browser, siteCom, block, script, runPath + request.hash);
  await responder.frame.getByRole('heading', { name: 'Drop off a file' }).waitFor();
  assert.deepEqual(await responder.frame.locator('#requested-file-list li').allTextContents(), requested);
  assert.equal(await responder.frame.locator('#requested-file-list li *').count(), 0);
  if (narrowViewport) await assertContentFits(responder);
  if (captureScreenshots) {
    await responder.frame.locator('#send').screenshot({ path: 'docs/evidence/civitai-only/v0.3.0-dropoff-checklist.png', animations: 'disabled' });
  }
  assert.equal(await responder.frame.getByLabel('Recipients', { exact: true }).isVisible(), false);
  assert.equal(await responder.frame.getByRole('article').count(), 0);
  assert.equal(await responder.frame.getByLabel('Files or ZIP').inputValue(), '');
  await responder.frame.getByLabel('Files or ZIP').setInputFiles({ name, mimeType: 'application/json', buffer: reference });
  await responder.frame.getByRole('button', { name: 'Prepare drop-off' }).press('Enter');
  const row = recipientRow(responder, 'Requester');
  const offerField = row.getByLabel('Pickup offer for Requester');
  await offerField.waitFor();
  const offer = await offerField.inputValue();
  assert.ok(offer.startsWith('SAFE1.'));
  const returnField = row.getByLabel('Pickup link for Requester');
  await returnField.waitFor();
  const returnLink = new URL(await returnField.inputValue());
  assert.equal(returnLink.origin, siteCom);
  assert.equal(returnLink.pathname, runPath);
  assert.equal(returnLink.hash, '#pickup=' + offer);
  assert.equal(new URL(responder.page.url()).hash, '');
  if (narrowViewport) await assertContentFits(responder);

  const returning = await mount(browser, siteRed, block, script, returnLink.pathname + returnLink.hash);
  await returning.frame.getByText('Pickup offer loaded. Create your reply to continue.').waitFor();
  assert.equal(await returning.frame.getByLabel('Pickup offer', { exact: true }).inputValue(), offer);
  await returning.frame.getByRole('button', { name: 'Create pickup reply' }).click();
  await returning.frame.getByText('Send this reply to the sender').waitFor();
  await connect(responder, 'Requester', await returning.frame.getByLabel('Your pickup reply').inputValue());
  await verifyGuest(returning);
  await responder.frame.getByText('All recipients verified their saves. This handoff is closed.').waitFor();
  assert.equal(await returnField.inputValue(), '');
  const proof = { browser: configuredBrowser, browserVersion: browser.version(), buildSha256: digest(Buffer.from(block)),
    requestOrigin: siteCom, pickupOrigin: siteRed, requesterClosedBeforeLinkOpened: true, requestLinkCharacters: request.href.length,
    checklistItems: requested.length, renderedChecklistAsText: true,
    requiredExplicitFileSelection: true, automaticallyPreparedReturnLink: true, returnLinkCharacters: returnLink.href.length,
    keyboardPrepared: true, viewport: narrowViewport ?? 'desktop', returnedOnLivePeer: true,
    sourceAndSavedSha256: expected, verifiedSave: true, closedAfterReceipt: true, hostContract: 'simulated' };
  await writeFile('.validation/civitai-dropoff-' + configuredBrowser + '.json', JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
});

test('a drop-off request expires without enabling an upload, including when link sharing is refused', { timeout: 35000 }, async (ctx) => {
  const block = await readFile('dist/civitai-app/index.html', 'utf8');
  const script = await hostScript({ refuseShare: true });
  const browser = await launch();
  ctx.after(() => browser.close());
  const requester = await mount(browser, siteRed, block, script, runPath, true);
  await requester.frame.getByRole('button', { name: 'Create request link' }).click();
  const field = requester.frame.getByLabel('Drop-off request link');
  await field.waitFor();
  const url = new URL(await field.inputValue());
  assert.equal(url.origin, siteRed);
  const guest = await mount(browser, siteRed, block, script, runPath + url.hash, true);
  const preparing = await mount(browser, siteRed, block, script, runPath + url.hash, true);
  const hour = 3_600_000;
  await preparing.page.clock.fastForward(pickupWindowMs - hour);
  await preparing.frame.getByLabel('Files or ZIP').setInputFiles({ name, mimeType: 'application/json', buffer: reference });
  await preparing.frame.getByRole('button', { name: 'Prepare drop-off' }).click();
  const row = recipientRow(preparing, 'Requester');
  const lateLink = row.getByLabel('Pickup link for Requester');
  await lateLink.waitFor();
  const returnUrl = new URL(await lateLink.inputValue());
  assert.equal(returnUrl.origin, siteRed);
  await preparing.page.clock.fastForward(hour + 2000);
  await preparing.frame.getByText('This drop-off request expired.').waitFor();
  assert.equal(await lateLink.inputValue(), '');
  assert.equal(await row.getByRole('button', { name: 'Connect recipient' }).isVisible(), false);
  await guest.frame.getByRole('heading', { name: 'Drop off a file' }).waitFor();
  await guest.frame.getByLabel('Files or ZIP').setInputFiles({ name, mimeType: 'application/json', buffer: reference });
  await Promise.all([requester, guest].map((tab) => tab.page.clock.fastForward(pickupWindowMs + 2000)));
  for (const tab of [requester, guest]) await tab.frame.getByText('This drop-off request expired.').waitFor();
  assert.equal(await field.inputValue(), '');
  assert.equal(await guest.frame.getByRole('button', { name: 'Prepare drop-off' }).count(), 0);
  assert.equal(await guest.frame.getByRole('article').count(), 0);
  assert.equal(await guest.frame.getByLabel('Files or ZIP').inputValue(), '');
  assert.equal(new URL(guest.page.url()).hash, '');
  await guest.page.goto(url.href);
  await guest.frame.getByText('This drop-off request expired.').waitFor();
  assert.equal(await guest.frame.getByRole('button', { name: 'Prepare drop-off' }).count(), 0);
  await guest.page.goto(returnUrl.href);
  await guest.frame.getByText('This pickup offer expired.').waitFor();
  const proof = { browser: configuredBrowser, browserVersion: browser.version(), buildSha256: digest(Buffer.from(block)),
    requestOrigin: siteRed, hostShareRefused: true, canonicalRequestLinkWorked: true, originalDeadlineMs: pickupWindowMs,
    preparedOneHourBeforeOriginalDeadline: true, preparedReturnGrantCleared: true, expiredFileSelectionCleared: true,
    expiredRequestAndOfferReplayRefused: true,
    hostContract: 'simulated' };
  await writeFile('.validation/civitai-dropoff-expiry-' + configuredBrowser + '.json', JSON.stringify(proof, null, 2) + '\n');
});

test('a Civitai host that refuses sharing leaves the private pickup code usable', { timeout: 25000 }, async (ctx) => {
  const block = await readFile('dist/civitai-app/index.html', 'utf8');
  const script = await hostScript({ refuseShare: true });
  const browser = await launch();
  ctx.after(() => browser.close());
  const sender = await mount(browser, siteCom, block, script);
  await prepare(sender, 'Guest A');
  const row = recipientRow(sender, 'Guest A');
  await row.getByRole('button', { name: 'Create pickup offer' }).click();
  await row.getByRole('button', { name: 'Copy pickup link' }).click();
  await row.getByText('Share the pickup offer code in private Civitai chat.').waitFor();
  assert.ok((await row.getByLabel('Pickup offer for Guest A').inputValue()).startsWith('SAFE1.'));
  assert.equal(await row.getByLabel('Pickup link for Guest A').inputValue(), '');
});

test('a source file changed after fingerprinting cannot earn a pickup receipt', { timeout: 35000 }, async (ctx) => {
  const block = await readFile('dist/civitai-app/index.html', 'utf8');
  const script = await hostScript();
  const root = await realpath(resolve('.validation'));
  const directory = await mkdtemp(join(root, 'civitai-live-edited-source-'));
  ctx.after(async () => {
    assert.equal(dirname(await realpath(directory)), root);
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, name);
  await writeFile(path, reference);
  const browser = await launch();
  ctx.after(() => browser.close());
  const [sender, guest] = await Promise.all([mount(browser, siteCom, block, script), mount(browser, siteRed, block, script)]);
  await sender.frame.getByLabel('Files or ZIP').setInputFiles(path);
  await sender.frame.getByLabel('Recipients', { exact: true }).fill('Guest A');
  await sender.frame.getByRole('button', { name: 'Prepare handoff' }).click();
  await sender.frame.getByText('Ready to share until').waitFor();
  const replacement = Buffer.from(reference);
  replacement[replacement.length - 8] = 120;
  await writeFile(path, replacement);
  assert.notEqual(await digestFile(path), expected);
  const invite = await prepareReply(sender, guest, 'Guest A');
  await connect(sender, 'Guest A', invite.reply);
  try {
    await guest.frame.getByText(/The direct connection stopped\.|The sender closed the connection before verification\.|The received file did not match the sender’s SHA-256\./).waitFor();
  } catch (error) {
    const status = await recipientRow(sender, 'Guest A').locator('.status').textContent();
    const guestStatus = await guest.frame.locator('#live-receiver-status').textContent();
    throw new Error('Changed source status: ' + status + ' / ' + guestStatus, { cause: error });
  }
  assert.equal(await guest.frame.getByRole('button', { name: 'Save file', exact: true }).count(), 0);
  assert.equal(await recipientRow(sender, 'Guest A').getByText(/^Verified save ·/).count(), 0);
});

test('a save authorized before expiry can finish without opening a new pickup', { timeout: 35000 }, async (ctx) => {
  const block = await readFile('dist/civitai-app/index.html', 'utf8');
  const script = await hostScript({ holdSave: true });
  const browser = await launch();
  ctx.after(() => browser.close());
  const [sender, guest] = await Promise.all([mount(browser, siteCom, block, script), mount(browser, siteRed, block, script)]);
  await sender.page.clock.install();
  await prepare(sender, 'Guest A');
  const invite = await prepareReply(sender, guest, 'Guest A');
  await connect(sender, 'Guest A', invite.reply);
  await guest.frame.getByRole('button', { name: 'Save file', exact: true }).click();
  type HeldSave = Window & { releaseHeldSave?: () => void };
  await guest.page.waitForFunction(() => typeof (window as HeldSave).releaseHeldSave === 'function');
  await sender.page.clock.fastForward(pickupWindowMs);
  await sender.frame.getByText('This handoff expired after 24 hours.').waitFor();
  await guest.frame.getByText('This pickup offer expired.').waitFor();
  const downloading = guest.page.waitForEvent('download');
  await guest.page.evaluate(() => (window as HeldSave).releaseHeldSave?.());
  const saved = await downloading;
  assert.equal(await digestFile(await saved.path()), expected);
  assert.equal(await guest.frame.getByRole('button', { name: 'Save file', exact: true }).count(), 0);
  assert.equal(await recipientRow(sender, 'Guest A').getByRole('button').count(), 0);
  assert.equal(await recipientRow(sender, 'Guest A').getByText(/^Verified save ·/).count(), 0);
});

async function writeBoundaryFile(path: string, kind: string, size: number) {
  const chunk = Buffer.alloc(MIB, kind === 'glb' ? 0 : 'x');
  const file = await open(path, 'wx');
  async function fill(bytes: number) {
    for (let left = bytes; left > 0; left -= chunk.length) await file.writeFile(chunk.subarray(0, Math.min(left, chunk.length)));
  }
  try {
    if (kind === 'text') {
      await fill(size);
    } else if (kind === 'glb') {
      const json = Buffer.from('{"asset":{"version":"2.0"}}');
      const jsonBytes = Math.ceil(json.length / 4) * 4;
      const header = Buffer.alloc(28 + jsonBytes);
      header.write('glTF', 0);
      header.writeUInt32LE(2, 4);
      header.writeUInt32LE(size, 8);
      header.writeUInt32LE(jsonBytes, 12);
      header.write('JSON', 16);
      header.fill(32, 20, 20 + jsonBytes);
      json.copy(header, 20);
      header.writeUInt32LE(size - header.length, 20 + jsonBytes);
      header.write('BIN\u0000', 24 + jsonBytes);
      await file.writeFile(header);
      await fill(size - header.length);
    } else {
      const entry = Buffer.from('synthetic-caption.txt');
      const local = Buffer.alloc(30 + entry.length);
      const central = Buffer.alloc(46 + entry.length);
      const footer = Buffer.alloc(22);
      const sourceBytes = size - local.length - central.length - footer.length;
      let checksum = 0;
      for (let left = sourceBytes; left > 0; left -= chunk.length) checksum = crc32(chunk.subarray(0, Math.min(left, chunk.length)), checksum);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(33, 12);
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(sourceBytes, 18);
      local.writeUInt32LE(sourceBytes, 22);
      local.writeUInt16LE(entry.length, 26);
      entry.copy(local, 30);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(33, 14);
      central.writeUInt32LE(checksum, 16);
      central.writeUInt32LE(sourceBytes, 20);
      central.writeUInt32LE(sourceBytes, 24);
      central.writeUInt16LE(entry.length, 28);
      entry.copy(central, 46);
      footer.writeUInt32LE(0x06054b50, 0);
      footer.writeUInt16LE(1, 8);
      footer.writeUInt16LE(1, 10);
      footer.writeUInt32LE(central.length, 12);
      footer.writeUInt32LE(local.length + sourceBytes, 16);
      await file.writeFile(local);
      await fill(sourceBytes);
      await file.writeFile(central);
      await file.writeFile(footer);
    }
  } finally { await file.close(); }
  assert.equal((await stat(path)).size, size);
}

test('a valid file at the app save size boundary survives a real direct pickup', {
  skip: !boundary, timeout: 240000,
}, async (ctx) => {
  assert.ok(boundary === 'zip' || boundary === 'glb' || boundary === 'text');
  const size = MIB * (boundary === 'zip' ? 256 : boundary === 'glb' ? 100 : 50);
  const name = 'app-box-boundary.' + (boundary === 'text' ? 'txt' : boundary);
  assert.throws(() => requireSaveCandidate(name, size + 1), /This file must be between/);
  const root = await realpath(resolve('.validation'));
  const directory = await mkdtemp(join(root, 'civitai-live-boundary-'));
  ctx.after(async () => {
    assert.equal(dirname(await realpath(directory)), root);
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, name);
  await writeBoundaryFile(path, boundary, size);
  const referenceHash = await digestFile(path);
  const block = await readFile('dist/civitai-app/index.html', 'utf8');
  const script = await hostScript({ refuseFirstSave: retryBoundarySave });
  const browser = await launch();
  ctx.after(() => browser.close());
  const guestBrowser = await launch(configuredGuest);
  ctx.after(() => guestBrowser.close());
  const [sender, guest] = await Promise.all([mount(browser, siteCom, block, script), mount(guestBrowser, siteRed, block, script)]);
  sender.page.setDefaultTimeout(110000);
  guest.page.setDefaultTimeout(110000);
  const measureMemory = process.platform === 'win32' && process.env.SAFE_CIVITAI_LIVE_MEMORY === '1' &&
    ['chrome', 'msedge'].includes(configuredBrowser) && ['chrome', 'msedge'].includes(configuredGuest);
  const processIds = measureMemory ? await Promise.all([chromiumProcessId(browser), chromiumProcessId(guestBrowser)]) : [];
  const memory: { stage: string; senderPrivateBytes: number; guestPrivateBytes: number }[] = [];
  async function sample(stage: string) {
    const [senderId, guestId] = processIds;
    if (!senderId || !guestId) return;
    const [sending, receiving] = await Promise.all([sampleProcessTree(senderId), sampleProcessTree(guestId)]);
    memory.push({ stage, senderPrivateBytes: sending.privateBytes, guestPrivateBytes: receiving.privateBytes });
  }
  await sample('before-selecting-file');
  await sender.frame.getByLabel('Files or ZIP').setInputFiles(path);
  await sender.frame.getByLabel('Recipients', { exact: true }).fill('Boundary recipient');
  await sender.frame.getByRole('button', { name: 'Prepare handoff' }).press('Enter');
  await sender.frame.getByText('Ready to share until').waitFor();
  const negotiation = await prepareReply(sender, guest, 'Boundary recipient');
  const started = performance.now();
  await connect(sender, 'Boundary recipient', negotiation.reply);
  const save = guest.frame.getByRole('button', { name: 'Save file', exact: true });
  await save.waitFor();
  const receivedMs = Math.round(performance.now() - started);
  await sample('received-before-save');
  if (retryBoundarySave) {
    assert.ok(size >= 64 * MIB);
    await save.click();
    await guest.frame.getByText('Browser save was refused.').waitFor();
    assert.equal(await recipientRow(sender, 'Boundary recipient').getByText(/^Verified save ·/).count(), 0);
    await guest.frame.getByRole('button', { name: 'Get a fresh copy' }).click();
    await save.waitFor();
  }
  const downloading = guest.page.waitForEvent('download');
  await save.click();
  const download = await downloading;
  assert.equal(download.suggestedFilename(), name);
  const output = await download.path();
  assert.equal((await stat(output)).size, size);
  assert.equal(await digestFile(output), referenceHash);
  const diskVerifiedMs = Math.round(performance.now() - started);
  await sample('saved-before-guest-verification');
  await guest.frame.getByText('Civitai started the save.').waitFor();
  await guest.frame.getByLabel('Verify saved file').setInputFiles(output);
  await guest.frame.getByText('Verified save confirmed by the sender.').waitFor();
  await sender.frame.getByText('All recipients verified their saves. This handoff is closed.').waitFor();
  const receiptMs = Math.round(performance.now() - started);
  await sample('after-receipt');
  const result = {
    kind: boundary, size, browser: configuredBrowser, browserVersion: browser.version(), buildSha256: digest(Buffer.from(block)),
    guestBrowser: configuredGuest, guestVersion: guestBrowser.version(), separateBrowserProcesses: true,
    referenceAndSavedSha256: referenceHash, receivedMs, diskVerifiedMs, receiptMs, ...(memory.length ? { memory } : {}),
    nativeAppFrame: 'simulated allow-scripts sandbox', hostValidator: '@civitai/app-sdk@0.93.0', oneByteOverRejectedBeforeSend: true,
    verifiedSave: true, closedAfterReceipt: true,
  };
  const measured = { ...result, saveBridge: size >= 64 * MIB ? 'transfer list' : 'structured clone',
    ...(retryBoundarySave ? { refusedFirstSave: true, resentOnSameConnection: true } : {}) };
  const suffix = retryBoundarySave ? '-retry' : '';
  await writeFile('.validation/civitai-native-boundary-' + boundary + suffix + '.json', JSON.stringify(measured, null, 2) + '\n');
  console.log(JSON.stringify(measured));
});
