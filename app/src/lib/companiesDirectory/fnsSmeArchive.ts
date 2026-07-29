import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { assertSha256Hex } from '@/lib/companiesDirectory/guardedImportCore';
import {
  parseFnsSmeZipStream,
  validateFnsSmeZipEntryName,
  type FnsSmeExactOkvedRecord,
  type FnsSmeInvalidExactOkvedRecord,
  type FnsSmeExpectedZipEntry,
  type FnsSmeZipParseResult,
} from '@/lib/companiesDirectory/fnsSmeXml';

// unzipper 0.10 has no bundled TypeScript declarations.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const unzipper = require('unzipper') as {
  Open: {
    file(
      path: string,
      options?: { tailSize?: number },
    ): Promise<{
      files: Array<{
        path: string;
        type: string;
        crc32: number;
        compressedSize: number;
        uncompressedSize: number;
      }>;
    }>;
  };
};

const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_XML_ENTRY_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 100 * 1024 * 1024 * 1024;
const MAX_XML_ENTRIES = 100_000;
const CENTRAL_DIRECTORY_TAIL_BYTES = 1024 * 1024;

export interface FnsSmeArchiveInspection {
  archivePath: string;
  archiveBytes: number;
  archiveSha256: string;
  archiveMtimeMs: number;
  xmlEntryCount: number;
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
  entries: FnsSmeExpectedZipEntry[];
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function safeArchiveInteger(
  value: unknown,
  label: string,
): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Invalid ZIP ${label}: ${String(value)}`);
  }
  return number;
}

export async function inspectFnsSmeArchive(input: {
  archivePath: string;
  expectedBytes: number;
  expectedSha256: string;
}): Promise<FnsSmeArchiveInspection> {
  assertSha256Hex(input.expectedSha256, 'Expected FNS archive SHA-256');
  if (
    !Number.isSafeInteger(input.expectedBytes)
    || input.expectedBytes < 1
    || input.expectedBytes > MAX_ARCHIVE_BYTES
  ) {
    throw new Error('Expected FNS archive size is invalid');
  }

  const before = await stat(input.archivePath);
  if (before.size !== input.expectedBytes) {
    throw new Error(
      `FNS archive size mismatch: expected ${input.expectedBytes}, got ${before.size}`,
    );
  }
  const archiveSha256 = await sha256File(input.archivePath);
  if (archiveSha256 !== input.expectedSha256.toLowerCase()) {
    throw new Error(
      `FNS archive SHA-256 mismatch: expected ${input.expectedSha256}, `
      + `got ${archiveSha256}`,
    );
  }

  let directory: Awaited<ReturnType<typeof unzipper.Open.file>>;
  try {
    directory = await unzipper.Open.file(input.archivePath, {
      tailSize: CENTRAL_DIRECTORY_TAIL_BYTES,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ZIP central directory: ${message}`);
  }

  if (
    directory.files.length < 1
    || directory.files.length > MAX_XML_ENTRIES
  ) {
    throw new Error(
      `Unexpected ZIP entry count: ${directory.files.length}`,
    );
  }

  const names = new Set<string>();
  const entries: FnsSmeExpectedZipEntry[] = [];
  let totalCompressedBytes = 0;
  let totalUncompressedBytes = 0;
  for (const file of directory.files) {
    validateFnsSmeZipEntryName(file.path);
    if (file.type !== 'File') {
      throw new Error(`Unexpected non-file ZIP entry: ${file.path}`);
    }
    if (names.has(file.path)) {
      throw new Error(`Duplicate ZIP entry name: ${file.path}`);
    }
    names.add(file.path);

    const compressedSize = safeArchiveInteger(
      file.compressedSize,
      `${file.path} compressed size`,
    );
    const uncompressedSize = safeArchiveInteger(
      file.uncompressedSize,
      `${file.path} uncompressed size`,
    );
    const crcValue = safeArchiveInteger(file.crc32, `${file.path} CRC`);
    if (crcValue > 0xffff_ffff) {
      throw new Error(`Invalid ZIP CRC for ${file.path}`);
    }
    if (uncompressedSize > MAX_XML_ENTRY_BYTES) {
      throw new Error(`ZIP XML entry is too large: ${file.path}`);
    }

    totalCompressedBytes += compressedSize;
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error('ZIP total uncompressed size exceeds the safety limit');
    }
    entries.push({
      entryName: file.path,
      crc32: crcValue >>> 0,
      compressedSize,
      uncompressedSize,
    });
  }
  entries.sort((left, right) =>
    left.entryName.localeCompare(right.entryName)
  );

  const after = await stat(input.archivePath);
  if (
    after.size !== before.size
    || after.mtimeMs !== before.mtimeMs
  ) {
    throw new Error('FNS archive changed during inspection');
  }

  return {
    archivePath: input.archivePath,
    archiveBytes: before.size,
    archiveSha256,
    archiveMtimeMs: after.mtimeMs,
    xmlEntryCount: entries.length,
    totalCompressedBytes,
    totalUncompressedBytes,
    entries,
  };
}

export async function parseInspectedFnsSmeArchive(input: {
  inspection: FnsSmeArchiveInspection;
  onRecord(record: FnsSmeExactOkvedRecord): Promise<void> | void;
  onInvalidIdentity(
    record: FnsSmeInvalidExactOkvedRecord,
  ): Promise<void> | void;
}): Promise<FnsSmeZipParseResult> {
  const before = await stat(input.inspection.archivePath);
  if (
    before.size !== input.inspection.archiveBytes
    || before.mtimeMs !== input.inspection.archiveMtimeMs
  ) {
    throw new Error('FNS archive changed after inspection');
  }
  const currentSha256 = await sha256File(input.inspection.archivePath);
  if (currentSha256 !== input.inspection.archiveSha256) {
    throw new Error('FNS archive SHA-256 drift after inspection');
  }

  const expectedEntries = new Map(
    input.inspection.entries.map((entry) => [entry.entryName, entry]),
  );
  const result = await parseFnsSmeZipStream({
    input: createReadStream(input.inspection.archivePath),
    expectedEntries,
    onRecord: input.onRecord,
    onInvalidIdentity: input.onInvalidIdentity,
  });

  const after = await stat(input.inspection.archivePath);
  if (
    after.size !== before.size
    || after.mtimeMs !== before.mtimeMs
  ) {
    throw new Error('FNS archive changed during XML parsing');
  }
  return result;
}
