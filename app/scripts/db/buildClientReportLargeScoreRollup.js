/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Builds an inactive, resumable large-score rollup for the client report.
 *
 * Safety boundary:
 *   - no flag means a read-only dry run;
 *   - --apply is the only write mode;
 *   - the operator only creates/resumes `building` runs and can mark a fully
 *     verified run `ready`;
 *   - it never activates a run and never replaces the current report RPC.
 *
 * Required environment:
 *   CLIENT_REPORT_ROLLUP_CLIENT_USER_ID=<Portal client UUID>
 *   DATABASE_URL / SUPABASE_DB_URL / POSTGRES_URL=<current Portal Postgres>
 */
const crypto = require('node:crypto');
const { Client } = require('pg');
const {
  loadEnvFiles,
  resolveDbUrl,
  shouldUseSsl,
  connectionConfigWithIPv4,
} = require('./ensureDatabase');

const MOSCOW_TIME_ZONE = 'Europe/Moscow';
const ROLLUP_OBJECTS = Object.freeze({
  runsTable: 'client_report_large_score_rollup_runs',
  bucketsTable: 'client_report_large_score_rollup_buckets',
  checkpointsTable: 'client_report_large_score_rollup_checkpoints',
  rebuildDayFunction: 'rebuild_client_report_large_score_rollup_day',
  shadowRpc: 'client_report_pipeline_summary_shadow',
});

const SCORE_CODES = Object.freeze(['a', 'b', 'c', 'rejected', 'error']);
const ADVISORY_LOCK_NAME = 'client-report-large-score-rollup-v1';

// This is the single source-of-truth cohort used by preview, resume fingerprint
// and final verification. Keep it aligned with the per-day rebuild function.
const SOURCE_KEY_CTE = `
source_rows AS (
  SELECT
    j.id AS job_id,
    (d.scored_at AT TIME ZONE '${MOSCOW_TIME_ZONE}')::date AS cohort_day,
    CASE
      WHEN d.status = 'error' THEN 'error'
      ELSE lower(public.client_report_score_code(cache.score))
    END AS score_code,
    d.scored_at
  FROM public.large_score_domains AS d
  JOIN public.large_score_jobs AS j
    ON j.id = d.job_id
   AND j.client_user_id = $1::uuid
   AND j.status = 'completed'
  LEFT JOIN public.mailganer_domain_scores AS cache
    ON cache.domain = lower(btrim(d.domain))
  WHERE d.status IN ('scored', 'error')
    AND d.scored_at IS NOT NULL
    AND ($2::timestamptz IS NULL OR d.scored_at <= $2::timestamptz)
    AND nullif(btrim(d.domain), '') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.client_pipeline_domain_snapshots AS exact_match
      WHERE exact_match.client_user_id = j.client_user_id
        AND NOT exact_match.legacy_inferred
        AND exact_match.source_kind = 'large_score_file'
        AND exact_match.source_job_id = j.id::text
        AND exact_match.source_row_id = d.id::text
    )
),
source_keys AS (
  SELECT
    job_id,
    cohort_day,
    score_code,
    count(*)::bigint AS source_count,
    max(scored_at) AS max_scored_at
  FROM source_rows
  GROUP BY job_id, cohort_day, score_code
)`;

const SOURCE_KEYS_SQL = `
WITH ${SOURCE_KEY_CTE}
SELECT
  job_id::text AS job_id,
  cohort_day::text AS cohort_day,
  score_code,
  source_count::text AS source_count,
  max_scored_at
FROM source_keys
ORDER BY job_id, cohort_day, score_code`;

const UNCOVERED_LEGACY_SQL = `
SELECT count(*)::text AS uncovered_legacy_rows
FROM public.large_score_domains AS d
JOIN public.large_score_jobs AS j
  ON j.id = d.job_id
 AND j.client_user_id = $1::uuid
WHERE j.status <> 'completed'
  AND d.status IN ('scored', 'error')
  AND d.scored_at IS NOT NULL
  AND nullif(btrim(d.domain), '') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.client_pipeline_domain_snapshots AS exact_match
    WHERE exact_match.client_user_id = j.client_user_id
      AND NOT exact_match.legacy_inferred
      AND exact_match.source_kind = 'large_score_file'
      AND exact_match.source_job_id = j.id::text
      AND exact_match.source_row_id = d.id::text
  )`;

