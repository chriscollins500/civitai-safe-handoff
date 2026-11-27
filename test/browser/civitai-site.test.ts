import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';

const prefix = '/civitai-safe-handoff/';
const types: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };
const visiblePages = ['', 'guide/', 'limits/', 'review/', 'missing/'];
const widthChecks = [320, 390, 768, 1024, 1440];

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
  const browser = await chromium.launch({ channel: 'chrome' });
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
  assert.deepEqual(errors, []);
  assert.deepEqual(requestedOutsideSite, []);

  await page.goto(origin + prefix + 'review/');
  assert.ok(await page.getByRole('heading', { name: 'v0.4.0 candidate screenshots' }).isVisible());
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
  const proof = { browser: browser.version(), widths: widthChecks, routes: visiblePages, noThirdPartyRequests: true,
    keyboardReceiptDemo: true, noScriptFallback: true };
  console.log(JSON.stringify(proof));
});
