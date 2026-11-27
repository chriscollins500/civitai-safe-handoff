import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDropoffRequest, readDropoffRequest } from '../src/civitai/dropoff-request.ts';
import { pickupWindowMs } from '../src/civitai/live-signaling.ts';

const now = Date.UTC(2026, 10, 26);

test('request links keep the original deadline and preserve an optional Unicode checklist', () => {
  const plain = createDropoffRequest('', now);
  assert.deepEqual(readDropoffRequest(plain.hash, now + 1), plain);
  const request = createDropoffRequest(' ComfyUI workflow.json \r\n\r\n注記 🧪 ', now);
  assert.deepEqual(request.items, ['ComfyUI workflow.json', '注記 🧪']);
  assert.deepEqual(readDropoffRequest(request.hash, now + 1), request);
  assert.equal(request.expiresAt, now + pickupWindowMs);
  assert.deepEqual(readDropoffRequest(request.hash, request.expiresAt - 1)?.items, request.items);
  assert.throws(() => readDropoffRequest(request.hash, request.expiresAt), /request expired/);
  assert.throws(() => readDropoffRequest(request.hash, now - 121_000), /link is invalid/);
});

test('request checklist input and the received fragment enforce bounds independently', () => {
  const plain = createDropoffRequest('', now);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const request = createDropoffRequest(Array.from({ length: 8 }, (_, index) => String(index).repeat(85)).join('\n'), now);
  assert.ok(request.hash.length + 'https://civitai.com/apps/run/civitai-safe-handoff'.length < 2000);
  assert.deepEqual(readDropoffRequest(request.hash, now), request);
  assert.throws(() => createDropoffRequest('x\n'.repeat(9), now), /up to eight/);
  assert.throws(() => createDropoffRequest('x'.repeat(91), now), /90 characters/);
  assert.throws(() => createDropoffRequest('x\u202e', now), /checklist items/);
  assert.throws(() => createDropoffRequest(('語'.repeat(90) + '\n').repeat(3), now), /fit in one chat link/);
  for (const suffix of [encode({ items: [] }), encode(['  ']), encode(['x\u202e']), '_w', 'x'.repeat(961)]) {
    assert.throws(() => readDropoffRequest(plain.hash + '.' + suffix, now), /link is invalid/);
  }
  assert.equal(readDropoffRequest('#pickup=unrelated', now), undefined);
});