function parseCliArgs(argv) {
  if (!Array.isArray(argv)) throw new Error('CLI arguments must be an array');
  const seen = new Set();
  let mode = 'dry-run';

  for (const arg of argv) {
    if (arg !== '--apply' && arg !== '--dry-run') {
      throw new Error(`Unknown argument: ${String(arg)}`);
    }
    if (seen.has(arg)) throw new Error(`Duplicate argument: ${arg}`);
    seen.add(arg);
    if (arg === '--apply') mode = 'apply';
  }

  if (seen.has('--apply') && seen.has('--dry-run')) {
    throw new Error('Choose one mode: --dry-run or --apply');
  }
  return { mode };
}

function assertUuid(value, label) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''))) {
    throw new Error(`${label} must be a UUID`);
  }
  return String(value).toLowerCase();
}

function countAsBigInt(value, label) {
  try {
    const count = BigInt(value ?? 0);
    if (count < 0n) throw new Error('negative');
    return count;
  } catch {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
}

function countAsNumber(value, label) {
  const count = countAsBigInt(value, label);
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds JavaScript safe integer range`);
  }
  return Number(count);
}

function instant(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${String(value)}`);
  }
  return date.toISOString();
}

function sameInstant(left, right) {
  return instant(left) === instant(right);
}

function emptyBuckets() {
  return { a: 0, b: 0, c: 0, rejected: 0, error: 0 };
}

function canonicalSourceKeys(rows) {
  return rows
    .map((row) => ({
      jobId: String(row.job_id ?? row.jobId),
      cohortDay: String(row.cohort_day ?? row.cohortDay),
      scoreCode: String(row.score_code ?? row.scoreCode).toLowerCase(),
      sourceCount: countAsBigInt(
        row.source_count ?? row.sourceCount,
        'source key count',
      ).toString(),
      maxScoredAt: instant(row.max_scored_at ?? row.maxScoredAt),
    }))
    .sort((left, right) => (
      left.jobId.localeCompare(right.jobId)
      || left.cohortDay.localeCompare(right.cohortDay)
      || left.scoreCode.localeCompare(right.scoreCode)
    ));
}

function fingerprintSourceKeys(rows) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalSourceKeys(rows)), 'utf8')
    .digest('hex');
}

function assertPlanCoverage(plan) {
  const uncovered = countAsBigInt(
    plan && plan.uncoveredLegacyRows,
    'uncovered legacy row count',
  );
  if (uncovered !== 0n) {
    throw new Error(
      `Coverage check failed: ${uncovered} uncovered legacy rows belong to non-completed jobs`,
    );
  }
}

function bucketCount(buckets, scoreCode) {
  return countAsBigInt(
    buckets && buckets[scoreCode] !== undefined ? buckets[scoreCode] : 0,
    `${scoreCode} bucket count`,
  );
}

function assertRollupVerification(report) {
  if (!report || typeof report !== 'object') {
    throw new Error('Rollup verification report is required');
  }
  if (report.runStatus !== 'building') {
    throw new Error(
      `Rollup verification requires a building run, got ${String(report.runStatus)}`,
    );
  }

  const sourceRows = countAsBigInt(report.sourceRows, 'source row count');
  const rollupRows = countAsBigInt(report.rollupRows, 'rollup row count');
  if (sourceRows !== rollupRows) {
    throw new Error(
      `Rollup total mismatch: source=${sourceRows}, rollup=${rollupRows}`,
    );
  }
  if (
    report.baselineSourceRows !== undefined
    && sourceRows !== countAsBigInt(report.baselineSourceRows, 'baseline source rows')
  ) {
    throw new Error('Source row count drifted from the persisted run baseline');
  }

  for (const scoreCode of SCORE_CODES) {
    const source = bucketCount(report.sourceBuckets, scoreCode);
    const rollup = bucketCount(report.rollupBuckets, scoreCode);
    if (source !== rollup) {
      throw new Error(
        `Rollup score bucket mismatch for ${scoreCode}: source=${source}, rollup=${rollup}`,
      );
    }
  }

  if (!sameInstant(
    report.sourceWatermarkAtStart,
    report.sourceWatermarkAtVerify,
  )) {
    throw new Error('Source watermark drift detected during rollup build');
  }
  if (!sameInstant(report.sourceWatermarkAtVerify, report.rollupWatermark)) {
    throw new Error('Rollup watermark mismatch');
  }
  if (
    report.sourceFingerprintAtStart !== undefined
    && report.sourceFingerprintAtStart !== report.sourceFingerprintAtVerify
  ) {
    throw new Error('Source fingerprint drift detected during rollup build');
  }

  const expectedJobDays = countAsBigInt(
    report.expectedJobDays,
    'expected job-day count',
  );
  const checkpointJobDays = countAsBigInt(
    report.checkpointJobDays,
    'checkpoint job-day count',
  );
  if (expectedJobDays !== checkpointJobDays) {
    throw new Error(
      `Checkpoint mismatch: expected ${expectedJobDays}, got ${checkpointJobDays}`,
    );
  }
  if (
    report.baselineJobDays !== undefined
    && expectedJobDays !== countAsBigInt(report.baselineJobDays, 'baseline job days')
  ) {
    throw new Error('Job-day coverage drifted from the persisted run baseline');
  }
  if (countAsBigInt(report.invalidCheckpointRows, 'invalid checkpoints') !== 0n) {
    throw new Error('Checkpoint verification mismatch');
  }
  if (countAsBigInt(report.duplicateBucketKeys, 'duplicate bucket keys') !== 0n) {
    throw new Error('Duplicate rollup bucket keys detected');
  }
  if (countAsBigInt(report.mismatchedBucketKeys, 'mismatched bucket keys') !== 0n) {
    throw new Error('Per-key rollup verification mismatch');
  }
}

