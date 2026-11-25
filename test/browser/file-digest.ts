import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { MIB } from '../../src/protocol/layout.ts';

export async function digestFile(path: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: MIB })) digest.update(chunk);
  return digest.digest('hex');
}
