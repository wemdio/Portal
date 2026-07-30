import {
  computeSbisPreviewFingerprint,
  type SbisApplySession,
  type SbisImportPreview,
} from '@/lib/companiesDirectory/sbisPlanApply';
import {
  beginImportTransaction,
  verifyPortalCompaniesDirectoryIdentity,
} from '@/lib/companiesDirectory/postgresImportCore';

export interface SbisPgQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}

export interface SbisPgClient {
  query(sql: string, values?: unknown[]): Promise<SbisPgQueryResult>;
}

interface SbisStageCallbacks {
  onInsertBatch(rows: Record<string, unknown>[]): Promise<void>;
  onUpdateBatch(rows: Record<string, unknown>[]): Promise<void>;
}

interface SbisPostgresApplySessionOptions {
  client: SbisPgClient;
  expectedPlanFingerprint: string;
  processArtifacts(
    callbacks: SbisStageCallbacks,
  ): Promise<{ planFingerprint: string }>;
}

const STAGE_TABLE = 'sbis_directory_import_stage';

const CREATE_STAGE_SQL = `
CREATE TEMP TABLE ${STAGE_TABLE} (
  kind text NOT NULL CHECK (kind IN ('insert', 'update')),
  inn text NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (inn)
)
`.trim();

const INSERT_STAGE_SQL = `
INSERT INTO ${STAGE_TABLE} (kind, inn, payload)
SELECT
  staged.kind,
  staged.inn,
  staged.payload
FROM jsonb_to_recordset($1::jsonb) AS staged(
  kind text,
  inn text,
  payload jsonb
)
`.trim();

interface InsertValueSpec {
  column: string;
  value(payload: string): string;
}

const nullableTextValue = (field: string) => (payload: string): string =>
  `NULLIF(${payload}->>'${field}', '')`;
const requiredTextValue = (field: string) => (payload: string): string =>
  `${payload}->>'${field}'`;
const integerValue = (field: string, type: 'integer' | 'bigint') =>
  (payload: string): string => `(${payload}->>'${field}')::${type}`;

const INSERT_VALUE_SPECS: InsertValueSpec[] = [
  { column: 'name', value: nullableTextValue('name') },
  { column: 'inn', value: requiredTextValue('inn') },
  { column: 'kpp', value: nullableTextValue('kpp') },
  { column: 'address', value: nullableTextValue('address') },
  {
    column: 'director_last_name',
    value: nullableTextValue('director_last_name'),
  },
  {
    column: 'director_first_name',
    value: nullableTextValue('director_first_name'),
  },
  {
    column: 'director_middle_name',
    value: nullableTextValue('director_middle_name'),
  },
  { column: 'activity_type', value: nullableTextValue('activity_type') },
  {
    column: 'employees_count',
    value: integerValue('employees_count', 'integer'),
  },
  { column: 'phones', value: nullableTextValue('phones') },
  { column: 'email', value: nullableTextValue('email') },
  { column: 'revenue', value: integerValue('revenue', 'bigint') },
  { column: 'cost', value: integerValue('cost', 'bigint') },
  { column: 'edo_id', value: nullableTextValue('edo_id') },
  { column: 'okpo', value: nullableTextValue('okpo') },
  { column: 'pf_reg_number', value: nullableTextValue('pf_reg_number') },
  { column: 'branch_code', value: nullableTextValue('branch_code') },
  { column: 'website', value: nullableTextValue('website') },
  { column: 'egais', value: nullableTextValue('egais') },
  { column: 'gln', value: nullableTextValue('gln') },
  { column: 'ogrn', value: nullableTextValue('ogrn') },
  { column: 'region_code', value: nullableTextValue('region_code') },
  { column: 'okved_code', value: requiredTextValue('okved_code') },
  { column: 'source_file', value: requiredTextValue('source_file') },
];

const NONEMPTY_CANDIDATE_SQL = (field: string): string =>
  `NULLIF(BTRIM(candidate->>'${field}'), '') IS NOT NULL`;