function makePlan(sourceRows, snapshotAt, uncoveredLegacyRows) {
  const canonical = canonicalSourceKeys(sourceRows);
  const jobIds = new Set();
  const jobDays = new Map();
  const sourceBuckets = emptyBuckets();
  let sourceCount = 0n;
  let maxScoredAt = null;

  for (const key of canonical) {
    if (!SCORE_CODES.includes(key.scoreCode)) {
      throw new Error(`Unexpected score code in source plan: ${key.scoreCode}`);
    }
    const count = countAsBigInt(key.sourceCount, 'source count');
    sourceCount += count;
    sourceBuckets[key.scoreCode] += countAsNumber(count, 'source bucket count');
    jobIds.add(key.jobId);
    jobDays.set(`${key.jobId}:${key.cohortDay}`, {
      jobId: key.jobId,
      moscowDate: key.cohortDay,
    });
    if (
      key.maxScoredAt
      && (!maxScoredAt || new Date(key.maxScoredAt) > new Date(maxScoredAt))
    ) {
      maxScoredAt = key.maxScoredAt;
    }
  }

  const sourceWatermark = maxScoredAt || instant(snapshotAt);
  if (!sourceWatermark) throw new Error('Could not establish source watermark');

  return {
    completedJobs: jobIds.size,
    jobDays: Array.from(jobDays.values()).sort((left, right) => (
      left.jobId.localeCompare(right.jobId)
      || left.moscowDate.localeCompare(right.moscowDate)
    )),
    sourceRows: countAsNumber(sourceCount, 'source rows'),
    sourceWatermark,
    sourceFingerprint: fingerprintSourceKeys(canonical),
    sourceBuckets,
    uncoveredLegacyRows: countAsNumber(
      uncoveredLegacyRows,
      'uncovered legacy rows',
    ),
  };
}

class PostgresLargeScoreRollupRepository {
  constructor({ workClient, lockClient, clientUserId }) {
    if (!workClient || typeof workClient.query !== 'function') {
      throw new Error('A connected work Postgres client is required');
    }
    this.workClient = workClient;
    this.lockClient = lockClient || null;
    this.clientUserId = assertUuid(clientUserId, 'client user id');
    this.lockHeld = false;
    this.lockTransactionOpen = false;
    this.runPlans = new Map();
    this.verifications = new Map();
    this.verificationTransactionRunId = null;
  }

  lockKey() {
    return `${ADVISORY_LOCK_NAME}:${this.clientUserId}`;
  }

  async acquireAdvisoryLock() {
    if (!this.lockClient || typeof this.lockClient.query !== 'function') {
      throw new Error('A dedicated lock Postgres client is required for apply');
    }
    if (this.lockHeld || this.lockTransactionOpen) {
      throw new Error('Rollup advisory lock is already held');
    }

    // The open transaction pins one backend even through a transaction pooler;
    // per-day work uses the separate work client and can still commit each day.
    await this.lockClient.query('BEGIN');
    this.lockTransactionOpen = true;
    try {
      await this.lockClient.query('SET LOCAL statement_timeout = 0');
      await this.lockClient.query(
        'SET LOCAL idle_in_transaction_session_timeout = 0',
      );
      const { rows } = await this.lockClient.query(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
        [this.lockKey()],
      );
      if (!rows[0] || rows[0].acquired !== true) {
        throw new Error('Another large-score rollup operator holds the advisory lock');
      }
      this.lockHeld = true;
    } catch (error) {
      await this.lockClient.query('ROLLBACK').catch(() => {});
      this.lockTransactionOpen = false;
      throw error;
    }
  }

