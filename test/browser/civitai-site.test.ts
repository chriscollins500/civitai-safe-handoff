import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { chromium, type Page } from 'playwright';

const prefix = '/civitai-safe-handoff/';
const types: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png',
  '.webp': 'image/webp', '.json': 'application/json',
};
const visiblePages = ['', 'guide/', 'limits/', 'review/', 'missing/'];
const widthChecks = [320, 390, 768, 1024, 1440];

async function tabTo(page: Page, label: string) {
  for (let steps = 0; steps <= 24; steps++) {
    if (await page.evaluate(() => document.activeElement?.textContent?.trim()) === label) return steps;
    if (steps < 24) await page.keyboard.press('Tab');
  }
  assert.fail('Keyboard focus did not reach ' + label);
}

test('SAFE Handoff documentation works from the GitHub Pages project path', { timeout: 90000 }, async (ctx) => {
  const site = resolve(process.env.SAFE_SITE_ROOT ?? (existsSync('site/index.html') ? 'site' : 'docs'));
  const server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://localhost');
    try {
      if (!pathname.startsWith(prefix)) throw new Error('Outside project path');
      const file = resolve(site, decodeURIComponent(pathname.slice(prefix.length)) + (pathname.endsWith('/') ? 'index.html' : ''));
      if (!file.startsWith(site + sep) || !(await stat(file)).isFile()) throw new Error('Outside site');
      response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
      response.end(await readFile(file));
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/html' });
      response.end(await readFile(resolve(site, '404.html')));
    }
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  ctx.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch(process.env.SAFE_SITE_MANAGED_BROWSER === '1' ? {} : { channel: 'chrome' });
  ctx.after(() => browser.close());
  const page = await browser.newPage();
  const errors: string[] = [];
  const requestedOutsideSite: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith(origin + prefix)) requestedOutsideSite.push(request.url());
  });
  for (const width of widthChecks) {
    await page.setViewportSize({ width, height: 820 });
    for (const route of visiblePages) {
      const pageResponse = await page.goto(origin + prefix + route);
      assert.equal(pageResponse?.status(), route === 'missing/' ? 404 : 200);
      assert.equal(await page.getByRole('main').getByRole('heading', { level: 1 }).count(), 1);
      await page.locator('img').evaluateAll((images) => {
        for (const image of images as HTMLImageElement[]) image.loading = 'eager';
      });
      await page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${route} overflows at ${width}px`);
      if (process.env.SAFE_SITE_CAPTURE === '1' && [390, 1440].includes(width)) {
        await mkdir('.validation/site-preview', { recursive: true });
        await page.screenshot({ path: `.validation/site-preview/${route.replace('/', '') || 'home'}-${width}.png`, fullPage: true });
      }
    }
  }
  const keyboardJourneys = [];
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 820 });
    await page.goto(origin + prefix);
    const hero = page.locator('.hero-art img');
    assert.match(await hero.evaluate((image) => (image as HTMLImageElement).currentSrc), /\/assets\/cover\.webp$/);
    assert.equal(await hero.getAttribute('src'), 'assets/cover.png');
    const appLinks = page.getByRole('navigation', { name: 'Open SAFE Handoff' });
    assert.equal(await appLinks.getByRole('link', { name: 'Open on Civitai.com' }).getAttribute('href'),
      'https://civitai.com/apps/run/civitai-safe-handoff');
    assert.equal(await appLinks.getByRole('link', { name: 'Open on Civitai.red' }).getAttribute('href'),
      'https://civitai.red/apps/run/civitai-safe-handoff');
    assert.ok(await page.getByText('Access to Civitai Apps depends on your account during beta.', { exact: false }).isVisible());
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Skip to content');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'main');
    const launchSteps = await tabTo(page, 'Open on Civitai.com');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Open on Civitai.red');

    await tabTo(page, 'Learn the handoff');
    await page.keyboard.press('Enter');
    await page.waitForURL(origin + prefix + 'guide/');
    await tabTo(page, 'Pick up');
    await page.keyboard.press('Enter');
    assert.equal(page.url(), origin + prefix + 'guide/#recipient');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'recipient');
    assert.deepEqual(await page.locator('.pickup-states dt').allTextContents(),
      ['Save file', 'Civitai started the save.', 'Verified save']);

    await tabTo(page, 'Review kit');
    await page.keyboard.press('Enter');
    await page.waitForURL(origin + prefix + 'review/');
    assert.ok(await page.getByText('a simulated Civitai host', { exact: false }).first().isVisible());
    const releaseVersion = await page.locator('#live-deployment').getAttribute('data-release-version');
    assert.match(releaseVersion ?? '', /^\d+\.\d+\.\d+$/);
    const evidenceSteps = await tabTo(page, 'Live deployment evidence');
    const recordUrl = origin + prefix + 'evidence/current-release.json';
    const pending = page.waitForResponse((response) => response.url() === recordUrl);
    await page.keyboard.press('Enter');
    const record = await pending;
    assert.equal(record.status(), 200);
    const receipt = await record.json();
    assert.equal(receipt.version, releaseVersion);
    assert.equal(receipt.kind, 'civitai-live-deployment');
    assert.deepEqual(receipt.catalogOrigins, ['https://civitai.com', 'https://civitai.red']);

    await page.goto(origin + prefix + 'review/#screenshots');
    const archive = page.locator('.earlier-screenshots');
    assert.equal(await archive.getAttribute('open'), null);
    await tabTo(page, 'Earlier v0.2.0 browser test screenshots');
    await page.keyboard.press('Enter');
    assert.notEqual(await archive.getAttribute('open'), null);
    keyboardJourneys.push({ width, launchSteps, evidenceSteps });
  }

  await page.goto(origin + prefix + 'review/');
  assert.ok(await page.getByRole('heading', { name: 'Browser test screenshots' }).isVisible());
  const candidateImages = await page.locator('#v040 img').evaluateAll((images) => images.map((image) => image.getAttribute('src')));
  assert.deepEqual(candidateImages, [
    '../assets/v0.4.0/v0.4.0-archive-preview.png',
    '../assets/v0.4.0/v0.4.0-resume-prompt.png',
    '../assets/v0.4.0/v0.4.0-batch-receipts.png',
  ]);

  await page.goto(origin + prefix);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Skip to content');
  const demo = page.locator('#receipt-demo');
  const verify = demo.getByRole('button', { name: 'Verify next save' });
  await verify.focus();
  for (let count = 1; count <= 3; count++) {
    await page.keyboard.press('Enter');
    assert.equal(await demo.getByText('Verified save', { exact: true }).count(), count);
  }
  assert.ok(await verify.isDisabled());
  assert.match(await demo.getByRole('status').textContent() ?? '', /^Closed\./);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Reset');
  await page.keyboard.press('Enter');
  assert.equal(await demo.getByText('Waiting', { exact: true }).count(), 3);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Verify next save');

  const noScript = await browser.newPage({ javaScriptEnabled: false });
  await noScript.goto(origin + prefix);
  assert.ok(await noScript.getByText('When all three recipients verify', { exact: false }).isVisible());
  assert.equal(await noScript.getByRole('button', { name: 'Verify next save' }).count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(requestedOutsideSite, []);
  const proof = { browser: browser.version(), widths: widthChecks, routes: visiblePages, noThirdPartyRequests: true,
    keyboardReceiptDemo: true, noScriptFallback: true, keyboardJourneys };
  console.log(JSON.stringify(proof));
});
