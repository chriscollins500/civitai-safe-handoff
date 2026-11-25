import { sha256 } from '@noble/hashes/sha2.js';
import { partBounds, RECORD_OVERHEAD } from './layout.ts';
import type { FileLayout } from './layout.ts';

export type Bytes = Uint8Array<ArrayBuffer>;
const text = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const empty = new Uint8Array();

export function encodeBytes(value: Bytes) {
  let binary = '';
  for (let offset = 0; offset < value.length; offset += 8192) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 8192));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeBytes(value: string, length?: number): Bytes {
  if (!/^[\w-]*$/.test(value)) throw new Error('Invalid encoded data.');
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if ((length !== undefined && bytes.length !== length) || encodeBytes(bytes) !== value) {
    throw new Error('Invalid encoded length.');
  }
  return bytes;
}

export function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function sha256Hex(bytes: Uint8Array) {
  return hex(sha256(bytes));
}

export async function digestPart(bytes: Bytes) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

export async function hkdf(input: Bytes, salt: Bytes, info: string, length: number): Promise<Bytes> {
  const source = await crypto.subtle.importKey('raw', input, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: text.encode(info) }, source, length * 8);
  return new Uint8Array(bits);
}

export function randomSecret() {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function randomSalt() {
  return encodeBytes(crypto.getRandomValues(new Uint8Array(16)));
}

export async function seal(key: CryptoKey, scope: string, bytes: Bytes) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: text.encode(scope) }, key, bytes);
  return `${encodeBytes(nonce)}.${encodeBytes(new Uint8Array(encrypted))}`;
}

export async function unseal(key: CryptoKey, scope: string, value: string) {
  const fields = value.split('.');
  if (fields.length !== 2) throw new Error('Invalid envelope.');
  const [encodedNonce, encodedBody] = fields;
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decodeBytes(encodedNonce, 12), additionalData: text.encode(scope) }, key, decodeBytes(encodedBody),
  );
  return new Uint8Array(plain);
}

export async function sealJson(key: CryptoKey, scope: string, value: unknown) {
  return seal(key, scope, text.encode(JSON.stringify(value)));
}

export async function unsealJson(key: CryptoKey, scope: string, value: string): Promise<unknown> {
  return JSON.parse(decoder.decode(await unseal(key, scope, value)));
}

export async function packageManifestKey(secret: Bytes, packageId: string) {
  const keyBytes = await hkdf(secret, text.encode(packageId), 'Civitai SAFE manifest v1', 32);
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function inviteKey(secret: Bytes, inviteId: string) {
  const keyBytes = await hkdf(secret, text.encode(inviteId), 'Civitai SAFE invitation key v1', 32);
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function createEnvelope(secret: Bytes, inviteId: string, packageId: string, packageSecret: Bytes) {
  return seal(await inviteKey(secret, inviteId), `pickup:${packageId}:${inviteId}:v1`, packageSecret);
}

export async function openEnvelope(secret: Bytes, inviteId: string, packageId: string, envelope: string) {
  const opened = await unseal(await inviteKey(secret, inviteId), `pickup:${packageId}:${inviteId}:v1`, envelope);
  if (opened.length !== 32) throw new Error('Invalid package key.');
  return opened;
}

export async function inviteProof(secret: Bytes, inviteId: string, purpose: 'pickup' | 'dropoff') {
  return encodeBytes(await hkdf(secret, text.encode(inviteId), `Civitai SAFE ${purpose} authorization v1`, 32));
}

export function proofVerifier(proof: string) {
  return sha256Hex(text.encode(proof));
}

export async function dropoffSecret(requestSecret: Bytes, requestId: string, packageId: string) {
  return hkdf(requestSecret, text.encode(requestId), `Civitai SAFE drop-off package ${packageId} v1`, 32);
}

export async function recordCipher(ikm: Bytes, salt: Bytes) {
  if (salt.length !== 16) throw new Error('Invalid record salt.');
  const [keyBytes, nonce] = await Promise.all([
    hkdf(ikm, salt, 'Content-Encoding: aes128gcm\x00', 16),
    hkdf(ikm, salt, 'Content-Encoding: nonce\x00', 12),
  ]);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { key, nonce };
}

export async function fileCipher(secret: Bytes, packageId: string, fileId: string, encodedSalt: string) {
  const ikm = await hkdf(secret, text.encode(packageId), `Civitai SAFE file ${fileId} v1`, 32);
  return recordCipher(ikm, decodeBytes(encodedSalt, 16));
}

type RecordCipher = Awaited<ReturnType<typeof recordCipher>>;

function recordNonce(base: Bytes, index: number) {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('Invalid record sequence.');
  const value = base.slice();
  for (let byte = value.length - 1; index > 0; byte -= 1) {
    value[byte] ^= index % 256;
    index = Math.floor(index / 256);
  }
  return value;
}

export async function encryptRecord(cipher: RecordCipher, index: number, data: Bytes, final: boolean, scratch?: Bytes) {
  const length = data.length + 1;
  const input = scratch?.subarray(0, length) ?? new Uint8Array(length);
  if (input.length !== length) throw new RangeError('Record buffer is too small.');
  input.set(data);
  input[data.length] = final ? 2 : 1;
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: recordNonce(cipher.nonce, index), additionalData: empty }, cipher.key, input);
  return new Uint8Array(encrypted);
}

