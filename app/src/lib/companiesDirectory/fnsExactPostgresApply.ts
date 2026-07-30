import { once } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  assertFnsExactPreviewIsSafe,
  computeFnsExactPreviewFingerprint,
  type FnsExactApplyPageResult,
  type FnsExactApplySession,
  type FnsExactImportPreview,
  type FnsExactImportPreviewBody,
} from '@/lib/companiesDirectory/fnsExactApply';
import {
  beginImportTransaction,
  verifyPortalCompaniesDirectoryIdentity,
  type ImportPgClient,
  type ImportPgQueryResult,
} from '@/lib/companiesDirectory/postgresImportCore';

export type FnsExactPgQueryResult = ImportPgQueryResult;
export interface FnsExactPgClient extends ImportPgClient {
  copyFrom?(
    sql: string,
    rows: AsyncIterable<string>,
  ): Promise<number>;
}

interface FnsExactStageCallbacks {
  onUpdateBatch(rows: Record<string, unknown>[]): Promise<void>;
}

interface FnsExactPostgresApplySessionOptions {
  client: FnsExactPgClient;
  expectedPlanFingerprint: string;
  processArtifacts(
    callbacks: FnsExactStageCallbacks,
  ): Promise<{ planFingerprint: string; updateRows?: number }>;
}

export interface FnsExactBatchPage {
  fromExclusive: string | null;
  toInclusive: string;
  rowCount: number;
}

const STAGE_TABLE = 'fns_exact_okved_import_stage';
const FNS_SOURCE = 'fns_sme_registry';
const POSTGRES_BIGINT_MAX = BigInt('9223372036854775807');

const CREATE_STAGE_SQL = `
CREATE TEMP TABLE ${STAGE_TABLE} (
  id bigint PRIMARY KEY,
  inn text NOT NULL,
  expected_ogrn text,
  fns_ogrn text NOT NULL,
  match_method text NOT NULL CHECK (
    match_method IN ('ogrn_inn', 'unique_inn_fallback')
  ),
  okved_code_exact text NOT NULL,
  okved_exact_source text NOT NULL CHECK (
    okved_exact_source = '${FNS_SOURCE}'
  ),
  CHECK (
    (
      match_method = 'ogrn_inn'
      AND expected_ogrn IS NOT NULL
      AND btrim(expected_ogrn) = fns_ogrn
    )
    OR (
      match_method = 'unique_inn_fallback'
      AND (
        expected_ogrn IS NULL
        OR btrim(expected_ogrn) = ''
      )
    )
  ),
  CHECK (
    (length(inn) = 10 AND length(fns_ogrn) = 13)
    OR (length(inn) = 12 AND length(fns_ogrn) = 15)
  )
) ON COMMIT PRESERVE ROWS
`.trim();

const COPY_STAGE_SQL = `
COPY ${STAGE_TABLE} (
  id,
  inn,
  expected_ogrn,
  fns_ogrn,
  match_method,
  okved_code_exact,
  okved_exact_source
)
FROM STDIN WITH (FORMAT csv, NULL '\\N')
`.trim();

const GLOBAL_STAGE_FILTER = 'TRUE';
const PAGE_STAGE_FILTER = `
($1::bigint IS NULL OR s.id > $1::bigint)
AND s.id <= $2::bigint
`.trim();

