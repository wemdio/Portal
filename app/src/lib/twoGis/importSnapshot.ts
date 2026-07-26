import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Transform } from 'node:stream';

export const TWO_GIS_IMPORT_LOCK = 'portal:2gis-dataset:snapshot-import';

export interface TwoGisImportStats {
  sourceRows: number;
  acceptedRows: number;
  rejectedRows: number;
  duplicateIds: number;
}

export interface TwoGisImportExpectations {
  expectedSourceRows: number;
  expectedAcceptedRows: number;
}

export interface TwoGisLiveSnapshotStats {
  cards: number;
  uniqueIds: number;
  acceptedRows: number;
  normalizedSubcategories: number;
  subcategoryFacets: number;
}

export function createSepDirectiveStripper(): Transform {
  let pending = Buffer.alloc(0);
  let directiveRemoved = false;

  return new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      if (directiveRemoved) {
        callback(null, chunk);
        return;
      }

      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      pending = Buffer.concat([pending, buffer]);
      const newlineIndex = pending.indexOf(0x0a);

      if (newlineIndex === -1) {
        if (pending.length > 128) {
          callback(new Error('2GIS CSV is missing the expected first-line sep=; directive'));
        } else {
          callback();
        }
        return;
      }

      const firstLine = pending
        .subarray(0, newlineIndex + 1)
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .trim();
      if (firstLine !== 'sep=;') {
        callback(
          new Error(`2GIS CSV must start with sep=; (received ${JSON.stringify(firstLine)})`),
        );
        return;
      }

      directiveRemoved = true;
      const remainder = pending.subarray(newlineIndex + 1);
      pending = Buffer.alloc(0);
      callback(null, remainder);
    },
    flush(callback) {
      if (!directiveRemoved) {
        callback(new Error('2GIS CSV ended before the sep=; directive was complete'));
        return;
      }
      callback();
    },
  });
}

export function createTwoGisHeaderValidator(
  columns: readonly string[],
): Transform {
  const expectedHeader = columns
    .map((column) => `"${column.replace(/"/g, '""')}"`)
    .join(';');
  let pending = Buffer.alloc(0);
  let headerValidated = false;

  return new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      if (headerValidated) {
        callback(null, chunk);
        return;
      }

      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      pending = Buffer.concat([pending, buffer]);
      const newlineIndex = pending.indexOf(0x0a);

      if (newlineIndex === -1) {
        if (pending.length > 2_048) {
          callback(new Error('2GIS CSV header is unexpectedly long'));
        } else {
          callback();
        }
        return;
      }

      const header = pending
        .subarray(0, newlineIndex)
        .toString('utf8')
        .replace(/\r$/, '');
      if (header !== expectedHeader) {
        callback(
          new Error(
            `2GIS CSV header mismatch: expected ${JSON.stringify(expectedHeader)}, `
            + `received ${JSON.stringify(header)}`,
          ),
        );
        return;
      }

      headerValidated = true;
      const remainder = pending.subarray(newlineIndex + 1);
      pending = Buffer.alloc(0);
      callback(null, remainder);
    },
    flush(callback) {
      if (!headerValidated) {
        callback(new Error('2GIS CSV ended before the source header was complete'));
        return;
      }
      callback();
    },
  });
}

export async function calculateFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

export function validateTwoGisImportStats(
  stats: TwoGisImportStats,
  expectations: TwoGisImportExpectations,
): void {
  for (const [label, value] of Object.entries({ ...stats, ...expectations })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid ${label}: ${String(value)}`);
    }
  }
  if (stats.sourceRows !== expectations.expectedSourceRows) {
    throw new Error(
      `Unexpected source row count: expected ${expectations.expectedSourceRows}, got ${stats.sourceRows}`,
    );
  }
  if (stats.acceptedRows !== expectations.expectedAcceptedRows) {
    throw new Error(
      `Unexpected accepted row count: expected ${expectations.expectedAcceptedRows}, got ${stats.acceptedRows}`,
    );
  }
  if (stats.sourceRows !== stats.acceptedRows + stats.rejectedRows) {
    throw new Error(
      'Source row count must equal accepted rows plus rejected rows',
    );
  }
  if (stats.duplicateIds !== 0) {
    throw new Error(`Duplicate non-empty 2GIS IDs found: ${stats.duplicateIds}`);
  }
}

export function validateTwoGisLiveSnapshot(
  stats: TwoGisLiveSnapshotStats,
  expectedAcceptedRows: number,
): void {
  for (const [label, value] of Object.entries(stats)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Invalid live snapshot ${label}: ${String(value)}`);
    }
  }
  if (
    stats.cards !== expectedAcceptedRows
    || stats.uniqueIds !== expectedAcceptedRows
    || stats.acceptedRows !== expectedAcceptedRows
  ) {
    throw new Error(
      `Post-import verification failed: cards=${stats.cards}, `
      + `uniqueIds=${stats.uniqueIds}, accepted=${stats.acceptedRows}`,
    );
  }
  if (stats.normalizedSubcategories === 0 || stats.subcategoryFacets === 0) {
    throw new Error(
      'Normalized subcategory membership or facets are missing from the live snapshot',
    );
  }
}
