import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

import {
  canonicalJson,
  isJsonObject,
  type JsonObject,
} from '@/lib/companiesDirectory/guardedImportCore';
import { FnsExactPlanStore } from '@/lib/companiesDirectory/fnsExactPlanStore';
import {
  validateFnsInn,
  validateFnsOgrn,
} from '@/lib/companiesDirectory/fnsSmeXml';
import { parseJsonValue } from '@/lib/companiesDirectory/planFileIO';

const CURRENT_SNAPSHOT_SOURCE = {
  host: '139.60.162.12',
  port: 35434,
  database: 'postgres',
  table: 'companies_directory',
} as const;

export interface FnsExactSnapshotResult {
  version: 2;
  snapshotPath: string;
  bytes: number;
  sha256: string;
  exported_at: string;
  rows: number;
  null_exact_rows: number;
  empty_or_whitespace_exact_rows: number;
  null_source_rows: number;
  empty_or_whitespace_source_rows: number;
  invalid_inn_rows: number;
  null_ogrn_rows: number;
  empty_or_whitespace_ogrn_rows: number;
  valid_ogrn_rows: number;
  invalid_ogrn_rows: number;
  ogrn_type_mismatch_rows: number;
}

function assertExactKeys(
  value: JsonObject,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  const missing = expected.filter((key) => !(key in value));
  const unexpected = keys.filter((key) => !expected.includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `${label} fields mismatch`
      + `${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}`
      + `${unexpected.length > 0 ? `; unexpected: ${unexpected.join(', ')}` : ''}`,
    );
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function validateMeta(value: unknown): string {
  if (!isJsonObject(value)) {
    throw new Error('FNS exact snapshot meta must be an object');
  }
  assertExactKeys(
    value,
    ['kind', 'version', 'source', 'exported_at'],
    'FNS exact snapshot meta',
  );
  if (value.kind !== 'meta' || value.version !== 2) {
    throw new Error('FNS exact snapshot meta version/kind is invalid');
  }
  if (
    canonicalJson(value.source)
    !== canonicalJson(CURRENT_SNAPSHOT_SOURCE)
  ) {
    throw new Error('FNS exact snapshot source target is not current Portal');
  }
  if (
    typeof value.exported_at !== 'string'
    || Number.isNaN(Date.parse(value.exported_at))
  ) {
    throw new Error('FNS exact snapshot exported_at is invalid');
  }
  return value.exported_at;
}

function validateSnapshotRow(
  value: unknown,
  rowNumber: number,
): {
  id: string;
  inn: string;
  ogrn: string | null;
  okved_code_exact: string | null;
  okved_exact_source: string | null;
} {
  if (!isJsonObject(value)) {
    throw new Error(`Snapshot row ${rowNumber} must be an object`);
  }
  assertExactKeys(
    value,
    ['id', 'inn', 'ogrn', 'okved_code_exact', 'okved_exact_source'],
    `Snapshot row ${rowNumber}`,
  );
  if (
    value.ogrn !== null
    && typeof value.ogrn !== 'string'
  ) {
    throw new Error(`Snapshot row ${rowNumber} OGRN must be text or null`);
  }
  if (
    typeof value.id !== 'string'
    || typeof value.inn !== 'string'
  ) {
    throw new Error(`Snapshot row ${rowNumber} id/INN must be strings`);
  }
  if (
    value.okved_code_exact !== null
    && typeof value.okved_code_exact !== 'string'
  ) {
    throw new Error(`Snapshot row ${rowNumber} exact OKVED is invalid`);
  }
  if (
    value.okved_exact_source !== null
    && typeof value.okved_exact_source !== 'string'
  ) {
    throw new Error(`Snapshot row ${rowNumber} exact source is invalid`);
  }
  return {
    id: value.id,
    inn: value.inn,
    ogrn: value.ogrn,
    okved_code_exact: value.okved_code_exact,
    okved_exact_source: value.okved_exact_source,
  };
}

function taxpayerTypeForInnLength(
  inn: string,
): 'legal_entity' | 'individual_entrepreneur' | null {
  if (inn.length === 10) return 'legal_entity';
  if (inn.length === 12) return 'individual_entrepreneur';
  return null;
}

function isValidFnsInn(inn: string): boolean {
  try {
    const taxpayerType = taxpayerTypeForInnLength(inn);
    if (taxpayerType === null) return false;
    validateFnsInn(inn, taxpayerType);
    return true;
  } catch {
    return false;
  }
}

function ogrnQuality(
  inn: string,
  ogrn: string | null,
): 'null' | 'blank' | 'valid' | 'invalid' | 'type_mismatch' {
  if (ogrn === null) return 'null';
  if (ogrn.trim() === '') return 'blank';
  const taxpayerType = taxpayerTypeForInnLength(inn);
  if (taxpayerType === null) return 'invalid';
  const expectedLength = taxpayerType === 'legal_entity' ? 13 : 15;
  if (/^\d+$/.test(ogrn) && ogrn.length !== expectedLength) {
    return 'type_mismatch';
  }
  try {
    validateFnsOgrn(ogrn, taxpayerType);
    return 'valid';
  } catch {
    return 'invalid';
  }
}

export async function loadFnsExactSnapshot(input: {
  snapshotPath: string;
  store: FnsExactPlanStore;
}): Promise<FnsExactSnapshotResult> {
  const file = await stat(input.snapshotPath);
  const sha256 = await sha256File(input.snapshotPath);
  const lines = createInterface({
    input: createReadStream(input.snapshotPath).pipe(createGunzip()),
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  let rows = 0;
  let exportedAt: string | null = null;
  let nullExactRows = 0;
  let emptyExactRows = 0;
  let nullSourceRows = 0;
  let emptySourceRows = 0;
  let invalidInnRows = 0;
  let nullOgrnRows = 0;
  let emptyOgrnRows = 0;
  let validOgrnRows = 0;
  let invalidOgrnRows = 0;
  let ogrnTypeMismatchRows = 0;
  let began = false;

  try {
    input.store.beginSnapshot();
    began = true;
    for await (const line of lines) {
      lineNumber += 1;
      if (line === '') {
        throw new Error(`Snapshot contains an empty line at ${lineNumber}`);
      }
      const value = parseJsonValue<unknown>(
        line,
        `FNS exact snapshot:${lineNumber}`,
      );
      if (lineNumber === 1) {
        exportedAt = validateMeta(value);
        continue;
      }
      const row = validateSnapshotRow(value, lineNumber);
      input.store.addExisting(row);
      rows += 1;
      if (!isValidFnsInn(row.inn)) {
        invalidInnRows += 1;
      }
      const quality = ogrnQuality(row.inn, row.ogrn);
      if (quality === 'null') nullOgrnRows += 1;
      if (quality === 'blank') emptyOgrnRows += 1;
      if (quality === 'valid') validOgrnRows += 1;
      if (quality === 'invalid') invalidOgrnRows += 1;
      if (quality === 'type_mismatch') {
        invalidOgrnRows += 1;
        ogrnTypeMismatchRows += 1;
      }
      if (row.okved_code_exact === null) {
        nullExactRows += 1;
      } else if (row.okved_code_exact.trim() === '') {
        emptyExactRows += 1;
      }
      if (row.okved_exact_source === null) {
        nullSourceRows += 1;
      } else if (row.okved_exact_source.trim() === '') {
        emptySourceRows += 1;
      }
    }
    if (exportedAt === null) {
      throw new Error('FNS exact snapshot has no metadata line');
    }
    input.store.commitSnapshot();
    began = false;
  } catch (error) {
    lines.close();
    if (began) {
      input.store.rollbackSnapshot();
    }
    throw error;
  }

  return {
    version: 2,
    snapshotPath: input.snapshotPath,
    bytes: file.size,
    sha256,
    exported_at: exportedAt,
    rows,
    null_exact_rows: nullExactRows,
    empty_or_whitespace_exact_rows: emptyExactRows,
    null_source_rows: nullSourceRows,
    empty_or_whitespace_source_rows: emptySourceRows,
    invalid_inn_rows: invalidInnRows,
    null_ogrn_rows: nullOgrnRows,
    empty_or_whitespace_ogrn_rows: emptyOgrnRows,
    valid_ogrn_rows: validOgrnRows,
    invalid_ogrn_rows: invalidOgrnRows,
    ogrn_type_mismatch_rows: ogrnTypeMismatchRows,
  };
}