function previewSql(stageFilter: string): string {
  return `
WITH current_state AS (
  SELECT
    s.id AS expected_id,
    s.inn,
    s.expected_ogrn,
    s.fns_ogrn,
    s.match_method,
    s.okved_code_exact AS incoming_okved,
    s.okved_exact_source AS incoming_source,
    by_id.id AS found_id,
    c.id,
    c.okved_code_exact,
    c.okved_exact_source,
    (
      c.id IS NOT NULL
      AND c.okved_code_exact IS NULL
      AND c.okved_exact_source IS NULL
    ) AS needs_update,
    (
      c.id IS NOT NULL
      AND c.okved_code_exact = s.okved_code_exact
      AND c.okved_exact_source = '${FNS_SOURCE}'
    ) AS is_applied,
    hashtextextended(
      JSONB_BUILD_ARRAY(
        s.id,
        s.inn,
        s.expected_ogrn,
        s.fns_ogrn,
        s.match_method,
        s.okved_code_exact,
        s.okved_exact_source,
        by_id.id,
        by_id.inn,
        by_id.ogrn,
        by_id.okved_code_exact,
        by_id.okved_exact_source,
        c.id,
        c.inn,
        c.ogrn,
        c.okved_code_exact,
        c.okved_exact_source
      )::text,
      0
    ) AS decision_hash
  FROM ${STAGE_TABLE} s
  LEFT JOIN public.companies_directory by_id
    ON by_id.id = s.id
  LEFT JOIN public.companies_directory c
    ON c.id = s.id
   AND c.inn = s.inn
   AND c.ogrn IS NOT DISTINCT FROM s.expected_ogrn
  WHERE ${stageFilter}
),
classified AS (
  SELECT
    *,
    (found_id IS NULL) AS is_missing,
    (found_id IS NOT NULL AND id IS NULL) AS has_identity_mismatch,
    (
      id IS NOT NULL
      AND NOT needs_update
      AND NOT is_applied
    ) AS has_conflict
  FROM current_state
),
aggregate_state AS (
  SELECT
    COUNT(*) AS staged_updates,
    COUNT(*) FILTER (WHERE needs_update) AS rows_to_update,
    COUNT(*) FILTER (WHERE is_applied) AS already_applied,
    COUNT(*) FILTER (WHERE is_missing) AS missing_targets,
    COUNT(*) FILTER (
      WHERE has_identity_mismatch
    ) AS identity_mismatches,
    COUNT(*) FILTER (WHERE has_conflict) AS conflicting_values,
    COALESCE(BIT_XOR(decision_hash), 0) AS hash_xor,
    COALESCE(SUM(decision_hash::numeric), 0) AS hash_sum
  FROM classified
)
SELECT
  staged_updates,
  rows_to_update,
  already_applied,
  missing_targets,
  identity_mismatches,
  conflicting_values,
  (
    MD5(
      staged_updates::text || ':' || rows_to_update::text || ':'
      || already_applied::text || ':' || missing_targets::text || ':'
      || identity_mismatches::text || ':' || conflicting_values::text
    )
    || MD5(hash_xor::text || ':' || hash_sum::text)
  ) AS state_digest
FROM aggregate_state
`.trim();
}

const PREVIEW_SQL = previewSql(GLOBAL_STAGE_FILTER);
const PAGE_PREVIEW_SQL = previewSql(PAGE_STAGE_FILTER);

const NEXT_PAGE_SQL = `
WITH page AS (
  SELECT s.id
  FROM ${STAGE_TABLE} s
  WHERE ($1::bigint IS NULL OR s.id > $1::bigint)
  ORDER BY s.id
  LIMIT $2
)
SELECT
  $1::text AS from_exclusive,
  MAX(id)::text AS to_inclusive,
  COUNT(*)::text AS row_count
FROM page
`.trim();

const LOCK_PAGE_TARGETS_SQL = `
SELECT c.id::text AS id
FROM ${STAGE_TABLE} s
JOIN public.companies_directory c
  ON c.id = s.id
WHERE ($1::bigint IS NULL OR s.id > $1::bigint)
  AND s.id <= $2::bigint
ORDER BY s.id
FOR UPDATE OF c
`.trim();

const UPDATE_PAGE_SQL = `
UPDATE public.companies_directory c
SET
  okved_code_exact = s.okved_code_exact,
  okved_exact_source = s.okved_exact_source
FROM ${STAGE_TABLE} s
WHERE ($1::bigint IS NULL OR s.id > $1::bigint)
  AND s.id <= $2::bigint
  AND c.id = s.id
  AND c.inn = s.inn
  AND c.ogrn IS NOT DISTINCT FROM s.expected_ogrn
  AND c.okved_code_exact IS NULL
  AND c.okved_exact_source IS NULL
  AND s.okved_exact_source = '${FNS_SOURCE}'
`.trim();

