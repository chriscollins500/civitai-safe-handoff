import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { unzipSync } from 'fflate';

const root = new URL('../', import.meta.url);
const origins = ['https://civitai.com', 'https://civitai.red'];
const { values } = parseArgs({ options: {
  current: { type: 'boolean' },
  staged: { type: 'boolean' },
  version: { type: 'string' },
} });
if (values.current && (values.staged || values.version)) {
  throw new Error('Use --current alone to check the review kit record against the live catalogs.');
}
const current = values.current
  ? JSON.parse(await readFile(new URL('docs/evidence/current-release.json', root), 'utf8'))
  : undefined;
const staged = values.staged || Boolean(current);
const version = current?.version ?? values.version ?? '0.2.0';
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a numeric Civitai version such as 0.4.0.');
if (current && !/^[a-f0-9]{40}$/.test(current.sourceCommit)) throw new Error('The review kit must pin a full source commit.');
const evidenceDir = 'validation/evidence/civitai-only/';
const baseline = JSON.parse(await readFile(new URL(evidenceDir + 'candidate-package-proof.json', root), 'utf8'));
let proof = baseline;
let submissionDir = 'submission/';
if (version !== '0.2.0') {
  const packaged = JSON.parse(await readFile(new URL(evidenceDir + 'packaged-' + version + '.json', root), 'utf8'));
  if (packaged.version !== version || typeof packaged.artifact !== 'string' || !/^[a-z0-9._-]+\.zip$/.test(packaged.artifact)) {
    throw new Error('The package evidence does not identify the requested Civitai release.');
  }
  proof = { archive: 'dist/' + packaged.artifact, sha256: packaged.sha256,
    entries: Object.fromEntries(packaged.files.map((entry) => [entry.path, entry])) };
  submissionDir += 'v' + version + '/';
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function reviewEntries() {
  const names = ['block.manifest.json', 'index.html'];
  if (staged) return Promise.all(names.map((name) => readFile(new URL(submissionDir + name, root))));
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
if (manifest.version !== version) throw new Error('The reviewed manifest version differs from the requested version.');
const assetOrigin = `https://${manifest.blockId}.civit.ai`;

function get(url) {
  return fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
}

async function verifyPinnedSubmission() {
  const source = 'https://raw.githubusercontent.com/chriscollins500/civitai-safe-handoff/';
  const path = source + current.sourceCommit + '/' + submissionDir;
  await Promise.all([['block.manifest.json', manifestBytes], ['index.html', pageBytes]].map(async ([name, local]) => {
    const response = await get(path + name);
    if (!response.ok) throw new Error('Pinned source ' + name + ' returned HTTP ' + response.status + '.');
    if (digest(new Uint8Array(await response.arrayBuffer())) !== digest(local)) {
      throw new Error('The pinned source commit does not match the checked-in ' + name + '.');
    }
  }));
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
  if (version !== '0.2.0' && sha256 === baseline.entries['index.html'].sha256) {
    console.error(`Civitai is still serving the verified v0.2.0 page. The reviewed v${version} page is not live yet.`);
    process.exitCode = 2;
  } else {
    if (sha256 !== digest(pageBytes)) throw new Error(`Hosted page SHA-256 differs from the reviewed page: ${sha256}`);
    const deployment = { checkedAt: new Date().toISOString(), version: manifest.version,
      ...(staged ? { comparisonSource: 'checked-in submission', recordedReviewZipSha256: proof.sha256 } : { sourceZipSha256: proof.sha256 }),
      hostedPageSha256: sha256, hostedPageBytes: bytes.length, liveUrl: assetOrigin + '/', listingId: first.id,
      appBlockId: first.kindData.appBlockId, catalogOrigins: origins, frameAncestors, screenshots: first.screenshots.length,
    };
    if (current) {
      for (const field of ['version', 'hostedPageSha256', 'hostedPageBytes', 'liveUrl', 'listingId', 'appBlockId', 'catalogOrigins']) {
        if (JSON.stringify(current[field]) !== JSON.stringify(deployment[field])) {
          throw new Error('The review kit does not match the live deployment field ' + field + '.');
        }
      }
      if (current.sourceZipSha256 !== proof.sha256) throw new Error('The review kit ZIP digest differs from the retained release record.');
      await verifyPinnedSubmission();
      deployment.sourceCommit = current.sourceCommit;
    }
    console.log(JSON.stringify(deployment, null, 2));
  }
}
