import { decodeBytes, encodeBytes, randomSecret } from '../protocol/crypto.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const prefix = 'SAFE1.';
const pickupHashPrefix = '#pickup=';
const maximumSdp = 16 * 1024;
const maximumExpandedCode = 32 * 1024;
const maximumCode = 16 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const pickupWindowMs = 24 * 60 * 60 * 1000;
export const chatCodeLine = 1800;
export const chatMessageLimit = 2000;
export const liveDataLabel = 'civitai-safe-1';

interface Offer {
  type: 'offer';
  id: string;
  expiresAt: number;
  secret: string;
  sdp: string;
}

interface Answer {
  type: 'answer';
  id: string;
  proof: string;
  sdp: string;
}

export function createLivePeer() {
  return new RTCPeerConnection({ iceServers: [] });
}

function directSdp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > maximumSdp) return false;
  const lines = value.split(/\r?\n/);
  const media = lines.filter((line) => line.startsWith('m='));
  const candidates = lines.filter((line) => line.startsWith('a=candidate:'));
  return media.length === 1 && /^m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel$/.test(media[0]) &&
    candidates.length > 0 && candidates.every((line) => / typ host(?: |$)/.test(line));
}

async function encode(value: Offer | Answer) {
  const gzip = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'));
  const output = prefix + encodeBytes(new Uint8Array(await new Response(gzip).arrayBuffer()));
  if (output.length > maximumCode) throw new Error('The browser produced a pickup code that is too long.');
  return output;
}

async function decode(code: string): Promise<Offer | Answer> {
  if (code.length > maximumCode + Math.ceil(maximumCode / chatCodeLine) * 2) throw new Error('The pickup code is too long.');
  const value = code.replace(/\s/g, '');
  if (!value.startsWith(prefix) || value.length > maximumCode) throw new Error('Paste a Civitai SAFE pickup code.');
  const gzip = new Blob([decodeBytes(value.slice(prefix.length))]).stream().pipeThrough(new DecompressionStream('gzip'));
  const input = gzip.getReader();
  let result = '';
  let size = 0;
  try {
    for (;;) {
      const next = await input.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumExpandedCode) throw new Error('The pickup code expands beyond its limit.');
      result += decoder.decode(next.value, { stream: true });
    }
    result += decoder.decode();
  } finally {
    await input.cancel().catch(() => undefined);
    input.releaseLock();
  }
  const packet = JSON.parse(result) as Offer | Answer | null;
  if (!packet || typeof packet.id !== 'string' || !uuid.test(packet.id) || !directSdp(packet.sdp)) {
    throw new Error('The pickup code has no supported direct data connection.');
  }
  if (packet.type === 'offer' && typeof packet.secret === 'string' && packet.secret.length === 43 &&
    Number.isSafeInteger(packet.expiresAt) && packet.expiresAt > 0) {
    decodeBytes(packet.secret, 32);
    return packet;
  }
  if (packet.type === 'answer' && typeof packet.proof === 'string' && packet.proof.length === 43) {
    decodeBytes(packet.proof, 32);
    return packet;
  }
  throw new Error('The pickup code is incomplete.');
}

async function gatheredSdp(peer: RTCPeerConnection) {
  if (peer.iceGatheringState !== 'complete') {
    await new Promise<void>((resolve, reject) => {
      const signal = AbortSignal.timeout(12000);
      const finished = () => { if (peer.iceGatheringState === 'complete') resolve(); };
      peer.addEventListener('icegatheringstatechange', finished, { signal });
      signal.addEventListener('abort', () => reject(new Error('The browser could not find a direct network path.')), { once: true });
      finished();
    });
  }
  const sdp = peer.localDescription?.sdp;
  if (!directSdp(sdp)) throw new Error('This browser did not offer a compatible local network connection.');
  return sdp;
}

async function answerKey(offer: Offer) {
  return crypto.subtle.importKey('raw', decodeBytes(offer.secret, 32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function answerProofInput(offer: Offer, sdp: string) {
  return encoder.encode(JSON.stringify(['civitai-safe:answer:1', offer.id, offer.expiresAt, offer.sdp, sdp]));
}

export async function createLiveOffer(peer: RTCPeerConnection, expiresAt: number) {
  await peer.setLocalDescription(await peer.createOffer());
  const offer: Offer = { type: 'offer', id: crypto.randomUUID(), expiresAt, secret: encodeBytes(randomSecret()), sdp: await gatheredSdp(peer) };
  return { offer, code: await encode(offer) };
}

export async function readLiveOffer(code: string) {
  const packet = await decode(code);
  if (packet.type !== 'offer') throw new Error('Paste the sender’s pickup offer.');
  return packet;
}

export async function createLiveAnswer(peer: RTCPeerConnection, offer: Offer) {
  await peer.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
  await peer.setLocalDescription(await peer.createAnswer());
  const sdp = await gatheredSdp(peer);
  const mac = await crypto.subtle.sign('HMAC', await answerKey(offer), answerProofInput(offer, sdp));
  return encode({ type: 'answer', id: offer.id, proof: encodeBytes(new Uint8Array(mac)), sdp });
}

export async function applyLiveAnswer(peer: RTCPeerConnection, invite: Offer, code: string) {
  const answer = await decode(code);
  if (answer.type !== 'answer' || answer.id !== invite.id || !await crypto.subtle.verify(
    'HMAC', await answerKey(invite), decodeBytes(answer.proof, 32), answerProofInput(invite, answer.sdp),
  )) throw new Error('This reply belongs to a different pickup offer.');
  await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
}

export function chatCode(code: string) {
  return code.match(new RegExp(`.{1,${chatCodeLine}}`, 'g'))?.join('\n') ?? '';
}

export function pickupHash(code: string) {
  return pickupHashPrefix + code;
}

export function pickupFromHash(hash: unknown) {
  if (typeof hash !== 'string' || !hash.startsWith(pickupHashPrefix)) return undefined;
  const code = hash.slice(pickupHashPrefix.length);
  return code.length <= maximumCode && /^SAFE1\.[A-Za-z0-9_-]+$/.test(code) ? code : undefined;
}