  async releaseAdvisoryLock() {
    if (!this.lockClient || !this.lockTransactionOpen) return;
    let releaseError = null;
    try {
      if (this.lockHeld) {
        const { rows } = await this.lockClient.query(
          'SELECT pg_advisory_unlock(hashtext($1)) AS released',
          [this.lockKey()],
        );
        if (!rows[0] || rows[0].released !== true) {
          releaseError = new Error('Postgres advisory lock was not released');
        }
      }
      await this.lockClient.query('COMMIT');
    } catch (error) {
      releaseError = error;
      await this.lockClient.query('ROLLBACK').catch(() => {});
    } finally {
      this.lockHeld = false;
      this.lockTransactionOpen = false;
    }
    if (releaseError) throw releaseError;
  }

  async inspectPlan() {
    await this.workClient.query(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    try {
      await this.workClient.query('SET LOCAL statement_timeout = 0');
      await this.workClient.query("SET LOCAL lock_timeout = '30s'");
      await this.assertRequiredIndexes();
      const snapshotResult = await this.workClient.query(
        'SELECT transaction_timestamp() AS snapshot_at',
      );
      const sourceResult = await this.workClient.query(
        SOURCE_KEYS_SQL,
        [this.clientUserId, null],
      );
      const uncoveredResult = await this.workClient.query(
        UNCOVERED_LEGACY_SQL,
        [this.clientUserId],
      );
      await this.workClient.query('COMMIT');

      return makePlan(
        sourceResult.rows,
        snapshotResult.rows[0] && snapshotResult.rows[0].snapshot_at,
        uncoveredResult.rows[0]
          ? uncoveredResult.rows[0].uncovered_legacy_rows
          : 0,
      );
    } catch (error) {
      await this.workClient.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }

  async assertRequiredIndexes() {
    const { rows } = await this.workClient.query(
      `SELECT
         EXISTS (
           SELECT 1
           FROM pg_catalog.pg_index AS index_state
           JOIN pg_catalog.pg_class AS index_class
             ON index_class.oid = index_state.indexrelid
           WHERE index_state.indrelid = to_regclass('public.large_score_domains')
             AND index_class.relnamespace = 'public'::regnamespace
             AND index_class.relname = 'idx_large_score_domains_job_scored_at'
             AND index_state.indisvalid
             AND index_state.indisready
             AND index_state.indislive
         ) AS large_index_ready,
         EXISTS (
           SELECT 1
           FROM pg_catalog.pg_index AS index_state
           WHERE index_state.indrelid = to_regclass('public.mailganer_domain_scores')
             AND index_state.indisprimary
             AND index_state.indisvalid
             AND index_state.indisready
             AND index_state.indislive
             AND pg_get_indexdef(index_state.indexrelid)
                 ~* '\\([^,()]*domain[^,()]*\\)'
         ) AS cache_primary_key_ready`,
    );
    const state = rows[0] || {};
    if (state.large_index_ready !== true) {
      throw new Error(
        'Required ready/valid index idx_large_score_domains_job_scored_at is missing',
      );
    }
    if (state.cache_primary_key_ready !== true) {
      throw new Error(
        'Required ready/valid mailganer_domain_scores domain primary key is missing',
      );
    }
  }

  baselineFromPlan(plan) {
    if (!plan || !Array.isArray(plan.jobDays)) {
      throw new Error('A source plan with job-days is required');
    }
    if (!/^[0-9a-f]{64}$/.test(String(plan.sourceFingerprint || ''))) {
      throw new Error('Source plan fingerprint is required');
    }
    return {
      sourceRows: countAsBigInt(plan.sourceRows, 'plan source rows'),
      sourceJobDays: BigInt(plan.jobDays.length),
      sourceWatermark: instant(plan.sourceWatermark),
      sourceFingerprint: String(plan.sourceFingerprint),
    };
  }

  assertRunBaseline(run, plan) {
    const baseline = this.baselineFromPlan(plan);
    if (countAsBigInt(run.source_rows, 'run source rows') !== baseline.sourceRows) {
      throw new Error('Cannot resume: source row count drifted from run baseline');
    }
    if (
      countAsBigInt(run.source_job_days, 'run source job-days')
      !== baseline.sourceJobDays
    ) {
      throw new Error('Cannot resume: source job-day coverage drifted from run baseline');
    }
    if (!sameInstant(run.source_watermark, baseline.sourceWatermark)) {
      throw new Error('Cannot resume: source watermark drifted from run baseline');
    }
    if (String(run.source_fingerprint) !== baseline.sourceFingerprint) {
      throw new Error('Cannot resume: source fingerprint drifted from run baseline');
    }
    return baseline;
  }

  async createOrResumeBuildingRun(plan) {
    const baseline = this.baselineFromPlan(plan);
    await this.workClient.query('BEGIN');
    try {
      await this.workClient.query('SET LOCAL statement_timeout = 0');
      await this.workClient.query("SET LOCAL lock_timeout = '30s'");
      const existingResult = await this.workClient.query(
        `SELECT
           id::text,
           status,
           source_watermark,
           source_rows::text,
           source_job_days::text,
           source_fingerprint
         FROM public.${ROLLUP_OBJECTS.runsTable}
         WHERE client_user_id = $1::uuid
           AND status = 'building'
         ORDER BY started_at DESC, id DESC
         LIMIT 2
         FOR UPDATE`,
        [this.clientUserId],
      );

      if (existingResult.rows.length > 1) {
        throw new Error('Multiple building rollup runs exist for this client');
      }

      let row;
      let resumed;
      if (existingResult.rows.length === 1) {
        row = existingResult.rows[0];
        this.assertRunBaseline(row, plan);
        resumed = true;
      } else {
        const inserted = await this.workClient.query(
          `INSERT INTO public.${ROLLUP_OBJECTS.runsTable} (
             client_user_id,
             status,
             source_watermark,
             source_rows,
             source_job_days,
             source_fingerprint,
             started_at
           ) VALUES ($1::uuid, 'building', $2::timestamptz, $3::bigint, $4::bigint, $5, clock_timestamp())
           RETURNING id::text, status`,
          [
            this.clientUserId,
            baseline.sourceWatermark,
            baseline.sourceRows.toString(),
            baseline.sourceJobDays.toString(),
            baseline.sourceFingerprint,
          ],
        );
        row = inserted.rows[0];
        resumed = false;
      }

      if (!row || row.status !== 'building') {
        throw new Error('Failed to create or resume a building rollup run');
      }
      await this.workClient.query('COMMIT');
      this.runPlans.set(row.id, plan);
      return { runId: row.id, status: 'building', resumed };
    } catch (error) {
      await this.workClient.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }

  async listPendingJobDays(runId, plan) {
    assertUuid(runId, 'rollup run id');
    const seen = new Set();
    for (const day of plan.jobDays) {
      const jobId = assertUuid(day.jobId, 'source job id');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day.moscowDate))) {
        throw new Error(`Invalid Moscow cohort day: ${String(day.moscowDate)}`);
      }
      const key = `${jobId}:${day.moscowDate}`;
      if (seen.has(key)) throw new Error(`Duplicate source job-day in plan: ${key}`);
      seen.add(key);
    }

    const { rows } = await this.workClient.query(
      `SELECT source_job_id::text AS job_id, cohort_day::text AS cohort_day
       FROM public.${ROLLUP_OBJECTS.checkpointsTable}
       WHERE rollup_run_id = $1::uuid
         AND client_user_id = $2::uuid`,
      [runId, this.clientUserId],
    );
    const checkpointed = new Set(
      rows.map((row) => `${row.job_id}:${row.cohort_day}`),
    );
    for (const key of checkpointed) {
      if (!seen.has(key)) {
        throw new Error(`Checkpoint is outside the persisted source plan: ${key}`);
      }
    }
    return plan.jobDays.filter(
      (day) => !checkpointed.has(`${day.jobId}:${day.moscowDate}`),
    );
  }