function integerFromRow(
  row: Record<string, unknown>,
  field: string,
): number {
  const value = Number(row[field]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Invalid FNS exact preview field ${field}: ${String(row[field])}`,
    );
  }
  return value;
}

function previewFromResult(
  result: FnsExactPgQueryResult,
): FnsExactImportPreview {
  const row = result.rows[0];
  if (!row) {
    throw new Error('FNS exact live preview returned no row');
  }
  const stateDigest = String(row.state_digest ?? '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(stateDigest)) {
    throw new Error('FNS exact live preview returned an invalid state digest');
  }
  const body = {
    stagedUpdates: integerFromRow(row, 'staged_updates'),
    rowsToUpdate: integerFromRow(row, 'rows_to_update'),
    alreadyApplied: integerFromRow(row, 'already_applied'),
    missingTargets: integerFromRow(row, 'missing_targets'),
    identityMismatches: integerFromRow(row, 'identity_mismatches'),
    conflictingValues: integerFromRow(row, 'conflicting_values'),
    stateDigest,
  };
  return {
    ...body,
    fingerprint: computeFnsExactPreviewFingerprint(body),
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function csvField(value: unknown, field: string): string {
  if (value === null && field === 'expected_ogrn') {
    return '\\N';
  }
  if (typeof value !== 'string') {
    throw new Error(`FNS exact COPY field ${field} must be text`);
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function encodeCopyRow(row: Record<string, unknown>): string {
  return [
    csvField(row.id, 'id'),
    csvField(row.inn, 'inn'),
    csvField(row.expected_ogrn, 'expected_ogrn'),
    csvField(row.fns_ogrn, 'fns_ogrn'),
    csvField(row.match_method, 'match_method'),
    csvField(row.okved_code_exact, 'okved_code_exact'),
    csvField(row.okved_exact_source, 'okved_exact_source'),
  ].join(',') + '\n';
}

function validateCursor(value: string | null, label: string): void {
  if (value === null) return;
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid FNS ${label}: ${value}`);
  }
  const parsed = BigInt(value);
  if (parsed < BigInt(1) || parsed > POSTGRES_BIGINT_MAX) {
    throw new Error(`Invalid FNS ${label}: ${value}`);
  }
}

function validatePageLimit(limit: number): void {
  if (
    !Number.isSafeInteger(limit)
    || limit < 1
    || limit > 100_000
  ) {
    throw new Error(
      'FNS exact page limit must be between 1 and 100000',
    );
  }
}

function validatePage(page: FnsExactBatchPage): void {
  validateCursor(page.fromExclusive, 'page start cursor');
  validateCursor(page.toInclusive, 'page end cursor');
  validatePageLimit(page.rowCount);
  if (
    page.fromExclusive !== null
    && BigInt(page.toInclusive) <= BigInt(page.fromExclusive)
  ) {
    throw new Error('FNS exact page cursor did not advance');
  }
}

function pageValues(page: FnsExactBatchPage): [string | null, string] {
  validatePage(page);
  return [page.fromExclusive, page.toInclusive];
}

export class FnsExactPostgresApplySession implements FnsExactApplySession {
  private readonly client: FnsExactPgClient;
  private readonly expectedPlanFingerprint: string;
  private readonly processArtifacts: (
    callbacks: FnsExactStageCallbacks,
  ) => Promise<{ planFingerprint: string; updateRows?: number }>;
  private stageTablePrepared = false;
  private stageLoaded = false;
  private stageAnalyzed = false;
  private sessionLockAcquired = false;

  constructor(options: FnsExactPostgresApplySessionOptions) {
    this.client = options.client;
    this.expectedPlanFingerprint =
      options.expectedPlanFingerprint.toLowerCase();
    this.processArtifacts = options.processArtifacts;
  }

  private async prepareStageTable(): Promise<void> {
    if (this.stageTablePrepared) return;
    await this.client.query(CREATE_STAGE_SQL);
    this.stageTablePrepared = true;
  }

  async beginReadOnly(): Promise<void> {
    await this.prepareStageTable();
    await beginImportTransaction(this.client, 'BEGIN READ ONLY', {
      lockTimeout: '30s',
      statementTimeout: '30min',
      idleTimeout: '2h',
    });
  }

  async beginReadWrite(): Promise<void> {
    await this.beginReadWriteBatch();
  }

  async beginReadWriteBatch(): Promise<void> {
    await this.prepareStageTable();
    if (this.stageLoaded && !this.stageAnalyzed) {
      await this.client.query(`ANALYZE ${STAGE_TABLE}`);
      this.stageAnalyzed = true;
    }
    await beginImportTransaction(this.client, 'BEGIN READ WRITE', {
      lockTimeout: '30s',
      statementTimeout: '30min',
      idleTimeout: '10min',
    });
  }

