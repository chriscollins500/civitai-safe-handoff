import { build } from 'esbuild';
import { cp, mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = new URL('../dist/civitai-app/', import.meta.url);
const pageOutput = new URL('index.html', directory);
const manifestOutput = new URL('block.manifest.json', directory);
await mkdir(directory, { recursive: true });

const script = await build({
  absWorkingDir: root, entryPoints: ['src/civitai/composer.ts'], bundle: true, write: false,
  format: 'iife', platform: 'browser', target: ['chrome120', 'firefox128', 'safari17.4'], legalComments: 'eof',
});
const page = await readFile(new URL('../src/civitai/index.html', import.meta.url), 'utf8');
const style = (await Promise.all(['../src/web/style.css', '../src/civitai/style.css']
  .map((file) => readFile(new URL(file, import.meta.url), 'utf8')))).join('\n');
if (/<\/script/i.test(script.outputFiles[0].text) || /<\/style/i.test(style)) throw new Error('Cannot inline the composed app.');
await writeFile(pageOutput, page.replace('<!--SAFE_STYLE-->', () => `<style>\n${style}\n</style>`)
  .replace('<!--SAFE_SCRIPT-->', () => `<script>\n${script.outputFiles[0].text}\n</script>`));
await cp(new URL('../civitai/block.manifest.json', import.meta.url), manifestOutput);
// The submission CLI preserves file modification times in its ZIP.
const archiveTime = new Date('2000-01-01T00:00:00Z');
await Promise.all([pageOutput, manifestOutput].map((file) => utimes(file, archiveTime, archiveTime)));

if (process.env.SAFE_ORIGIN) {
  const publicOrigin = new URL(process.env.SAFE_ORIGIN);
  if (publicOrigin.protocol !== 'https:' || publicOrigin.href !== `${publicOrigin.origin}/` || publicOrigin.username || publicOrigin.password) {
    throw new Error('SAFE_ORIGIN must be the transfer service HTTPS origin.');
  }
  const listing = JSON.parse(await readFile(new URL('../civitai/external-listing.json', import.meta.url), 'utf8'));
  listing.externalUrl = publicOrigin.href;
  await writeFile(new URL('../dist/civitai-external-listing.json', import.meta.url), `${JSON.stringify(listing, null, 2)}\n`);
}