  async rebuildJobDayInTransaction(runId, day) {
    assertUuid(runId, 'rollup run id');
    assertUuid(day.jobId, 'source job id');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day.moscowDate))) {
      throw new Error(`Invalid Moscow cohort day: ${String(day.moscowDate)}`);
    }

    await this.workClient.query('BEGIN');
    try {
      await this.workClient.query('SET LOCAL statement_timeout = 0');
      await this.workClient.query("SET LOCAL lock_timeout = '30s'");
      const { rows } = await this.workClient.query(
        `SELECT source_count::text, bucket_count::text, max_cohort_at
         FROM public.${ROLLUP_OBJECTS.rebuildDayFunction}(
           $1::uuid,
           $2::uuid,
           $3::date
         )`,
        [runId, day.jobId, day.moscowDate],
      );
      if (rows.length !== 1) {
        throw new Error('Per-day rebuild returned no verification result');
      }
      if (
        countAsBigInt(rows[0].source_count, 'day source count')
        !== countAsBigInt(rows[0].bucket_count, 'day bucket count')
      ) {
        throw new Error('Per-day rollup count invariant failed');
      }
      await this.workClient.query('COMMIT');
    } catch (error) {
      await this.workClient.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }

  async loadRun(runId) {
    const { rows } = await this.workClient.query(
      `SELECT
         id::text,
         status,
         source_watermark,
         source_rows::text,
         source_job_days::text,
         source_fingerprint
       FROM public.${ROLLUP_OBJECTS.runsTable}
       WHERE id = $1::uuid
         AND client_user_id = $2::uuid`,
      [runId, this.clientUserId],
    );
    if (rows.length !== 1) throw new Error('Rollup run not found for client');
    return rows[0];
  }

  async verify(runId, plan) {
    assertUuid(runId, 'rollup run id');
    if (this.verificationTransactionRunId) {
      throw new Error('Another rollup verification transaction is already open');
    }
    await this.workClient.query(
      'BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE',
    );
    this.verificationTransactionRunId = runId;
    try {
      await this.workClient.query('SET LOCAL statement_timeout = 0');
      await this.workClient.query("SET LOCAL lock_timeout = '30s'");
      const run = await this.loadRun(runId);
      this.assertRunBaseline(run, plan);

      const reconciliationResult = await this.workClient.query(
      `WITH ${SOURCE_KEY_CTE},
       rollup_keys AS (
         SELECT
           source_job_id AS job_id,
           cohort_day,
           lower(score_code) AS score_code,
           sum(domain_count)::bigint AS rollup_count,
           max(max_cohort_at) AS max_cohort_at
         FROM public.${ROLLUP_OBJECTS.bucketsTable}
         WHERE rollup_run_id = $3::uuid
           AND client_user_id = $1::uuid
         GROUP BY source_job_id, cohort_day, lower(score_code)
       )
       SELECT
         coalesce(source_keys.job_id, rollup_keys.job_id)::text AS job_id,
         coalesce(source_keys.cohort_day, rollup_keys.cohort_day)::text AS cohort_day,
         coalesce(source_keys.score_code, rollup_keys.score_code) AS score_code,
         source_keys.source_count::text AS source_count,
         rollup_keys.rollup_count::text AS rollup_count,
         source_keys.max_scored_at,
         rollup_keys.max_cohort_at
       FROM source_keys
       FULL OUTER JOIN rollup_keys
         ON rollup_keys.job_id = source_keys.job_id
        AND rollup_keys.cohort_day = source_keys.cohort_day
        AND rollup_keys.score_code = source_keys.score_code
       ORDER BY job_id, cohort_day, score_code`,
      [this.clientUserId, run.source_watermark, runId],
    );

      const checkpointResult = await this.workClient.query(
      `SELECT
         count(*)::text AS checkpoint_job_days,
         count(*) FILTER (WHERE source_count <> bucket_count)::text
           AS invalid_checkpoint_rows
       FROM public.${ROLLUP_OBJECTS.checkpointsTable}
       WHERE rollup_run_id = $1::uuid
         AND client_user_id = $2::uuid`,
      [runId, this.clientUserId],
    );
      const duplicateResult = await this.workClient.query(
      `SELECT count(*)::text AS duplicate_bucket_keys
       FROM (
         SELECT
           rollup_run_id,
           client_user_id,
           source_job_id,
           cohort_day,
           score_code
         FROM public.${ROLLUP_OBJECTS.bucketsTable}
         WHERE rollup_run_id = $1::uuid
           AND client_user_id = $2::uuid
         GROUP BY
           rollup_run_id,
           client_user_id,
           source_job_id,
           cohort_day,
           score_code
         HAVING count(*) > 1
       ) AS duplicates`,
      [runId, this.clientUserId],
    );

      const sourceBuckets = emptyBuckets();
      const rollupBuckets = emptyBuckets();
      const sourceFingerprintRows = [];
      let sourceRows = 0n;
      let rollupRows = 0n;
      let sourceMax = null;
      let rollupMax = null;
      let mismatchedBucketKeys = 0;

      for (const row of reconciliationResult.rows) {
        const scoreCode = String(row.score_code).toLowerCase();
        if (!SCORE_CODES.includes(scoreCode)) {
          throw new Error(`Unexpected score code during verification: ${scoreCode}`);
        }
        const sourceCount = countAsBigInt(row.source_count, 'source key count');
        const rollupCount = countAsBigInt(row.rollup_count, 'rollup key count');
        sourceRows += sourceCount;
        rollupRows += rollupCount;
        sourceBuckets[scoreCode] += countAsNumber(sourceCount, 'source bucket');
        rollupBuckets[scoreCode] += countAsNumber(rollupCount, 'rollup bucket');

        const sourceKeyMax = instant(row.max_scored_at);
        const rollupKeyMax = instant(row.max_cohort_at);
        if (sourceCount > 0n) {
          sourceFingerprintRows.push({
            job_id: row.job_id,
            cohort_day: row.cohort_day,
            score_code: scoreCode,
            source_count: sourceCount.toString(),
            max_scored_at: sourceKeyMax,
          });
        }
        if (sourceKeyMax && (!sourceMax || sourceKeyMax > sourceMax)) {
          sourceMax = sourceKeyMax;
        }
        if (rollupKeyMax && (!rollupMax || rollupKeyMax > rollupMax)) {
          rollupMax = rollupKeyMax;
        }
        if (sourceCount !== rollupCount || !sameInstant(sourceKeyMax, rollupKeyMax)) {
          mismatchedBucketKeys += 1;
        }
      }

      const checkpoint = checkpointResult.rows[0] || {};
      const duplicates = duplicateResult.rows[0] || {};
      const sourceWatermarkAtVerify = sourceMax || instant(run.source_watermark);
      const rollupWatermark = rollupMax || instant(run.source_watermark);
      const report = {
        runStatus: run.status,
        sourceRows: countAsNumber(sourceRows, 'verified source rows'),
        rollupRows: countAsNumber(rollupRows, 'verified rollup rows'),
        baselineSourceRows: countAsNumber(run.source_rows, 'baseline source rows'),
        sourceBuckets,
        rollupBuckets,
        sourceWatermarkAtStart: instant(run.source_watermark),
        sourceWatermarkAtVerify,
        rollupWatermark,
        sourceFingerprintAtStart: String(run.source_fingerprint),
        sourceFingerprintAtVerify: fingerprintSourceKeys(sourceFingerprintRows),
        expectedJobDays: plan.jobDays.length,
        checkpointJobDays: countAsNumber(
          checkpoint.checkpoint_job_days,
          'checkpoint job-days',
        ),
        baselineJobDays: countAsNumber(run.source_job_days, 'baseline job-days'),
        invalidCheckpointRows: countAsNumber(
          checkpoint.invalid_checkpoint_rows,
          'invalid checkpoints',
        ),
        duplicateBucketKeys: countAsNumber(
          duplicates.duplicate_bucket_keys,
          'duplicate bucket keys',
        ),
        mismatchedBucketKeys,
      };
      this.verifications.set(runId, report);
      return report;
    } catch (error) {
      await this.workClient.query('ROLLBACK').catch(() => {});
      this.verificationTransactionRunId = null;
      throw error;
    }
  }

  async rollbackOpenVerification() {
    if (!this.verificationTransactionRunId) return;
    await this.workClient.query('ROLLBACK').catch(() => {});
    this.verifications.delete(this.verificationTransactionRunId);
    this.verificationTransactionRunId = null;
  }

  async markRunReady(runId) {
    assertUuid(runId, 'rollup run id');
    const report = this.verifications.get(runId);
    if (!report) throw new Error('Cannot mark ready before full verification');
    if (this.verificationTransactionRunId !== runId) {
      throw new Error('Cannot mark ready outside its verification transaction');
    }
    assertRollupVerification(report);
    try {
      const { rows } = await this.workClient.query(
        `UPDATE public.${ROLLUP_OBJECTS.runsTable}
         SET status = 'ready',
             ready_at = clock_timestamp(),
             validation = $3::jsonb,
             error_message = NULL
         WHERE id = $1::uuid
           AND client_user_id = $2::uuid
           AND status = 'building'
         RETURNING id::text`,
        [runId, this.clientUserId, JSON.stringify(report)],
      );
      if (rows.length !== 1) {
        throw new Error('Rollup run changed before it could be marked ready');
      }
      await this.workClient.query('COMMIT');
      this.verificationTransactionRunId = null;
    } catch (error) {
      await this.workClient.query('ROLLBACK').catch(() => {});
      this.verificationTransactionRunId = null;
      throw error;
    }
  }
}