  async acquireSessionAdvisoryLock(): Promise<void> {
    if (this.sessionLockAcquired) {
      throw new Error('FNS exact advisory lock is already held');
    }
    const result = await this.client.query(`
SELECT pg_try_advisory_lock(
  hashtextextended('companies_directory:fns-exact-okved', 0)
) AS acquired
`.trim());
    if (result.rows[0]?.acquired !== true) {
      throw new Error(
        'Another FNS exact OKVED import holds the advisory lock; try later',
      );
    }
    this.sessionLockAcquired = true;
  }

  async releaseSessionAdvisoryLock(): Promise<void> {
    if (!this.sessionLockAcquired) return;
    const result = await this.client.query(`
SELECT pg_advisory_unlock(
  hashtextextended('companies_directory:fns-exact-okved', 0)
) AS released
`.trim());
    if (result.rows[0]?.released !== true) {
      throw new Error('FNS exact OKVED advisory lock was not released');
    }
    this.sessionLockAcquired = false;
  }

  async stageArtifacts(): Promise<void> {
    await this.prepareStageTable();
    if (this.stageLoaded) {
      throw new Error('FNS exact artifacts were already staged');
    }
    if (!this.client.copyFrom) {
      throw new Error('FNS exact COPY adapter is not configured');
    }

    const rowStream = new PassThrough({
      highWaterMark: 1024 * 1024,
    });
    rowStream.setEncoding('utf8');
    rowStream.on('error', () => undefined);
    let emittedRows = 0;
    let copyFailure: unknown;
    const copyPromise = this.client
      .copyFrom(COPY_STAGE_SQL, rowStream)
      .catch((error: unknown) => {
        copyFailure = error;
        rowStream.destroy(asError(error));
        throw error;
      });
    void copyPromise.catch(() => undefined);
    const copyFailureSignal = copyPromise.then<never>(
      () => new Promise<never>(() => undefined),
      (error: unknown) => {
        throw error;
      },
    );
    void copyFailureSignal.catch(() => undefined);

    try {
      const processed = await this.processArtifacts({
        onUpdateBatch: async (rows) => {
          for (const row of rows) {
            if (copyFailure !== undefined) {
              throw copyFailure;
            }
            if (rowStream.destroyed) {
              throw new Error(
                'FNS exact COPY stream closed before staging completed',
              );
            }
            if (!rowStream.write(encodeCopyRow(row))) {
              await Promise.race([
                once(rowStream, 'drain'),
                copyFailureSignal,
              ]);
            }
            if (copyFailure !== undefined) {
              throw copyFailure;
            }
            emittedRows += 1;
          }
        },
      });
      rowStream.end();
      const copiedRows = await copyPromise;
      if (copiedRows !== emittedRows) {
        throw new Error(
          `Unexpected FNS exact staging count: `
          + `expected ${emittedRows}, got ${String(copiedRows)}`,
        );
      }
      if (
        processed.updateRows !== undefined
        && processed.updateRows !== emittedRows
      ) {
        throw new Error(
          `Validated FNS update count changed while staging: `
          + `expected ${processed.updateRows}, got ${emittedRows}`,
        );
      }
      if (
        processed.planFingerprint.toLowerCase()
        !== this.expectedPlanFingerprint
      ) {
        throw new Error(
          'FNS exact plan fingerprint changed while staging',
        );
      }
      await this.client.query(`ANALYZE ${STAGE_TABLE}`);
      this.stageAnalyzed = true;
      this.stageLoaded = true;
    } catch (error) {
      rowStream.destroy(asError(error));
      await copyPromise.catch(() => undefined);
      throw copyFailure ?? error;
    }
  }

  async preview(): Promise<FnsExactImportPreview> {
    return previewFromResult(await this.client.query(PREVIEW_SQL));
  }

