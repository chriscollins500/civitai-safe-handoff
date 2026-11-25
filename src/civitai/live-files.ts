import {
  isValidSaveModel3d, looksLikeSaveModel3d, SAVE_MODEL3D_EXTENSION, SAVE_MODEL3D_MAX_BYTES,
} from '@civitai/app-sdk/save-model3d';
import { SAVE_ZIP_ALLOWED_EXTENSIONS, SAVE_ZIP_MAX_BYTES, validateSaveZip, verifySaveZipInflate } from '@civitai/app-sdk/save-zip';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { zipSync } from 'fflate';
import { MAX_FILES, MIB } from '../protocol/layout.ts';

const ordinaryLimit = 50 * MIB;
const savedImageTypes = new Set(['jpg', 'jpeg', 'png', 'webp']);
const utf8 = new TextDecoder('utf-8', { fatal: true });
export const liveFileAccept = '.txt,.csv,.json,.jpg,.jpeg,.png,.webp,.zip,.glb,.fbx';

export interface LiveFile {
  name: string;
  size: number;
  sha256: string;
}

function fileExtension(name: string) {
  const period = name.lastIndexOf('.');
  return period > 0 ? name.slice(period + 1).toLowerCase() : '';
}

function requirePlainName(name: string) {
  if (!name || name.length > 200 || /[/\\\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(name)) {
    throw new Error('Choose a file with a plain filename.');
  }
}

function plainText(data: Uint8Array) {
  if (data.includes(0)) throw new Error('This file contains binary data.');
  return utf8.decode(data);
}

export function requireSaveCandidate(name: string, size: number) {
  requirePlainName(name);
  const extension = fileExtension(name);
  const cap = extension === 'zip' ? SAVE_ZIP_MAX_BYTES :
    extension === 'glb' || extension === 'fbx' ? SAVE_MODEL3D_MAX_BYTES :
    savedImageTypes.has(extension) || extension === 'txt' || extension === 'json' ? ordinaryLimit : 0;
  if (!cap) throw new Error('Choose a supported image, JSON, text, 3D model, or allowed ZIP.');
  if (!Number.isSafeInteger(size) || size < 1 || size > cap) throw new Error(`This file must be between 1 byte and ${cap / MIB} MiB.`);
}

export async function inspectSaveBytes(name: string, bytes: ArrayBuffer, signal?: AbortSignal): Promise<void> {
  requireSaveCandidate(name, bytes.byteLength);
  signal?.throwIfAborted();
  const type = fileExtension(name);
  const data = new Uint8Array(bytes);
  if (type === 'zip') {
    const result = validateSaveZip(bytes);
    if (!result.ok) throw new Error(result.error);
    const error = await verifySaveZipInflate(bytes, result.deflated, signal);
    if (error) throw new Error(error);
    return;
  }
  if (type === 'glb' || type === 'fbx') {
    const kind = looksLikeSaveModel3d(data);
    if (!kind || SAVE_MODEL3D_EXTENSION[kind] !== type || !isValidSaveModel3d(data, kind)) {
      throw new Error('Civitai requires a valid binary GLB or FBX.');
    }
    return;
  }
  if (type === 'json' || type === 'txt') {
    const text = plainText(data);
    if (type === 'json') JSON.parse(text);
    return;
  }
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => data[index] === value);
  const jpeg = data[0] === 255 && data[1] === 216 && data[2] === 255;
  const webp = [82, 73, 70, 70].every((value, index) => data[index] === value) &&
    [87, 69, 66, 80].every((value, index) => data[index + 8] === value);
  if ((type === 'png' && png) || ((type === 'jpg' || type === 'jpeg') && jpeg) || (type === 'webp' && webp)) return;
  throw new Error('The image bytes and filename disagree.');
}

export async function describeLiveFile(file: File): Promise<LiveFile> {
  requireSaveCandidate(file.name, file.size);
  const bytes = await file.arrayBuffer();
  await inspectSaveBytes(file.name, bytes, AbortSignal.timeout(90000));
  return { name: file.name, size: file.size, sha256: bytesToHex(sha256(new Uint8Array(bytes))) };
}

export async function prepareLiveSource(files: readonly File[]) {
  if (!files.length || files.length > MAX_FILES) throw new Error(`Select 1 to ${MAX_FILES} supported files.`);
  const original = files[0];
  if (files.length === 1 && fileExtension(original.name) !== 'csv') {
    return { file: original, info: await describeLiveFile(original) };
  }
  const names = new Set<string>();
  const encoder = new TextEncoder();
  let archiveSize = 22;
  for (const file of files) {
    requirePlainName(file.name);
    const extension = fileExtension(file.name);
    if (!SAVE_ZIP_ALLOWED_EXTENSIONS.has(extension)) throw new Error('A handoff ZIP cannot contain ' + file.name + '.');
    const key = file.name.normalize('NFC').toLowerCase();
    if (names.has(key)) throw new Error('Rename duplicate filenames before building the ZIP.');
    names.add(key);
    archiveSize += 76 + 2 * encoder.encode(file.name).byteLength + file.size;
  }
  if (archiveSize > SAVE_ZIP_MAX_BYTES) throw new Error('These files exceed the app’s 256 MiB ZIP limit.');
  const members: Record<string, Uint8Array<ArrayBuffer>> = Object.create(null);
  for (const file of files) {
    const buffer = await file.arrayBuffer();
    const extension = fileExtension(file.name);
    if (extension === 'csv' || (extension === 'txt' && !buffer.byteLength)) plainText(new Uint8Array(buffer));
    else await inspectSaveBytes(file.name, buffer);
    members[file.name] = new Uint8Array(buffer);
  }
  const bytes = zipSync(members, { level: 0, mtime: new Date(1980, 0, 1) });
  const name = 'civitai-safe-handoff.zip';
  await inspectSaveBytes(name, bytes.buffer, AbortSignal.timeout(90000));
  const file = new File([bytes], name, { type: 'application/zip' });
  return { file, info: { name, size: bytes.byteLength, sha256: bytesToHex(sha256(bytes)) } };
}

export async function verifyLiveFile(file: File, expected: LiveFile, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (file.size !== expected.size) return false;
  const hash = sha256.create();
  const reader = file.stream().getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) return bytesToHex(hash.digest()) === expected.sha256;
      hash.update(next.value);
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
    hash.destroy();
  }
}