async function executeLargeScoreRollupOperator({ mode, repository }) {
  if (mode !== 'dry-run' && mode !== 'apply') {
    throw new Error(`Invalid rollup operator mode: ${String(mode)}`);
  }
  if (!repository || typeof repository.inspectPlan !== 'function') {
    throw new Error('Rollup repository is required');
  }

  if (mode === 'dry-run') {
    const plan = await repository.inspectPlan();
    return { mode, plan };
  }

  let lockAcquired = false;
  try {
    await repository.acquireAdvisoryLock();
    lockAcquired = true;
    const plan = await repository.inspectPlan();
    assertPlanCoverage(plan);
    const run = await repository.createOrResumeBuildingRun(plan);
    const pending = await repository.listPendingJobDays(run.runId, plan);
    for (const day of pending) {
      await repository.rebuildJobDayInTransaction(run.runId, day);
    }
    const verification = await repository.verify(run.runId, plan);
    assertRollupVerification(verification);
    await repository.markRunReady(run.runId);
    return {
      mode,
      plan,
      run,
      rebuiltJobDays: pending.length,
      verification,
    };
  } catch (error) {
    if (typeof repository.rollbackOpenVerification === 'function') {
      await repository.rollbackOpenVerification();
    }
    throw error;
  } finally {
    if (lockAcquired) await repository.releaseAdvisoryLock();
  }
}