  async nextPage(
    afterId: string | null,
    limit: number,
  ): Promise<FnsExactBatchPage | null> {
    validateCursor(afterId, 'page cursor');
    validatePageLimit(limit);
    const result = await this.client.query(
      NEXT_PAGE_SQL,
      [afterId, limit],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('FNS exact next-page query returned no row');
    }
    const rowCount = integerFromRow(row, 'row_count');
    if (rowCount === 0) return null;
    if (rowCount > limit) {
      throw new Error('FNS exact next-page query exceeded its limit');
    }
    const toInclusive = String(row.to_inclusive ?? '');
    validateCursor(toInclusive, 'page end cursor');
    if (
      afterId !== null
      && BigInt(toInclusive) <= BigInt(afterId)
    ) {
      throw new Error('FNS exact next-page cursor did not advance');
    }
    return {
      fromExclusive: afterId,
      toInclusive,
      rowCount,
    };
  }

  async lockPageTargets(page: FnsExactBatchPage): Promise<number> {
    const result = await this.client.query(
      LOCK_PAGE_TARGETS_SQL,
      pageValues(page),
    );
    return result.rowCount ?? result.rows.length;
  }

  async previewPage(
    page: FnsExactBatchPage,
  ): Promise<FnsExactImportPreviewBody> {
    const preview = previewFromResult(await this.client.query(
      PAGE_PREVIEW_SQL,
      pageValues(page),
    ));
    const { fingerprint: _fingerprint, ...body } = preview;
    return body;
  }

  async verifyAppliedPrefix(
    cursorId: string,
    expectedRows: number,
  ): Promise<void> {
    validateCursor(cursorId, 'checkpoint prefix cursor');
    if (
      !Number.isSafeInteger(expectedRows)
      || expectedRows < 1
    ) {
      throw new Error(
        'FNS checkpoint prefix row count must be a positive integer',
      );
    }
    const preview = previewFromResult(await this.client.query(
      PAGE_PREVIEW_SQL,
      [null, cursorId],
    ));
    assertFnsExactPreviewIsSafe(preview);
    if (
      preview.stagedUpdates !== expectedRows
      || preview.rowsToUpdate !== 0
      || preview.alreadyApplied !== expectedRows
    ) {
      throw new Error(
        'FNS checkpoint prefix is not fully applied',
      );
    }
  }

  async updatePage(page: FnsExactBatchPage): Promise<number> {
    const result = await this.client.query(
      UPDATE_PAGE_SQL,
      pageValues(page),
    );
    return result.rowCount ?? 0;
  }

  async applyNextPage(
    afterCursorId: string | null,
    pageSize: number,
  ): Promise<FnsExactApplyPageResult> {
    const page = await this.nextPage(afterCursorId, pageSize);
    if (!page) {
      throw new Error('FNS exact stage ended before all rows were processed');
    }

    const lockedTargets = await this.lockPageTargets(page);
    const beforeBody = await this.previewPage(page);
    const before = {
      ...beforeBody,
      fingerprint: computeFnsExactPreviewFingerprint(beforeBody),
    };
    assertFnsExactPreviewIsSafe(before);
    if (before.stagedUpdates !== page.rowCount) {
      throw new Error('FNS exact page contains an unexpected number of rows');
    }
    if (lockedTargets !== page.rowCount) {
      throw new Error(
        `Live target is missing ${page.rowCount - lockedTargets} page rows`,
      );
    }

    const updatedRows = await this.updatePage(page);
    if (updatedRows !== before.rowsToUpdate) {
      throw new Error(
        `FNS exact page update count changed: `
        + `expected ${before.rowsToUpdate}, got ${updatedRows}`,
      );
    }

    const afterBody = await this.previewPage(page);
    const after = {
      ...afterBody,
      fingerprint: computeFnsExactPreviewFingerprint(afterBody),
    };
    assertFnsExactPreviewIsSafe(after);
    if (
      after.stagedUpdates !== page.rowCount
      || after.rowsToUpdate !== 0
      || after.alreadyApplied !== page.rowCount
    ) {
      throw new Error('FNS exact page post-update verification failed');
    }

    return {
      scannedRows: page.rowCount,
      updatedRows,
      alreadyAppliedRows: before.alreadyApplied,
      cursorId: page.toInclusive,
    };
  }

  async commit(): Promise<void> {
    await this.client.query('COMMIT');
  }

  async rollback(): Promise<void> {
    await this.client.query('ROLLBACK');
  }
}

export async function verifyFnsExactDatabaseIdentity(
  client: FnsExactPgClient,
): Promise<{
  database: string;
  directoryTable: string;
}> {
  return verifyPortalCompaniesDirectoryIdentity(client);
}
