import type {
  ExistingDirectoryExactOkvedRow,
  FnsExactMatchMethod,
  FnsExactOkvedConflict,
  FnsExactOkvedNoop,
  FnsExactOkvedPlanMetrics,
  FnsExactOkvedSkipped,
  FnsExactOkvedUpdate,
  FnsExactSkippedReason,
} from '@/lib/companiesDirectory/fnsExactPlanTypes';
import {
  FNS_SME_EXACT_OKVED_SOURCE,
} from '@/lib/companiesDirectory/fnsExactPlanTypes';
import {
  validateFnsInn,
  validateFnsOgrn,
  validateFnsOkvedCode,
} from '@/lib/companiesDirectory/fnsSmeXml';

interface SqliteRunResult {
  changes: number | bigint;
}

interface SqliteStatement {
  run(...params: Array<string | number | bigint | null>): SqliteRunResult;
  get(...params: Array<string | number | bigint | null>):
    | Record<string, unknown>
    | undefined;
  iterate(...params: Array<string | number | bigint | null>):
    Iterable<Record<string, unknown>>;
  all(...params: Array<string | number | bigint | null>):
    Array<Record<string, unknown>>;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const DatabaseSync = (
  // Node 22 exposes node:sqlite before our @types/node version does.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('node:sqlite') as {
    DatabaseSync: new (
      path: string,
      options?: {
        enableForeignKeyConstraints?: boolean;
        timeout?: number;
      },
    ) => SqliteDatabase;
  }
).DatabaseSync;

export interface FnsExactRegistryStoreRow {
  inn: string;
  ogrn: string;
  okved_code_exact: string;
  okved_version: '2001' | '2014';
}

export interface FnsExactIdKeysetCursor {
  idLength: number;
  id: string;
}

const FNS_EXACT_ARTIFACT_PAGE_SIZE = 10_000;
const MAX_FNS_EXACT_ARTIFACT_PAGE_SIZE = 20_000;

function compareIdToCursor(
  id: string,
  cursor: FnsExactIdKeysetCursor,
): number {
  if (id.length !== cursor.idLength) {
    return id.length < cursor.idLength ? -1 : 1;
  }
  if (id === cursor.id) return 0;
  return id < cursor.id ? -1 : 1;
}

export function* iterateFnsExactKeysetPages<
  Row extends Record<string, unknown> & { id: unknown },
>(
  loadPage: (
    cursor: Readonly<FnsExactIdKeysetCursor>,
    limit: number,
  ) => readonly Row[],
  pageSize = FNS_EXACT_ARTIFACT_PAGE_SIZE,
): IterableIterator<Row> {
  if (
    !Number.isSafeInteger(pageSize)
    || pageSize < 1
    || pageSize > MAX_FNS_EXACT_ARTIFACT_PAGE_SIZE
  ) {
    throw new Error('FNS exact artifact page size must be between 1 and 20000');
  }

  let cursor: FnsExactIdKeysetCursor = { idLength: 0, id: '' };
  while (true) {
    const page = loadPage({ ...cursor }, pageSize);
    if (!Array.isArray(page)) {
      throw new Error('FNS exact artifact page loader must return an array');
    }
    if (page.length > pageSize) {
      throw new Error('FNS exact artifact page exceeds its requested limit');
    }
    if (page.length === 0) return;

    for (const row of page) {
      const id = String(row.id ?? '');
      if (!/^\d+$/.test(id) || BigInt(id) < BigInt(1)) {
        throw new Error(`Invalid paged FNS exact target id: ${id}`);
      }
      if (compareIdToCursor(id, cursor) <= 0) {
        throw new Error(
          `FNS exact artifact page is not strictly ordered after id ${cursor.id}`,
        );
      }
      cursor = { idLength: id.length, id };
      yield row;
    }

    if (page.length < pageSize) return;
  }
}