function logPlan(plan, prefix) {
  console.log(
    `[client-report-rollup] ${prefix}: `
      + `${Number(plan.sourceRows || 0).toLocaleString('en-US')} source rows, `
      + `${plan.completedJobs} completed jobs, ${plan.jobDays.length} Moscow job-days, `
      + `${Number(plan.uncoveredLegacyRows || 0).toLocaleString('en-US')} uncovered rows, `
      + `watermark ${plan.sourceWatermark}, fingerprint ${plan.sourceFingerprint}`,
  );
}

async function main(argv = process.argv.slice(2)) {
  const { mode } = parseCliArgs(argv);
  loadEnvFiles();

  const clientUserId = assertUuid(
    process.env.CLIENT_REPORT_ROLLUP_CLIENT_USER_ID,
    'CLIENT_REPORT_ROLLUP_CLIENT_USER_ID',
  );
  const dbUrl = resolveDbUrl();
  if (!dbUrl) {
    throw new Error(
      'Portal database URL is not configured (DATABASE_URL / SUPABASE_DB_URL / POSTGRES_URL)',
    );
  }

  const ssl = shouldUseSsl(dbUrl) ? { rejectUnauthorized: false } : undefined;
  const baseConfig = await connectionConfigWithIPv4(dbUrl, ssl);
  const workClient = new Client({
    ...baseConfig,
    application_name: 'client-report-large-score-rollup-work',
  });
  const lockClient = mode === 'apply'
    ? new Client({
      ...baseConfig,
      application_name: 'client-report-large-score-rollup-lock',
    })
    : null;

  await workClient.connect();
  try {
    if (lockClient) await lockClient.connect();
    await workClient.query('SET statement_timeout = 0');
    await workClient.query("SET lock_timeout = '30s'");
    if (lockClient) {
      await lockClient.query('SET statement_timeout = 0');
      await lockClient.query("SET lock_timeout = '30s'");
      await lockClient.query('SET idle_in_transaction_session_timeout = 0');
    }

    const repository = new PostgresLargeScoreRollupRepository({
      workClient,
      lockClient,
      clientUserId,
    });
    const result = await executeLargeScoreRollupOperator({ mode, repository });
    logPlan(result.plan, mode === 'apply' ? 'applied and verified' : 'dry-run');
    if (mode === 'apply') {
      console.log(
        `[client-report-rollup] run ${result.run.runId} is ready (inactive); `
          + `${result.rebuiltJobDays} job-days rebuilt. No RPC cutover was performed.`,
      );
    } else {
      console.log('[client-report-rollup] dry-run only; no lock or database write was performed.');
    }
    return result;
  } finally {
    await workClient.end().catch(() => {});
    if (lockClient) await lockClient.end().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      '[client-report-rollup] failed:',
      error && error.message ? error.message : error,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  MOSCOW_TIME_ZONE,
  ROLLUP_OBJECTS,
  SOURCE_KEY_CTE,
  parseCliArgs,
  canonicalSourceKeys,
  fingerprintSourceKeys,
  assertPlanCoverage,
  assertRollupVerification,
  makePlan,
  PostgresLargeScoreRollupRepository,
  executeLargeScoreRollupOperator,
  main,
};
