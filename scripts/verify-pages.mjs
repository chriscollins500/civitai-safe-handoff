import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { source: { type: 'string' } } });
const root = resolve(values.source ?? fileURLToPath(new URL('../docs/', import.meta.url)));
const site = 'https://chriscollins500.github.io/civitai-safe-handoff/';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function* siteFiles(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    const name = prefix + entry.name;
    if (entry.isDirectory()) yield* siteFiles(path, name + '/');
    else if (entry.isFile()) yield { name, path };
    else throw new Error('Expected a regular file or directory at ' + name);
  }
}

const files = [];
for await (const file of siteFiles(root)) files.push(file);
if (!files.some(({ name }) => name === 'index.html')) throw new Error('Expected a website root containing index.html.');

let mismatches = 0;
for (const { name, path } of files) {
  const route = name.replace(/(^|\/)index\.html$/, '$1').split('/').map(encodeURIComponent).join('/');
  const expected = digest(await readFile(path));
  try {
    const response = await fetch(new URL(route, site), {
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('HTTP ' + response.status);
    }
    const actual = digest(new Uint8Array(await response.arrayBuffer()));
    if (actual !== expected) throw new Error('expected SHA-256 ' + expected + ', served ' + actual);
  } catch (error) {
    mismatches++;
    console.error(name + ' ' + error.message);
  }
}

if (mismatches) process.exitCode = 1;
console.log((files.length - mismatches) + '/' + files.length + ' Pages files match their served SHA-256.');
