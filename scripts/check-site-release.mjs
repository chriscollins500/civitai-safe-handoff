import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const origins = ['https://civitai.com', 'https://civitai.red'];
const source = 'https://github.com/chriscollins500/civitai-safe-handoff';
const read = (path) => readFile(new URL(path, root));
const json = async (path) => JSON.parse(await read(path));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--write'),
  'Usage: check-site-release.mjs [--write]');

const release = await json('docs/evidence/current-release.json');
assert.equal(release.kind, 'civitai-live-deployment', 'The site needs a live deployment record.');
assert.match(release.version, /^\d+\.\d+\.\d+$/);
assert.match(release.sourceCommit, /^[a-f0-9]{40}$/);
assert.deepEqual(release.catalogOrigins, origins, 'The deployment check must cover both Civitai catalogs.');
assert.ok(origins.every((origin) => release.frameAncestors.includes(origin)),
  'The hosted page must allow both Civitai frame origins.');
assert.match(release.listingId, /^apl_[A-Za-z0-9]+$/);
assert.match(release.appBlockId, /^apb_[A-Za-z0-9]+$/);
assert.equal(release.liveUrl, 'https://civitai-safe-handoff.civit.ai/');
const checkedAt = new Date(release.checkedAt);
assert.equal(checkedAt.toISOString(), release.checkedAt, 'Use the exact UTC timestamp from the deployment check.');

const version = release.version;
const submitted = 'submission/v' + version + '/';
const [manifest, page, packaged] = await Promise.all([
  read(submitted + 'block.manifest.json'),
  read(submitted + 'index.html'),
  json('validation/evidence/civitai-only/packaged-' + version + '.json'),
]);
assert.equal(JSON.parse(manifest).version, version, 'The site evidence must name the submitted manifest version.');
assert.equal(packaged.version, version, 'The site evidence must name the packaged release.');
assert.equal(release.sourceZipSha256, packaged.sha256, 'The site ZIP digest differs from the package evidence.');
const files = new Map(packaged.files.map((entry) => [entry.path, entry]));
assert.equal(files.get('block.manifest.json')?.sha256, digest(manifest), 'The submitted manifest changed.');
assert.equal(files.get('index.html')?.sha256, digest(page), 'The submitted page changed.');
assert.equal(release.hostedPageSha256, digest(page), 'The live page digest differs from the submitted page.');
assert.equal(release.hostedPageBytes, page.length, 'The live page length differs from the submitted page.');

const date = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'long',
  timeZone: 'America/New_York',
}).format(checkedAt);
const submittedPage = source + '/blob/' + release.sourceCommit + '/' + submitted + 'index.html';
const expected = [
  '    <!-- current-release:start -->',
  '    <div class="page-intro" id="live-deployment" data-release-version="' + version + '">',
  '      <p class="eyebrow">Live deployment verified · v' + version + '</p>',
  '      <h1>Review SAFE Handoff.</h1>',
  '      <p class="lead">Both Civitai catalogs point to the same App Block. The hosted HTML matches the submitted v' + version + ' page byte for byte.</p>',
  '      <p class="body-copy">Checked <time datetime="' + release.checkedAt + '">' + date + '</time>. The deployment record covers the listing and served build. The pickup tests below use a simulated Civitai host.</p>',
  '      <div class="actions">',
  '        <a class="button primary" href="../evidence/current-release.json">Live deployment evidence</a>',
  '        <a class="button ghost" href="' + submittedPage + '">Submitted app page</a>',
  '        <a class="button ghost" href="#screenshots">Test screenshots</a>',
  '      </div>',
  '    </div>',
  '    <!-- current-release:end -->',
].join('\n');
const review = new URL('docs/review/index.html', root);
const html = (await readFile(review, 'utf8')).replaceAll('\r\n', '\n');
const blocks = [...html.matchAll(/^    <!-- current-release:start -->\n[\s\S]*?^    <!-- current-release:end -->$/gm)];
assert.equal(blocks.length, 1, 'The review kit must have one live deployment block.');
if (args[0] === '--write') {
  await writeFile(review, html.replace(blocks[0][0], () => expected));
} else {
  assert.ok(blocks[0][0] === expected,
    'The review kit release block is stale. Run npm run check:site -- --write after verifying the deployment record.');
}
console.log('Review kit deployment evidence matches the v' + version + ' submission.');
