import {
  computeFnsExactPreviewFingerprint,
  type FnsExactApplySession,
  type FnsExactImportPreview,
} from '@/lib/companiesDirectory/fnsExactApply';
import {
  beginImportTransaction,
  verifyPortalCompaniesDirectoryIdentity,
  type ImportPgClient,
  type ImportPgQueryResult,
} from '@/lib/companiesDirectory/postgresImportCore';

export type FnsExactPgQueryResult = ImportPgQueryResult;
export type FnsExactPgClient = ImportPgClient;

interface FnsExactStageCallbacks {
  onUpdateBatch(rows: Record<string, unknown>[]): Promise<void>;
}

interface FnsExactPostgresApplySessionOptions {
  client: FnsExactPgClient;
  expectedPlanFingerprint: string;
  processArtifacts(
    callbacks: FnsExactStageCallbacks,
  ): Promise<{ planFingerprint: string }>;
}

const STAGE_TABLE = 'fns_exact_okved_import_stage';
const FNS_SOURCE = 'fns_sme_registry';

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
)
`.trim();

const INSERT_STAGE_SQL = `
INSERT INTO ${STAGE_TABLE} (
  id,
  inn,
  expected_ogrn,
  fns_ogrn,
  match_method,
  okved_code_exact,
  okved_exact_source
)
SELECT
  staged.id::bigint,
  staged.inn,
  staged.expected_ogrn,
  staged.fns_ogrn,
  staged.match_method,
  staged.okved_code_exact,
  staged.okved_exact_source
FROM jsonb_to_recordset($1::jsonb) AS staged(
  id text,
  inn text,
  expected_ogrn text,
  fns_ogrn text,
  match_method text,
  okved_code_exact text,
  okved_exact_source text
)
`.trim();

const PREVIEW_SQL = `
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

const UPDATE_BATCH_SQL = `
WITH batch AS (
  SELECT
    c.id,
    c.inn,
    s.expected_ogrn,
    s.okved_code_exact,
    s.okved_exact_source
  FROM ${STAGE_TABLE} s
  JOIN public.companies_directory c
    ON c.id = s.id
   AND c.inn = s.inn
   AND c.ogrn IS NOT DISTINCT FROM s.expected_ogrn
  WHERE c.okved_code_exact IS NULL
    AND c.okved_exact_source IS NULL
    AND s.okved_exact_source = '${FNS_SOURCE}'
  ORDER BY s.inn, s.id
  LIMIT $1
  FOR UPDATE OF c
)
UPDATE public.companies_directory c
SET
  okved_code_exact = batch.okved_code_exact,
  okved_exact_source = batch.okved_exact_source
FROM batch
WHERE c.id = batch.id
  AND c.inn = batch.inn
  AND c.ogrn IS NOT DISTINCT FROM batch.expected_ogrn
  AND c.okved_code_exact IS NULL
  AND c.okved_exact_source IS NULL
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

export class FnsExactPostgresApplySession implements FnsExactApplySession {
  private readonly client: FnsExactPgClient;
  private readonly expectedPlanFingerprint: string;
  private readonly processArtifacts: (
    callbacks: FnsExactStageCallbacks,
  ) => Promise<{ planFingerprint: string }>;
  private stageTablePrepared = false;
  private readOnly = false;

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
    this.readOnly = true;
    await beginImportTransaction(this.client, 'BEGIN READ ONLY', {
      lockTimeout: '30s',
      statementTimeout: '30min',
      idleTimeout: '2h',
    });
  }

  async beginReadWrite(): Promise<void> {
    await this.prepareStageTable();
    this.readOnly = false;
    await beginImportTransaction(this.client, 'BEGIN READ WRITE', {
      lockTimeout: '30s',
      statementTimeout: '30min',
      idleTimeout: '2h',
    });
  }

  async acquireAdvisoryLock(): Promise<void> {
    await this.client.query(`
SELECT pg_advisory_xact_lock(
  hashtextextended('companies_directory:fns-exact-okved', 0)
)
`.trim());
  }

  private async stageBatch(rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0) return;
    const result = await this.client.query(
      INSERT_STAGE_SQL,
      [JSON.stringify(rows)],
    );
    if (result.rowCount !== rows.length) {
      throw new Error(
        `Unexpected FNS exact staging count: `
        + `expected ${rows.length}, got ${String(result.rowCount)}`,
      );
    }
  }

  async stageArtifacts(): Promise<void> {
    if (!this.stageTablePrepared) {
      throw new Error(
        'FNS exact staging table was not prepared before the transaction',
      );
    }
    const processed = await this.processArtifacts({
      onUpdateBatch: async (rows) => this.stageBatch(rows),
    });
    if (
      processed.planFingerprint.toLowerCase()
      !== this.expectedPlanFingerprint
    ) {
      throw new Error(
        'FNS exact plan fingerprint changed while staging',
      );
    }
    if (!this.readOnly) {
      await this.client.query(`ANALYZE ${STAGE_TABLE}`);
    }
  }

  async preview(): Promise<FnsExactImportPreview> {
    const result = await this.client.query(PREVIEW_SQL);
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

  async updateNextBatch(limit: number): Promise<number> {
    if (
      !Number.isSafeInteger(limit)
      || limit < 1
      || limit > 100_000
    ) {
      throw new Error(
        'FNS exact update batch limit must be between 1 and 100000',
      );
    }
    const result = await this.client.query(UPDATE_BATCH_SQL, [limit]);
    return result.rowCount ?? 0;
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