const EMPTY_CURRENT_SQL = (
  field: string,
  qualifier = 'c.',
): string =>
  `NULLIF(BTRIM(${qualifier}${field}), '') IS NULL`;

const buildFillConditions = (qualifier = 'c.'): string =>
  ['phones', 'email', 'website', 'okved_code']
  .map(
    (field) =>
      `(${EMPTY_CURRENT_SQL(field, qualifier)} AND ${NONEMPTY_CANDIDATE_SQL(field)})`,
  )
  .join('\n      OR ');

const FILL_CONDITIONS = buildFillConditions();
const PREVIEW_FILL_CONDITIONS = buildFillConditions('');
const UPDATE_CONFLICT_CONDITIONS = [
  'phones',
  'email',
  'website',
  'okved_code',
]
  .map(
    (field) => `(
      candidate ? '${field}'
      AND ${NONEMPTY_CANDIDATE_SQL(field)}
      AND NOT ${EMPTY_CURRENT_SQL(field, '')}
      AND ${field} IS DISTINCT FROM BTRIM(candidate->>'${field}')
    )`,
  )
  .join('\n      OR ');
const INSERT_MATCH_CONDITIONS = INSERT_VALUE_SPECS
  .map(
    ({ column, value }) =>
      `c.${column} IS NOT DISTINCT FROM ${value('s.payload')}`,
  )
  .join('\n      AND ');
const INSERT_STATE_COLUMNS = INSERT_VALUE_SPECS
  .map(({ column }) => `c.${column}`)
  .join(',\n            ');

const PREVIEW_SQL = `
WITH current_state AS (
  SELECT
    s.kind,
    s.inn,
    CASE
      WHEN s.kind = 'insert' THEN s.payload
      ELSE s.payload->'patch'
    END AS candidate,
    CASE
      WHEN s.kind = 'update' THEN (s.payload->>'id')::bigint
      ELSE NULL
    END AS expected_id,
    target.target_count,
    c.id,
    c.phones,
    c.email,
    c.website,
    c.okved_code,
    c.okved_code_exact,
    c.okved_exact_source,
    (
      s.kind = 'insert'
      AND target.target_count = 1
      AND ${INSERT_MATCH_CONDITIONS}
    ) AS matches_insert,
    MD5(
      JSONB_BUILD_ARRAY(
        s.kind,
        s.inn,
        target.target_count,
        c.id,
        ${INSERT_STATE_COLUMNS},
        c.okved_code_exact,
        c.okved_exact_source
      )::text
    ) AS decision_digest
  FROM ${STAGE_TABLE} s
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)::int AS target_count,
      CASE WHEN COUNT(*) = 1 THEN MIN(existing.id) END AS only_id
    FROM public.companies_directory existing
    WHERE existing.inn = s.inn
  ) target ON true
  LEFT JOIN public.companies_directory c
    ON c.id = target.only_id
),
classified AS (
  SELECT
    *,
    (
      kind = 'update'
      AND target_count = 1
      AND id = expected_id
      AND (
        ${PREVIEW_FILL_CONDITIONS}
      )
    ) AS needs_fill,
    (
      kind = 'update'
      AND target_count = 1
      AND id = expected_id
      AND (
        ${UPDATE_CONFLICT_CONDITIONS}
      )
    ) AS has_update_conflict
  FROM current_state
)
SELECT
  COUNT(*) FILTER (WHERE kind = 'insert') AS staged_inserts,
  COUNT(*) FILTER (WHERE kind = 'update') AS staged_updates,
  COUNT(*) FILTER (
    WHERE kind = 'insert' AND target_count = 0
  ) AS missing_inserts,
  COUNT(*) FILTER (
    WHERE kind = 'insert' AND target_count = 1 AND matches_insert
  ) AS already_present_inserts,
  COUNT(*) FILTER (WHERE needs_fill) AS rows_to_update,
  COUNT(*) FILTER (
    WHERE kind = 'update' AND target_count = 0
  ) AS missing_update_targets,
  COUNT(*) FILTER (WHERE target_count > 1) AS duplicate_target_inns,
  COUNT(*) FILTER (
    WHERE kind = 'insert' AND target_count = 1 AND NOT matches_insert
  ) AS conflicting_present_inserts,
  COUNT(*) FILTER (
    WHERE kind = 'update'
      AND target_count = 1
      AND id IS DISTINCT FROM expected_id
  ) AS mismatched_update_targets,
  COUNT(*) FILTER (
    WHERE has_update_conflict
  ) AS conflicting_update_values,
  COALESCE(
    MD5(
      STRING_AGG(
        decision_digest,
        ''
        ORDER BY inn
      )
    ),
    MD5('')
  ) AS state_digest
FROM classified
`.trim();

