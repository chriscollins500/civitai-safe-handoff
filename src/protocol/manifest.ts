import { decodeBytes, packageManifestKey, sealJson, unsealJson } from './crypto.ts';
import type { Bytes } from './crypto.ts';
import { MAX_FILES } from './layout.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha = /^[a-f0-9]{64}$/;
export const MAX_DEPENDENCIES = 100;

export interface Dependency {
  air: string;
  modelId: number;
  versionId: number;
  fileId?: number;
  sha256?: string;
  size?: number;
  relationship?: string;
}

export interface ManifestFile {
  id: string;
  name: string;
  size: number;
  sha256: string;
  salt: string;
  role?: string;
}

export interface Manifest {
  version: 1;
  packageId: string;
  title: string;
  notes: string;
  files: ManifestFile[];
  dependencies: Dependency[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid manifest.');
  return value as Record<string, unknown>;
}

function string(value: unknown, max: number) {
  if (typeof value !== 'string' || value.length > max) throw new Error('Invalid manifest text.');
  return value;
}

function optionalText(value: unknown, length: number) {
  return value === undefined ? undefined : string(value, length).trim() || undefined;
}

export function dependencySource(dependency: Dependency, site: 'civitai.com' | 'civitai.red') {
  return `https://${site}/models/${dependency.modelId}?modelVersionId=${dependency.versionId}`;
}

export function validateDependencies(input: unknown): Dependency[] {
  if (!Array.isArray(input) || input.length > MAX_DEPENDENCIES) throw new Error(`Use an array of up to ${MAX_DEPENDENCIES} Civitai dependencies.`);
  return input.map((value) => {
    const item = object(value);
    const air = string(item.air, 160);
    const match = air.match(/^urn:air:[a-z0-9_-]+:[a-z0-9_-]+:civitai:([1-9][0-9]*)@([1-9][0-9]*)$/i);
    if (!match || !Number.isSafeInteger(item.modelId) || !Number.isSafeInteger(item.versionId) ||
      Number(match[1]) !== item.modelId || Number(match[2]) !== item.versionId) throw new Error('A Civitai dependency is missing its exact model and version identity.');
    const sha256 = item.sha256 === undefined ? undefined : string(item.sha256, 64).toLowerCase();
    if (sha256 !== undefined && !sha.test(sha256)) throw new Error('Invalid dependency SHA-256.');
    const fileId = item.fileId;
    if (fileId !== undefined && (typeof fileId !== 'number' || !Number.isSafeInteger(fileId) || fileId < 1)) throw new Error('Invalid Civitai file ID.');
    const size = item.size;
    if (size !== undefined && (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)) throw new Error('Invalid dependency size.');
    const relationship = optionalText(item.relationship, 160);
    return { air, modelId: item.modelId as number, versionId: item.versionId as number, sha256,
      ...(fileId !== undefined ? { fileId } : {}), ...(size !== undefined ? { size } : {}), ...(relationship ? { relationship } : {}) };
  });
}

export function describeHandoff(manifest: Manifest) {
  return {
    format: 'civitai-safe-handoff', version: 1, packageId: manifest.packageId, title: manifest.title, notes: manifest.notes,
    files: manifest.files.map(({ id, name, size, sha256, role }) => ({ id, name, size, sha256, role })),
    dependencies: manifest.dependencies.map((item) => ({ ...item,
      sources: [dependencySource(item, 'civitai.com'), dependencySource(item, 'civitai.red')] })),
  };
}

export async function lockManifest(manifest: Manifest, secret: Bytes) {
  return sealJson(await packageManifestKey(secret, manifest.packageId), `manifest:${manifest.packageId}:v1`, manifest);
}

export async function unlockManifest(sealed: string, packageId: string, secret: Bytes, declared: { id: string; size: number }[]) {
  const decoded = object(await unsealJson(await packageManifestKey(secret, packageId), `manifest:${packageId}:v1`, sealed));
  if (decoded.version !== 1 || decoded.packageId !== packageId || !Array.isArray(decoded.files) ||
    decoded.files.length !== declared.length || declared.length < 1 || declared.length > MAX_FILES) throw new Error('The encrypted file list did not match this transfer.');
  const files = decoded.files.map((value, position) => {
    const file = object(value);
    const id = string(file.id, 36);
    const sha256 = string(file.sha256, 64);
    const salt = string(file.salt, 22);
    decodeBytes(salt, 16);
    if (!uuid.test(id) || !sha.test(sha256) || id !== declared[position].id || file.size !== declared[position].size) {
      throw new Error('The encrypted file information did not match this transfer.');
    }
    const role = optionalText(file.role, 80);
    return { id, name: string(file.name, 512), sha256, salt, size: declared[position].size, ...(role ? { role } : {}) };
  });
  return {
    version: 1, packageId, files, title: string(decoded.title, 120), notes: string(decoded.notes, 4000),
    dependencies: validateDependencies(decoded.dependencies),
  } as Manifest;
}