function taxpayerTypeForInn(
  inn: string,
): 'legal_entity' | 'individual_entrepreneur' {
  if (inn.length === 10) return 'legal_entity';
  if (inn.length === 12) return 'individual_entrepreneur';
  throw new Error(`Invalid INN length: ${inn}`);
}

function isValidInn(inn: string): boolean {
  try {
    validateFnsInn(inn, taxpayerTypeForInn(inn));
    return true;
  } catch {
    return false;
  }
}

function assertValidInn(inn: string): void {
  try {
    validateFnsInn(inn, taxpayerTypeForInn(inn));
  } catch (error) {
    throw new Error(
      `Invalid INN: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function targetOgrnStatus(
  inn: string,
  ogrn: string | null,
): 'absent' | 'valid' | 'invalid' {
  if (ogrn === null || ogrn.trim() === '') return 'absent';
  if (!isValidInn(inn)) return 'invalid';
  try {
    validateFnsOgrn(ogrn, taxpayerTypeForInn(inn));
    return 'valid';
  } catch {
    return 'invalid';
  }
}

function countFromRow(
  row: Record<string, unknown> | undefined,
  field = 'count',
): number {
  const count = Number(row?.[field]);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Invalid SQLite plan count: ${String(row?.[field])}`);
  }
  return count;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function matchMethod(value: unknown): FnsExactMatchMethod {
  if (value === 'ogrn_inn' || value === 'unique_inn_fallback') {
    return value;
  }
  throw new Error(`Invalid SQLite match method: ${String(value)}`);
}

function skippedReason(value: unknown): FnsExactSkippedReason {
  const reasons: FnsExactSkippedReason[] = [
    'invalid_target_inn',
    'invalid_target_ogrn',
    'ogrn_not_found',
    'ogrn_inn_mismatch',
    'inn_not_found',
    'ambiguous_inn_multiple_ogrn',
    'legacy_okved_2001',
  ];
  if (reasons.includes(value as FnsExactSkippedReason)) {
    return value as FnsExactSkippedReason;
  }
  throw new Error(`Invalid SQLite skipped reason: ${String(value)}`);
}

export class FnsExactPlanStore {
  private readonly database: SqliteDatabase;
  private readonly insertExisting: SqliteStatement;
  private readonly insertRegistry: SqliteStatement;
  private readonly selectRegistry: SqliteStatement;
  private activeTransaction: 'snapshot' | 'registry' | null = null;
  private registryRows = 0;
  private closed = false;

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
      timeout: 30_000,
    });
    this.database.exec(`
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
PRAGMA temp_store = FILE;
PRAGMA cache_size = -131072;
CREATE TABLE existing_company (
  id text PRIMARY KEY NOT NULL,
  inn text NOT NULL,
  inn_status text NOT NULL CHECK (inn_status IN ('valid', 'invalid')),
  expected_ogrn text,
  ogrn_status text NOT NULL CHECK (
    ogrn_status IN ('absent', 'valid', 'invalid')
  ),
  okved_code_exact text,
  okved_exact_source text
) WITHOUT ROWID;
CREATE INDEX existing_company_inn_idx ON existing_company (inn);
CREATE INDEX existing_company_ogrn_idx ON existing_company (expected_ogrn);
CREATE TABLE registry_exact (
  ogrn text PRIMARY KEY NOT NULL,
  inn text NOT NULL,
  okved_code_exact text NOT NULL,
  okved_version text NOT NULL CHECK (okved_version IN ('2001', '2014'))
) WITHOUT ROWID;
CREATE INDEX registry_exact_inn_idx ON registry_exact (inn);
`.trim());
    this.insertExisting = this.database.prepare(`
INSERT INTO existing_company (
  id,
  inn,
  inn_status,
  expected_ogrn,
  ogrn_status,
  okved_code_exact,
  okved_exact_source
) VALUES (?, ?, ?, ?, ?, ?, ?)
`.trim());
    this.insertRegistry = this.database.prepare(`
INSERT OR IGNORE INTO registry_exact (
  ogrn,
  inn,
  okved_code_exact,
  okved_version
) VALUES (?, ?, ?, ?)
`.trim());
    this.selectRegistry = this.database.prepare(`
SELECT inn, okved_code_exact, okved_version
FROM registry_exact
WHERE ogrn = ?
`.trim());
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('FNS exact plan store is closed');
    }
  }

  private begin(kind: 'snapshot' | 'registry'): void {
    this.assertOpen();
    if (this.activeTransaction !== null) {
      throw new Error(
        `Cannot begin ${kind}; ${this.activeTransaction} transaction is active`,
      );
    }
    this.database.exec('BEGIN IMMEDIATE');
    this.activeTransaction = kind;
  }

  private commit(kind: 'snapshot' | 'registry'): void {
    this.assertOpen();
    if (this.activeTransaction !== kind) {
      throw new Error(`No active ${kind} transaction`);
    }
    this.database.exec('COMMIT');
    this.activeTransaction = null;
  }

  private rollback(kind: 'snapshot' | 'registry'): void {
    this.assertOpen();
    if (this.activeTransaction !== kind) {
      throw new Error(`No active ${kind} transaction`);
    }
    this.database.exec('ROLLBACK');
    this.activeTransaction = null;
  }

  beginSnapshot(): void {
    this.begin('snapshot');
  }

  addExisting(row: ExistingDirectoryExactOkvedRow): void {
    this.assertOpen();
    if (this.activeTransaction !== 'snapshot') {
      throw new Error('Existing rows require an active snapshot transaction');
    }
    const id = String(row.id);
    if (!/^\d+$/.test(id) || BigInt(id) < BigInt(1)) {
      throw new Error(`Invalid existing company id: ${id}`);
    }
    if (!row.inn) {
      throw new Error('Existing company INN is empty');
    }
    const innStatus = isValidInn(row.inn) ? 'valid' : 'invalid';
    this.insertExisting.run(
      id,
      row.inn,
      innStatus,
      row.ogrn,
      targetOgrnStatus(row.inn, row.ogrn),
      row.okved_code_exact,
      row.okved_exact_source,
    );
  }

  commitSnapshot(): void {
    this.commit('snapshot');
  }

  rollbackSnapshot(): void {
    this.rollback('snapshot');
  }

  beginRegistry(): void {
    this.begin('registry');
  }

  addRegistry(
    row: FnsExactRegistryStoreRow,
  ): 'added' | 'duplicate_same' {
    this.assertOpen();
    if (this.activeTransaction !== 'registry') {
      throw new Error('Registry rows require an active registry transaction');
    }
    const taxpayerType = taxpayerTypeForInn(row.inn);
    assertValidInn(row.inn);
    validateFnsOgrn(row.ogrn, taxpayerType);
    validateFnsOkvedCode(row.okved_code_exact);
    this.registryRows += 1;
    const inserted = this.insertRegistry.run(
      row.ogrn,
      row.inn,
      row.okved_code_exact,
      row.okved_version,
    );
    if (Number(inserted.changes) === 1) {
      return 'added';
    }
    const existing = this.selectRegistry.get(row.ogrn);
    if (
      existing?.inn !== row.inn
      || existing?.okved_code_exact !== row.okved_code_exact
      || existing?.okved_version !== row.okved_version
    ) {
      throw new Error(
        `Conflicting registry identity values for OGRN ${row.ogrn}`,
      );
    }
    return 'duplicate_same';
  }

  private buildMatchTables(): void {
    this.database.exec(`
CREATE TABLE registry_inn_summary AS
SELECT
  inn,
  COUNT(*) AS identity_count,
  SUM(CASE WHEN okved_version = '2014' THEN 1 ELSE 0 END)
    AS okved_2014_count,
  MIN(ogrn) AS only_ogrn,
  MIN(CASE WHEN okved_version = '2014' THEN okved_code_exact END)
    AS only_okved_2014
FROM registry_exact
GROUP BY inn;
CREATE UNIQUE INDEX registry_inn_summary_inn_idx
  ON registry_inn_summary (inn);

CREATE TABLE directory_match AS
SELECT
  e.id,
  e.inn,
  e.expected_ogrn,
  e.okved_code_exact,
  e.okved_exact_source,
  CASE
    WHEN e.inn_status = 'valid'
      AND e.ogrn_status = 'valid'
      AND by_ogrn.inn = e.inn
      AND by_ogrn.okved_version = '2014'
      THEN by_ogrn.ogrn
    WHEN e.inn_status = 'valid'
      AND e.ogrn_status = 'absent'
      AND by_inn.identity_count = 1
      AND by_inn.okved_2014_count = 1
      THEN by_inn.only_ogrn
    ELSE NULL
  END AS fns_ogrn,
  CASE
    WHEN e.inn_status = 'valid'
      AND e.ogrn_status = 'valid'
      AND by_ogrn.inn = e.inn
      AND by_ogrn.okved_version = '2014'
      THEN by_ogrn.okved_code_exact
    WHEN e.inn_status = 'valid'
      AND e.ogrn_status = 'absent'
      AND by_inn.identity_count = 1
      AND by_inn.okved_2014_count = 1
      THEN by_inn.only_okved_2014
    ELSE NULL
  END AS incoming_okved_code_exact,
  CASE
    WHEN e.inn_status = 'valid'
      AND e.ogrn_status = 'valid'
      AND by_ogrn.inn = e.inn
      AND by_ogrn.okved_version = '2014'
      THEN 'ogrn_inn'
    WHEN e.inn_status = 'valid'
      AND e.ogrn_status = 'absent'
      AND by_inn.identity_count = 1
      AND by_inn.okved_2014_count = 1
      THEN 'unique_inn_fallback'
    ELSE NULL
  END AS match_method,
  CASE
    WHEN e.inn_status = 'invalid'
      THEN 'invalid_target_inn'
    WHEN e.ogrn_status = 'invalid'
      THEN 'invalid_target_ogrn'
    WHEN e.ogrn_status = 'valid' AND by_ogrn.ogrn IS NULL
      THEN 'ogrn_not_found'
    WHEN e.ogrn_status = 'valid' AND by_ogrn.inn <> e.inn
      THEN 'ogrn_inn_mismatch'
    WHEN e.ogrn_status = 'valid' AND by_ogrn.okved_version = '2001'
      THEN 'legacy_okved_2001'
    WHEN e.ogrn_status = 'absent' AND by_inn.inn IS NULL
      THEN 'inn_not_found'
    WHEN e.ogrn_status = 'absent' AND by_inn.identity_count > 1
      THEN 'ambiguous_inn_multiple_ogrn'
    WHEN e.ogrn_status = 'absent' AND by_inn.okved_2014_count = 0
      THEN 'legacy_okved_2001'
    ELSE NULL
  END AS skip_reason
FROM existing_company e
LEFT JOIN registry_exact by_ogrn
  ON e.ogrn_status = 'valid'
 AND by_ogrn.ogrn = e.expected_ogrn
LEFT JOIN registry_inn_summary by_inn
  ON e.ogrn_status = 'absent'
 AND by_inn.inn = e.inn;
CREATE UNIQUE INDEX directory_match_id_idx ON directory_match (id);
CREATE INDEX directory_match_inn_idx ON directory_match (inn);
CREATE INDEX directory_match_fns_ogrn_idx ON directory_match (fns_ogrn);
`.trim());
  }

  commitRegistry(): void {
    this.assertOpen();
    if (this.activeTransaction !== 'registry') {
      throw new Error('No active registry transaction');
    }
    this.buildMatchTables();
    this.commit('registry');
    this.database.exec('ANALYZE');
  }

  rollbackRegistry(): void {
    this.rollback('registry');
  }

  private *iterateArtifactRows(
    filteredSelectSql: string,
  ): IterableIterator<Record<string, unknown> & { id: unknown }> {
    this.assertOpen();
    const pagedSql = `${filteredSelectSql}
  AND (
    LENGTH(id) > ?
    OR (LENGTH(id) = ? AND id > ?)
  )
ORDER BY LENGTH(id), id
LIMIT ?`;
    yield* iterateFnsExactKeysetPages(
      (cursor, limit) => this.database.prepare(pagedSql).all(
        cursor.idLength,
        cursor.idLength,
        cursor.id,
        limit,
      ) as Array<Record<string, unknown> & { id: unknown }>,
    );
  }

  *iterateUpdates(): IterableIterator<FnsExactOkvedUpdate> {
    for (const row of this.iterateArtifactRows(`
SELECT
  id,
  inn,
  expected_ogrn,
  fns_ogrn,
  match_method,
  incoming_okved_code_exact
FROM directory_match
WHERE fns_ogrn IS NOT NULL
  AND okved_code_exact IS NULL
  AND okved_exact_source IS NULL
`.trim())) {
      yield {
        id: String(row.id),
        inn: String(row.inn),
        expected_ogrn: nullableText(row.expected_ogrn),
        fns_ogrn: String(row.fns_ogrn),
        match_method: matchMethod(row.match_method),
        okved_code_exact: String(row.incoming_okved_code_exact),
        okved_exact_source: FNS_SME_EXACT_OKVED_SOURCE,
      };
    }
  }

  *iterateNoops(): IterableIterator<FnsExactOkvedNoop> {
    for (const row of this.iterateArtifactRows(`
SELECT id, inn, expected_ogrn, fns_ogrn, match_method
FROM directory_match
WHERE fns_ogrn IS NOT NULL
  AND okved_code_exact = incoming_okved_code_exact
`.trim())) {
      yield {
        id: String(row.id),
        inn: String(row.inn),
        expected_ogrn: nullableText(row.expected_ogrn),
        fns_ogrn: String(row.fns_ogrn),
        match_method: matchMethod(row.match_method),
        reason: 'already_exact',
      };
    }
  }

  *iterateConflicts(): IterableIterator<FnsExactOkvedConflict> {
    for (const row of this.iterateArtifactRows(`
SELECT
  id,
  inn,
  expected_ogrn,
  fns_ogrn,
  match_method,
  okved_code_exact AS existing_okved_code_exact,
  okved_exact_source AS existing_okved_exact_source,
  incoming_okved_code_exact
FROM directory_match
WHERE fns_ogrn IS NOT NULL
  AND NOT (
    okved_code_exact IS NULL
    AND okved_exact_source IS NULL
  )
  AND (
    okved_code_exact IS NULL
    OR okved_code_exact <> incoming_okved_code_exact
  )
`.trim())) {
      yield {
        id: String(row.id),
        inn: String(row.inn),
        expected_ogrn: nullableText(row.expected_ogrn),
        fns_ogrn: String(row.fns_ogrn),
        match_method: matchMethod(row.match_method),
        kind: 'existing_exact_preserved',
        existing_okved_code_exact:
          nullableText(row.existing_okved_code_exact),
        existing_okved_exact_source:
          nullableText(row.existing_okved_exact_source),
        incoming_okved_code_exact:
          String(row.incoming_okved_code_exact),
        incoming_okved_exact_source: FNS_SME_EXACT_OKVED_SOURCE,
      };
    }
  }

  *iterateSkipped(): IterableIterator<FnsExactOkvedSkipped> {
    for (const row of this.iterateArtifactRows(`
SELECT id, inn, expected_ogrn, skip_reason
FROM directory_match
WHERE fns_ogrn IS NULL
  AND skip_reason IS NOT NULL
  AND okved_code_exact IS NULL
  AND okved_exact_source IS NULL
`.trim())) {
      yield {
        id: String(row.id),
        inn: String(row.inn),
        expected_ogrn: nullableText(row.expected_ogrn),
        reason: skippedReason(row.skip_reason),
      };
    }
  }

  metrics(): FnsExactOkvedPlanMetrics {
    this.assertOpen();
    const counts = this.database.prepare(`
SELECT
  (SELECT COUNT(*) FROM registry_exact) AS unique_registry_ogrns,
  (SELECT COUNT(DISTINCT inn) FROM registry_exact) AS unique_registry_inns,
  (SELECT COUNT(*) FROM existing_company) AS directory_rows,
  (
    SELECT COUNT(*) FROM directory_match WHERE fns_ogrn IS NOT NULL
  ) AS matched_directory_rows,
  (
    SELECT COUNT(DISTINCT inn)
    FROM directory_match
    WHERE fns_ogrn IS NOT NULL
  ) AS unique_matched_inns,
  (
    SELECT COUNT(*)
    FROM directory_match
    WHERE match_method = 'ogrn_inn'
  ) AS matched_by_ogrn_rows,
  (
    SELECT COUNT(*)
    FROM directory_match
    WHERE match_method = 'unique_inn_fallback'
  ) AS matched_by_unique_inn_rows,
  (
    SELECT COUNT(*)
    FROM directory_match
    WHERE fns_ogrn IS NOT NULL
      AND okved_code_exact IS NULL
      AND okved_exact_source IS NULL
  ) AS updates,
  (
    SELECT COUNT(*)
    FROM directory_match
    WHERE fns_ogrn IS NOT NULL
      AND okved_code_exact = incoming_okved_code_exact
  ) AS noops,
  (
    SELECT COUNT(*)
    FROM directory_match
    WHERE fns_ogrn IS NOT NULL
      AND NOT (
        okved_code_exact IS NULL
        AND okved_exact_source IS NULL
      )
      AND (
        okved_code_exact IS NULL
        OR okved_code_exact <> incoming_okved_code_exact
      )
  ) AS conflicts,
  (
    SELECT COUNT(*)
    FROM directory_match
    WHERE fns_ogrn IS NULL
      AND skip_reason IS NOT NULL
      AND okved_code_exact IS NULL
      AND okved_exact_source IS NULL
  ) AS skipped,
  (
    SELECT COUNT(*)
    FROM registry_exact r
    WHERE r.okved_version = '2014'
      AND NOT EXISTS (
        SELECT 1
        FROM directory_match d
        WHERE d.fns_ogrn = r.ogrn
      )
  ) AS registry_not_in_target,
  (
    SELECT COUNT(*) FROM registry_exact WHERE okved_version = '2001'
  ) AS okved_2001_quarantined,
  (
    SELECT COUNT(*)
    FROM registry_inn_summary
    WHERE identity_count > 1
  ) AS registry_multi_registration_inns,
  (
    SELECT COUNT(*)
    FROM directory_match
    WHERE skip_reason = 'invalid_target_inn'
      AND okved_code_exact IS NULL
      AND okved_exact_source IS NULL
  ) AS invalid_target_inn_quarantined,
  (
    SELECT COUNT(*)
    FROM directory_match
    WHERE skip_reason = 'invalid_target_ogrn'
      AND okved_code_exact IS NULL
      AND okved_exact_source IS NULL
  ) AS invalid_target_ogrn_quarantined,
  (
    SELECT COUNT(*)
    FROM directory_match
    WHERE skip_reason = 'ogrn_not_found'
      AND okved_code_exact IS NULL
      AND okved_exact_source IS NULL
  ) AS ogrn_not_found_quarantined,
  (
    SELECT COUNT(*)
    FROM directory_match
    WHERE skip_reason = 'ogrn_inn_mismatch'
      AND okved_code_exact IS NULL
      AND okved_exact_source IS NULL
  ) AS identity_mismatch_quarantined,
  (
    SELECT COUNT(*)
    FROM directory_match
    WHERE skip_reason = 'inn_not_found'
      AND okved_code_exact IS NULL
      AND okved_exact_source IS NULL
  ) AS inn_not_found_quarantined,
  (
    SELECT COUNT(*)
    FROM directory_match
    WHERE skip_reason = 'ambiguous_inn_multiple_ogrn'
      AND okved_code_exact IS NULL
      AND okved_exact_source IS NULL
  ) AS ambiguous_inn_quarantined,
  (
    SELECT COUNT(*)
    FROM directory_match
    WHERE skip_reason = 'legacy_okved_2001'
      AND okved_code_exact IS NULL
      AND okved_exact_source IS NULL
  ) AS legacy_okved_2001_target_quarantined
`.trim()).get();

    return {
      registry_rows: this.registryRows,
      unique_registry_ogrns:
        countFromRow(counts, 'unique_registry_ogrns'),
      unique_registry_inns: countFromRow(counts, 'unique_registry_inns'),
      directory_rows: countFromRow(counts, 'directory_rows'),
      matched_directory_rows:
        countFromRow(counts, 'matched_directory_rows'),
      unique_matched_inns: countFromRow(counts, 'unique_matched_inns'),
      matched_by_ogrn_rows:
        countFromRow(counts, 'matched_by_ogrn_rows'),
      matched_by_unique_inn_rows:
        countFromRow(counts, 'matched_by_unique_inn_rows'),
      updates: countFromRow(counts, 'updates'),
      noops: countFromRow(counts, 'noops'),
      conflicts: countFromRow(counts, 'conflicts'),
      skipped: countFromRow(counts, 'skipped'),
      inserts: 0,
      registry_not_in_target:
        countFromRow(counts, 'registry_not_in_target'),
      okved_2001_quarantined:
        countFromRow(counts, 'okved_2001_quarantined'),
      registry_multi_registration_inns:
        countFromRow(counts, 'registry_multi_registration_inns'),
      invalid_target_inn_quarantined:
        countFromRow(counts, 'invalid_target_inn_quarantined'),
      invalid_target_ogrn_quarantined:
        countFromRow(counts, 'invalid_target_ogrn_quarantined'),
      ogrn_not_found_quarantined:
        countFromRow(counts, 'ogrn_not_found_quarantined'),
      identity_mismatch_quarantined:
        countFromRow(counts, 'identity_mismatch_quarantined'),
      inn_not_found_quarantined:
        countFromRow(counts, 'inn_not_found_quarantined'),
      ambiguous_inn_quarantined:
        countFromRow(counts, 'ambiguous_inn_quarantined'),
      legacy_okved_2001_target_quarantined:
        countFromRow(counts, 'legacy_okved_2001_target_quarantined'),
    };
  }

  checkIdempotency(): {
    firstPassUpdates: number;
    repeatedUpdates: number;
    passed: boolean;
  } {
    this.assertOpen();
    if (this.activeTransaction !== null) {
      throw new Error('Cannot check idempotency inside an active transaction');
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const applied = this.database.prepare(`
UPDATE existing_company
SET
  okved_code_exact = (
    SELECT d.incoming_okved_code_exact
    FROM directory_match d
    WHERE d.id = existing_company.id
  ),
  okved_exact_source = '${FNS_SME_EXACT_OKVED_SOURCE}'
WHERE okved_code_exact IS NULL
  AND okved_exact_source IS NULL
  AND EXISTS (
    SELECT 1
    FROM directory_match d
    WHERE d.id = existing_company.id
      AND d.fns_ogrn IS NOT NULL
  )
`.trim()).run();
      const repeated = countFromRow(this.database.prepare(`
SELECT COUNT(*) AS count
FROM existing_company e
JOIN directory_match d ON d.id = e.id
WHERE d.fns_ogrn IS NOT NULL
  AND e.okved_code_exact IS NULL
  AND e.okved_exact_source IS NULL
`.trim()).get());
      const firstPassUpdates = Number(applied.changes);
      return {
        firstPassUpdates,
        repeatedUpdates: repeated,
        passed: repeated === 0,
      };
    } finally {
      this.database.exec('ROLLBACK');
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.activeTransaction !== null) {
      this.database.exec('ROLLBACK');
      this.activeTransaction = null;
    }
    this.database.close();
    this.closed = true;
  }
}