const INSERT_TARGET_SQL = `
INSERT INTO public.companies_directory (
  ${INSERT_VALUE_SPECS.map(({ column }) => column).join(',\n  ')},
  okved_code_exact,
  okved_exact_source
)
SELECT
  ${INSERT_VALUE_SPECS
    .map(({ value }) => value('s.payload'))
    .join(',\n  ')},
  NULL::text,
  NULL::text
FROM ${STAGE_TABLE} s
WHERE s.kind = 'insert'
  AND NOT EXISTS (
    SELECT 1
    FROM public.companies_directory existing
    WHERE existing.inn = s.inn
  )
ORDER BY s.inn
`.trim();

const fillExpression = (field: string): string => `
  ${field} = CASE
    WHEN ${EMPTY_CURRENT_SQL(field)}
      AND ${NONEMPTY_CANDIDATE_SQL(field)}
    THEN BTRIM(candidate->>'${field}')
    ELSE c.${field}
  END`;

const UPDATE_TARGET_SQL = `
UPDATE public.companies_directory c
SET
${['phones', 'email', 'website', 'okved_code']
    .map(fillExpression)
    .join(',\n')}
FROM (
  SELECT
    s.inn,
    (s.payload->>'id')::bigint AS expected_id,
    s.payload->'patch' AS candidate
  FROM ${STAGE_TABLE} s
  WHERE s.kind = 'update'
) staged
WHERE c.id = staged.expected_id
  AND c.inn = staged.inn
  AND (
    ${FILL_CONDITIONS}
  )
`.trim();

