import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';

const root = new URL('../', import.meta.url);
const origins = ['https://civitai.com', 'https://civitai.red'];
const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== '--staged')) throw new Error('Usage: verify-civitai-live.mjs [--staged]');
const staged = args[0] === '--staged';
const evidenceDir = staged ? 'validation/evidence/civitai-only/' : 'docs/evidence/civitai-only/';
const proof = JSON.parse(await readFile(new URL(evidenceDir + 'candidate-package-proof.json', root), 'utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function reviewEntries() {
  const names = ['block.manifest.json', 'index.html'];
  if (staged) return Promise.all(names.map((name) => readFile(new URL('submission/' + name, root))));
  const archive = await readFile(new URL(proof.archive, root));
  if (digest(archive) !== proof.sha256) throw new Error('The retained review ZIP does not match its SHA-256.');
  const files = unzipSync(archive);
  return names.map((name) => files[name]);
}

const [manifestBytes, pageBytes] = await reviewEntries();
if (digest(manifestBytes) !== proof.entries['block.manifest.json'].sha256 ||
  digest(pageBytes) !== proof.entries['index.html'].sha256) {
  throw new Error('The reviewed manifest or page does not match its SHA-256.');
}
const manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8'));
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.blockId)) throw new Error('The reviewed manifest has an invalid Civitai slug.');
const assetOrigin = `https://${manifest.blockId}.civit.ai`;

function get(url) {
  return fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
}

const catalogs = await Promise.all(origins.map(async (origin) => {
  const response = await get(`${origin}/api/v1/apps/${manifest.blockId}`);
  return { origin, status: response.status, listing: response.ok ? await response.json() : null };
}));

if (catalogs.some(({ status }) => status === 404) && catalogs.every(({ status }) => status === 200 || status === 404)) {
  console.error(`Public catalog publication is incomplete for version ${manifest.version}. ${
    catalogs.map(({ origin, status }) => `${origin} returned ${status}`).join('. ')}.`);
  process.exitCode = 2;
} else {
  for (const { origin, status, listing } of catalogs) {
    if (status !== 200) throw new Error(`${origin} catalog returned HTTP ${status}.`);
    if (listing.slug !== manifest.blockId || listing.kind !== 'onsite' || !listing.id || !listing.kindData?.appBlockId ||
      listing.kindData.hasPage !== true || new URL(listing.kindData.liveUrl).href !== assetOrigin + '/') {
      throw new Error(`${origin} did not list the expected native App Block and hosted page.`);
    }
    if (!Array.isArray(listing.scopes) || listing.scopes.length || listing.sourceRepoUrl !== manifest.repository ||
      !listing.iconUrl || !listing.coverUrl || !Array.isArray(listing.screenshots) || listing.screenshots.length < 3) {
      throw new Error(`${origin} listing did not match the review scope, source link, and media.`);
    }
  }
  const [first, second] = catalogs.map(({ listing }) => listing);
  if (first.id !== second.id || first.kindData.appBlockId !== second.kindData.appBlockId) {
    throw new Error('The two Civitai catalogs did not report the same listing and App Block identifiers.');
  }

  const page = await get(assetOrigin + '/');
  if (!page.ok || !page.headers.get('content-type')?.includes('text/html')) {
    throw new Error(`The hosted app did not return HTML (HTTP ${page.status}).`);
  }
  const frameAncestors = page.headers.get('content-security-policy')?.split(';')
    .map((rule) => rule.trim().split(/\s+/)).find(([directive]) => directive === 'frame-ancestors');
  if (!origins.every((origin) => frameAncestors?.includes(origin))) {
    throw new Error('The hosted iframe policy did not explicitly allow both Civitai origins.');
  }
  const bytes = new Uint8Array(await page.arrayBuffer());
  const sha256 = digest(bytes);
  if (sha256 !== digest(pageBytes)) throw new Error(`Hosted page SHA-256 differs from the reviewed page: ${sha256}`);

  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), version: manifest.version,
    ...(staged ? { comparisonSource: 'checked-in submission', recordedReviewZipSha256: proof.sha256 } : { sourceZipSha256: proof.sha256 }),
    hostedPageSha256: sha256, hostedPageBytes: bytes.length, liveUrl: assetOrigin + '/', listingId: first.id,
    appBlockId: first.kindData.appBlockId, catalogOrigins: origins, frameAncestors, screenshots: first.screenshots.length,
  }, null, 2));
}
