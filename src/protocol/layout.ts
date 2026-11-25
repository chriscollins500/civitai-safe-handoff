export const MIB = 1024 ** 2;
export const GIB = 1024 ** 3;
export const RECORD_BYTES = MIB;
export const RECORDS_PER_PART = 16;
export const RECORD_OVERHEAD = 17;
export const MAX_PACKAGE_BYTES = 64 * GIB;
export const MAX_FILES = 25;
export const DEFAULT_ACTIVE_INVITATIONS = 20;
export const MAX_PART_BYTES = RECORD_BYTES * RECORDS_PER_PART;
export const MAX_MANIFEST_BYTES = 384 * 1024;

export function fileLayout(plainSize: number, recordSize = RECORD_BYTES, recordsPerPart = RECORDS_PER_PART) {
  if (!Number.isSafeInteger(plainSize) || plainSize < 0 || plainSize > MAX_PACKAGE_BYTES) {
    throw new RangeError('Invalid file length.');
  }
  if (!Number.isSafeInteger(recordSize) || recordSize <= RECORD_OVERHEAD || recordSize > RECORD_BYTES) {
    throw new RangeError('Invalid record size.');
  }
  if (!Number.isSafeInteger(recordsPerPart) || recordsPerPart < 1 || recordsPerPart > RECORDS_PER_PART) {
    throw new RangeError('Invalid part size.');
  }
  const plainPerRecord = recordSize - RECORD_OVERHEAD;
  const recordCount = Math.max(1, Math.ceil(plainSize / plainPerRecord));
  return {
    plainSize,
    recordSize,
    recordsPerPart,
    plainPerRecord,
    recordCount,
    cipherSize: plainSize + recordCount * RECORD_OVERHEAD,
    partCount: Math.ceil(recordCount / recordsPerPart),
    cipherPerPart: recordSize * recordsPerPart,
  };
}

export type FileLayout = ReturnType<typeof fileLayout>;

export function partBounds(layout: FileLayout, number: number) {
  if (!Number.isSafeInteger(number) || number < 0 || number >= layout.partCount) {
    throw new RangeError('Unknown part.');
  }
  const firstRecord = number * layout.recordsPerPart;
  const endRecord = Math.min(firstRecord + layout.recordsPerPart, layout.recordCount);
  const plainStart = firstRecord * layout.plainPerRecord;
  const plainEnd = Math.min(endRecord * layout.plainPerRecord, layout.plainSize);
  const cipherStart = firstRecord * layout.recordSize;
  const cipherEnd = Math.min(endRecord * layout.recordSize, layout.cipherSize);
  return { firstRecord, endRecord, plainStart, plainEnd, cipherStart, cipherEnd };
}

export function fileSizeLabel(bytes: number) {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(2)} GiB`;
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}