function integerFromRow(
  row: Record<string, unknown>,
  field: string,
): number {
  const value = Number(row[field]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid SBIS preview field ${field}: ${String(row[field])}`);
  }
  return value;
}

export class SbisPostgresApplySession implements SbisApplySession {
  private readonly client: SbisPgClient;
  private readonly expectedPlanFingerprint: string;
  private readonly processArtifacts: (
    callbacks: SbisStageCallbacks,
  ) => Promise<{ planFingerprint: string }>;
  private stageTablePrepared = false;
  private readOnly = false;

  constructor(options: SbisPostgresApplySessionOptions) {
    this.client = options.client;
    this.expectedPlanFingerprint = options.expectedPlanFingerprint.toLowerCase();
    this.processArtifacts = options.processArtifacts;
  }

  private async prepareStageTable(): Promise<void> {
    if (this.stageTablePrepared) return;
    // PostgreSQL forbids CREATE after a READ ONLY transaction starts. Creating
    // this session-local table first keeps check mode read-only for all
    // persistent relations while still allowing batched temp-table inserts.
    await this.client.query(CREATE_STAGE_SQL);
    this.stageTablePrepared = true;
  }

  async beginReadOnly(): Promise<void> {
    await this.prepareStageTable();
    this.readOnly = true;
    await beginImportTransaction(this.client, 'BEGIN READ ONLY', {
      lockTimeout: '30s',
      statementTimeout: '30min',
      idleTimeout: '35min',
    });
  }

  async beginReadWrite(): Promise<void> {
    await this.prepareStageTable();
    this.readOnly = false;
    await beginImportTransaction(this.client, 'BEGIN READ WRITE', {
      lockTimeout: '30s',
      statementTimeout: '30min',
      idleTimeout: '35min',
    });
  }

  async acquireAdvisoryLock(): Promise<void> {
    await this.client.query(`
SELECT pg_advisory_xact_lock(
  hashtextextended('companies_directory:sbis-directory-v4', 0)
)
`.trim());
  }

  private async stageBatch(
    kind: 'insert' | 'update',
    rows: Record<string, unknown>[],
  ): Promise<void> {
    if (rows.length === 0) return;
    const payload = rows.map((row) => ({
      kind,
      inn: row.inn,
      payload: row,
    }));
    const result = await this.client.query(
      INSERT_STAGE_SQL,
      [JSON.stringify(payload)],
    );
    if (result.rowCount !== rows.length) {
      throw new Error(
        `Unexpected ${kind} staging count: expected ${rows.length}, got ${String(result.rowCount)}`,
      );
    }
  }

  async stageArtifacts(): Promise<void> {
    if (!this.stageTablePrepared) {
      throw new Error('SBIS staging table was not prepared before the transaction');
    }
    const processed = await this.processArtifacts({
      onInsertBatch: async (rows) => this.stageBatch('insert', rows),
      onUpdateBatch: async (rows) => this.stageBatch('update', rows),
    });
    if (
      processed.planFingerprint.toLowerCase()
      !== this.expectedPlanFingerprint
    ) {
      throw new Error(
        'SBIS plan fingerprint changed while staging; refusing to continue',
      );
    }
    if (!this.readOnly) {
      await this.client.query(`ANALYZE ${STAGE_TABLE}`);
    }
  }

  async lockTargetTable(): Promise<void> {
    await this.client.query(
      'LOCK TABLE public.companies_directory IN SHARE ROW EXCLUSIVE MODE',
    );
  }

  async preview(): Promise<SbisImportPreview> {
    const result = await this.client.query(PREVIEW_SQL);
    const row = result.rows[0];
    if (!row) {
      throw new Error('SBIS live preview returned no row');
    }
    const body = {
      stagedInserts: integerFromRow(row, 'staged_inserts'),
      stagedUpdates: integerFromRow(row, 'staged_updates'),
      missingInserts: integerFromRow(row, 'missing_inserts'),
      alreadyPresentInserts: integerFromRow(row, 'already_present_inserts'),
      rowsToUpdate: integerFromRow(row, 'rows_to_update'),
      missingUpdateTargets: integerFromRow(row, 'missing_update_targets'),
      duplicateTargetInns: integerFromRow(row, 'duplicate_target_inns'),
      conflictingPresentInserts: integerFromRow(
        row,
        'conflicting_present_inserts',
      ),
      mismatchedUpdateTargets: integerFromRow(
        row,
        'mismatched_update_targets',
      ),
      conflictingUpdateValues: integerFromRow(
        row,
        'conflicting_update_values',
      ),
      stateDigest: String(row.state_digest ?? ''),
    };
    if (!/^[a-f0-9]{32}$/i.test(body.stateDigest)) {
      throw new Error('SBIS live preview returned an invalid state digest');
    }
    return {
      ...body,
      fingerprint: computeSbisPreviewFingerprint(body),
    };
  }

  async insertMissing(): Promise<number> {
    const result = await this.client.query(INSERT_TARGET_SQL);
    return result.rowCount ?? 0;
  }

  async fillEmpty(): Promise<number> {
    const result = await this.client.query(UPDATE_TARGET_SQL);
    return result.rowCount ?? 0;
  }

  async commit(): Promise<void> {
    await this.client.query('COMMIT');
  }

  async rollback(): Promise<void> {
    await this.client.query('ROLLBACK');
  }
}

export async function verifySbisDatabaseIdentity(
  client: SbisPgClient,
): Promise<{
  database: string;
  directoryTable: string;
}> {
  return verifyPortalCompaniesDirectoryIdentity(client);
}
