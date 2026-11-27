import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { crc32 } from 'node:zlib';
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
const narrowViewport = process.env.SAFE_CIVITAI_NARROW === '1' ? { width: 390, height: 844 } : undefined;

async function launch(kind = configuredBrowser) {
  if (kind === 'firefox') return firefox.launch();
  if (kind === 'webkit') return webkit.launch();
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

async function mount(browser: Browser, site: string, block: string, script: string, path = '/', clock = false): Promise<Mounted> {
  const profile = await browser.newContext({ acceptDownloads: true, ...(narrowViewport ? { viewport: narrowViewport } : {}) });
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
  await frame.getByRole('button', { name: 'Prepare handoff' }).waitFor();
  await frame.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#live-start')?.disabled ||
    Boolean(document.querySelector('#live-sender-status')?.classList.contains('error')));
  assert.ok(await frame.getByRole('button', { name: 'Prepare handoff' }).isEnabled(), await frame.locator('#live-sender-status').textContent() ?? '');
  return { page, frame, site };
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
    if (index < 2) assert.ok(await sender.frame.getByRole('button', { name: 'Close handoff' }).isEnabled());
  }
  await sender.frame.getByText('All recipients verified their saves. This handoff is closed.').waitFor();
  if (captureScreenshots) await sender.frame.locator('#send').screenshot({ path: 'site/assets/receipts.png', animations: 'disabled' });
  for (const name of ['Guest A', 'Guest B', 'Guest C']) {
    assert.equal(await recipientRow(sender, name).getByRole('button').count(), 0);
    assert.equal(await recipientRow(sender, name).getByLabel('Pickup offer for ' + name).inputValue(), '');
  }
  const evidence = {
    browser: configuredBrowser, browserVersion: browser.version(), guestBrowser: configuredGuest, guestVersion: guestBrowser.version(),
    separateBrowserProcesses: guestBrowser !== browser, buildSha256: digest(Buffer.from(block)),
    sandbox: 'allow-scripts', opaqueSandbox, hostOrigins: [siteCom, siteRed], hostContract: 'simulated',
    ...(narrowViewport ? { viewport: narrowViewport, noHorizontalOverflow: true, keyboardPreparationAndSave: true } : {}),
    referenceBytes: reference.length, sourceAndSavedSha256: expected, verifiedSavedRecipients: 3,
    crossInvitationReplyRejected: true, wrongDiskFileRejected: true, cutoffOnLastReceipt: true,
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
  await sender.frame.getByRole('button', { name: 'Prepare handoff' }).click();
  await sender.frame.getByText(/Ready to share until .*\.zip/).waitFor();
  const invite = await prepareReply(sender, guest, 'Archive guest');
  await connect(sender, 'Archive guest', invite.reply);
  const downloading = guest.page.waitForEvent('download');
  await guest.frame.getByRole('button', { name: 'Save file', exact: true }).click();
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
    authorBundledInBrowser: true, allOriginalBytesVerifiedOnDisk: true, archiveReceipt: true,
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
  await sender.frame.getByRole('button', { name: 'Prepare handoff' }).click();
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
