import { decodeBytes, encodeBytes } from '../protocol/crypto.ts';
import { pickupWindowMs } from './live-signaling.ts';

const requestPrefix = '#dropoff=';
const requestHashPattern = /^#dropoff=(\d{13})\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.([A-Za-z0-9_-]{1,960}))?$/;
const clockToleranceMs = 2 * 60 * 1000;
const maxChecklistBytes = 720;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function validChecklist(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 8 && value.every((item: unknown) =>
    typeof item === 'string' && item.length > 0 && item.length <= 90 && item === item.trim() &&
    !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u.test(item));
}

export function createDropoffRequest(checklist = '', now = Date.now()) {
  const items = checklist.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (!validChecklist(items)) throw new Error('Use up to eight checklist items, with at most 90 characters per item.');
  const bytes = encoder.encode(JSON.stringify(items));
  if (bytes.byteLength > maxChecklistBytes) throw new Error('Shorten the checklist to fit in one chat link.');
  const expiresAt = now + pickupWindowMs;
  const suffix = items.length ? '.' + encodeBytes(bytes) : '';
  return { expiresAt, hash: `${requestPrefix}${expiresAt}.${crypto.randomUUID()}${suffix}`, items };
}

export function readDropoffRequest(hash: unknown, now = Date.now()) {
  if (typeof hash !== 'string' || !hash.startsWith(requestPrefix)) return undefined;
  const match = requestHashPattern.exec(hash);
  if (!match || Number(match[1]) > now + pickupWindowMs + clockToleranceMs) {
    throw new Error('This drop-off request link is invalid.');
  }
  const expiresAt = Number(match[1]);
  if (expiresAt <= now) throw new Error('This drop-off request expired.');
  try {
    const items: unknown = match[2] ? JSON.parse(decoder.decode(decodeBytes(match[2]))) : [];
    if (validChecklist(items)) return { expiresAt, hash, items };
  } catch {
    // Send the same validation message for malformed text and malformed JSON.
  }
  throw new Error('This drop-off request link is invalid.');
}
