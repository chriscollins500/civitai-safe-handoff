import { MAX_DEPENDENCIES, validateDependencies } from '../protocol/manifest.ts';
import type { Dependency } from '../protocol/manifest.ts';

export const modelIdentitySchema = 'civitai-metadata-studio.identity-cache';
export const modelVersionEndpoints = [
  'https://civitai.com/api/v1/model-versions/',
  'https://civitai.red/api/v1/model-versions/',
] as const;

interface IdentityVersion {
  modelId: number;
  files: Map<number, string>;
}

export interface CatalogModelFile {
  name: string;
  fileId: number;
  sha256?: string;
  size?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function digest(hashes: unknown) {
  const sha256 = isRecord(hashes) && hashes.SHA256;
  return typeof sha256 === 'string' && /^[a-f0-9]{64}$/i.test(sha256) ? sha256.toLowerCase() : undefined;
}

export function catalogModelFiles(value: unknown) {
  const files = new Map<number, CatalogModelFile>();
  if (!Array.isArray(value)) return files;
  for (const file of value) {
    if (!isRecord(file) || !isId(file.id)) continue;
    if (files.has(file.id)) throw new Error('Civitai returned a duplicate file ID.');
    const bytes = typeof file.sizeKB === 'number' ? file.sizeKB * 1024 : 0;
    files.set(file.id, {
      name: typeof file.name === 'string' ? file.name.slice(0, 200) : `File ${file.id}`,
      fileId: file.id,
      sha256: digest(file.hashes),
      ...(Number.isSafeInteger(bytes) && bytes > 0 ? { size: bytes } : {}),
    });
  }
  return files;
}

function readIdentityVersions(input: unknown) {
  if (!isRecord(input) || input.schema !== modelIdentitySchema || input.schemaVersion !== 1) {
    throw new Error('Use a version 1 RasterRaid identity export.');
  }
  if (!Array.isArray(input.resources) || !input.resources.length || input.resources.length > MAX_DEPENDENCIES) {
    throw new Error(`Use an identity export with 1 to ${MAX_DEPENDENCIES} Civitai files.`);
  }
  const versions = new Map<number, IdentityVersion>();
  for (const resource of input.resources) {
    if (!isRecord(resource)) throw new Error('Invalid Civitai file identity.');
    const { modelId, modelVersionId, fileId, hashes } = resource;
    const sha256 = digest(hashes);
    if (!isId(modelId) || !isId(modelVersionId) || !isId(fileId) || !sha256) {
      throw new Error('Each Civitai file identity needs its model, version, file ID, and full SHA-256.');
    }
    const version = versions.get(modelVersionId) ?? { modelId, files: new Map<number, string>() };
    const previous = version.files.get(fileId);
    if (version.modelId !== modelId || (previous && previous !== sha256)) throw new Error('The identity export contains conflicting pins.');
    version.files.set(fileId, sha256);
    versions.set(modelVersionId, version);
  }
  return versions;
}

function matchModelVersion(details: unknown, versionId: number, { modelId, files }: IdentityVersion) {
  if (!isRecord(details) || details.id !== versionId || details.modelId !== modelId || !Array.isArray(details.files)) return undefined;
  const catalog = catalogModelFiles(details.files);
  const dependencies = [];
  for (const [fileId, sha256] of files) {
    const file = catalog.get(fileId);
    if (file?.sha256 !== sha256) return undefined;
    dependencies.push({ air: details.air, modelId, versionId, fileId, sha256, size: file.size });
  }
  return validateDependencies(dependencies);
}

export async function importModelIdentities(input: unknown, fetchPublic: typeof fetch = fetch): Promise<Dependency[]> {
  const versions = readIdentityVersions(input);
  const dependencies: Dependency[] = [];
  const deadline = AbortSignal.timeout(45000);
  for (const [versionId, version] of versions) {
    let confirmed: Dependency[] | undefined;
    for (const endpoint of modelVersionEndpoints) {
      if (deadline.aborted) throw new Error('Civitai identity checks timed out. Import fewer model versions and try again.');
      try {
        const response = await fetchPublic(`${endpoint}${versionId}`, {
          headers: { Accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
          signal: AbortSignal.any([deadline, AbortSignal.timeout(8000)]),
        });
        if (!response.ok) continue;
        confirmed = matchModelVersion(await response.json(), versionId, version);
        if (confirmed) break;
      } catch {
        continue;
      }
    }
    if (!confirmed) throw new Error(`Civitai could not verify every file in version ${versionId}. Check the export and the model's catalog availability.`);
    dependencies.push(...confirmed);
  }
  return dependencies;
}