export async function decryptRecord(cipher: RecordCipher, index: number, data: Bytes, final: boolean) {
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: recordNonce(cipher.nonce, index), additionalData: empty }, cipher.key, data);
  const input = new Uint8Array(decrypted);
  let marker = input.length - 1;
  while (marker >= 0 && input[marker] === 0) marker -= 1;
  if (marker < 0 || input[marker] !== (final ? 2 : 1)) throw new Error('Record termination failed.');
  return input.subarray(0, marker);
}

export async function encryptPart(cipher: RecordCipher, layout: FileLayout, index: number, source: Bytes, expectedDigest: string,
  buffers?: { output: Bytes; record: Bytes }) {
  const bounds = partBounds(layout, index);
  if (source.length !== bounds.plainEnd - bounds.plainStart || await digestPart(source) !== expectedDigest) {
    throw new Error('Source file changed. Select the original file to resume safely.');
  }
  const length = bounds.cipherEnd - bounds.cipherStart;
  const output = buffers?.output.subarray(0, length) ?? new Uint8Array(length);
  if (output.length !== length) throw new RangeError('Encrypted part buffer is too small.');
  let plainOffset = 0;
  let cipherOffset = 0;
  for (let sequence = bounds.firstRecord; sequence < bounds.endRecord; sequence += 1) {
    const input = source.subarray(plainOffset, plainOffset + layout.plainPerRecord);
    const record = await encryptRecord(cipher, sequence, input, sequence === layout.recordCount - 1, buffers?.record);
    output.set(record, cipherOffset);
    plainOffset += input.length;
    cipherOffset += record.length;
  }
  return output;
}

export async function decryptPart(cipher: RecordCipher, layout: FileLayout, index: number, source: Bytes) {
  const bounds = partBounds(layout, index);
  if (source.length !== bounds.cipherEnd - bounds.cipherStart) throw new Error('Encrypted part is incomplete.');
  const output = new Uint8Array(bounds.plainEnd - bounds.plainStart);
  let plainOffset = 0;
  let cipherOffset = 0;
  for (let sequence = bounds.firstRecord; sequence < bounds.endRecord; sequence += 1) {
    const record = source.subarray(cipherOffset, cipherOffset + layout.recordSize);
    const plain = await decryptRecord(cipher, sequence, record, sequence === layout.recordCount - 1);
    if (plain.length !== record.length - RECORD_OVERHEAD) throw new Error('Unexpected record length.');
    output.set(plain, plainOffset);
    plainOffset += plain.length;
    cipherOffset += record.length;
  }
  return output;
}
