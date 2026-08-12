/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Selects (or rolls back) one client's verified large-score report rollup.
 * No flags ever mutate; --apply is required for activation or rollback.
 */
const { Client } = require('pg');
const {
  loadEnvFiles,
  resolveDbUrl,
  shouldUseSsl,
  connectionConfigWithIPv4,
} = require('./ensureDatabase');

const SUMMARY_COUNT_FIELDS = Object.freeze([
  'scored_companies',
  'working_score_companies',
  'email_found_companies',
  'validated_emails',
  'submitted_contacts',
  'confirmed_contacts',
  'legacy_submitted_contacts',
  'event_confirmed_contacts',
  'event_legacy_submitted_contacts',
  'legacy_scored_companies',
  'unattributed_confirmed_contacts',
]);
const SCORE_FILTERS = Object.freeze([null, 'A', 'B', 'C']);

function assertUuid(value, label) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''))) {
    throw new Error(`${label} must be a UUID`);
  }
  return String(value).toLowerCase();
}

function parseCliArgs(argv) {
  if (!Array.isArray(argv)) throw new Error('CLI arguments must be an array');
  let mode = 'dry-run';
  let action = 'activate';
  let runId = null;
  let sawMode = false;
  let sawRollback = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply' || arg === '--dry-run') {
      if (sawMode) throw new Error('Duplicate or ambiguous mode');
      sawMode = true;
      mode = arg === '--apply' ? 'apply' : 'dry-run';
    } else if (arg === '--rollback') {
      if (sawRollback) throw new Error('Duplicate rollback action');
      sawRollback = true;
      action = 'rollback';
    } else if (arg === '--run-id') {
      if (runId !== null) throw new Error('Duplicate run-id');
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('run-id is required');
      runId = assertUuid(value, 'run-id');
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }

  if (action === 'rollback' && runId) {
    throw new Error('Rollback and run-id are ambiguous');
  }
  if (action === 'activate' && !runId) {
    throw new Error('Activation action requires --run-id');
  }
  return { mode, action, runId };
}

function normalizeAllowedCampaignIds(values) {
  if (!Array.isArray(values)) {
    throw new Error('Allowed campaign ids must be an array');
  }
  const ids = [];
  const seen = new Set();
  for (const raw of values) {
    const id = String(raw || '').trim();
    if (!id || id.length > 200 || /[\u0000-\u001f]/.test(id)) {
      throw new Error('Allowed campaign ids contain an invalid value');
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length === 0) throw new Error('Allowed campaign ids are required');
  return ids;
}

function countString(value, label) {
  try {
    const count = BigInt(value ?? 0);
    if (count < 0n) throw new Error('negative');
    return count.toString();
  } catch {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
}

function instant(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid report timestamp: ${String(value)}`);
  }
  return date.toISOString();
}

function moscowMonthStartUtc(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid Moscow month boundary: ${String(value)}`);
  }
  // Europe/Moscow has a stable UTC+03 offset for the covered 2026 data. The
  // explicit conversion keeps calendar-month windows aligned with report SQL.
  const moscow = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  return new Date(Date.UTC(
    moscow.getUTCFullYear(),
    moscow.getUTCMonth(),
    1,
    -3,
    0,
    0,
    0,
  ));
}

function previousMoscowMonthStartUtc(value) {
  const current = moscowMonthStartUtc(value);
  const local = new Date(current.getTime() + 3 * 60 * 60 * 1000);
  return new Date(Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth() - 1,
    1,
    -3,
    0,
    0,
    0,
  ));
}

function buildParityWindows({ coverageFromUtc, coverageToUtc, asOfUtc }) {
  const coverageFrom = new Date(instant(coverageFromUtc));
  const coverageTo = new Date(instant(coverageToUtc));
  const asOf = new Date(instant(asOfUtc));
  const fromMs = coverageFrom.getTime();
  const toMs = coverageTo.getTime();
  if (fromMs >= toMs) throw new Error('Rollup parity coverage is empty');
  if (toMs - fromMs > 367 * 24 * 60 * 60 * 1000) {
    throw new Error('Rollup parity coverage exceeds 367 days');
  }

  const dayMs = 24 * 60 * 60 * 1000;
  // Month presets are wall-clock UI filters. Anchor them to the RR snapshot's
  // transaction_timestamp(), then intersect with the immutable rollup range.
  const currentMonthStart = moscowMonthStartUtc(asOf);
  const previousMonthStart = previousMoscowMonthStartUtc(asOf);
  const candidates = [
    { label: '1d', fromMs: toMs - dayMs, toMs },
    { label: '7d', fromMs: toMs - 7 * dayMs, toMs },
    { label: '30d', fromMs: toMs - 30 * dayMs, toMs },
    {
      label: 'current_month',
      fromMs: currentMonthStart.getTime(),
      toMs,
    },
    {
      label: 'previous_month',
      fromMs: previousMonthStart.getTime(),
      toMs: currentMonthStart.getTime(),
    },
    { label: 'full', fromMs, toMs },
  ];
  const byRange = new Map();
  for (const candidate of candidates) {
    const clippedFrom = Math.max(fromMs, candidate.fromMs);
    const clippedTo = Math.min(toMs, candidate.toMs);
    if (clippedFrom >= clippedTo) continue;
    const fromUtc = new Date(clippedFrom).toISOString();
    const toUtc = new Date(clippedTo).toISOString();
    const key = `${fromUtc}/${toUtc}`;
    const existing = byRange.get(key);
    if (existing) existing.labels.push(candidate.label);
    else byRange.set(key, { fromUtc, toUtc, labels: [candidate.label] });
  }
  const windows = Array.from(byRange.values());
  if (!windows.some((window) => window.labels.includes('full'))) {
    throw new Error('Full exact rollup coverage parity window is required');
  }
  return windows;
}

function canonicalCampaigns(value) {
  let rows = value;
  if (typeof value === 'string') {
    try {
      rows = JSON.parse(value);
    } catch {
      throw new Error('Invalid by_campaign JSON');
    }
  }
  if (!Array.isArray(rows)) throw new Error('Invalid by_campaign payload');
  return rows.map((raw) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error('Invalid by_campaign row');
    }
    const row = raw;
    return {
      campaign_id: String(row.campaign_id ?? ''),
      campaign_name: String(row.campaign_name ?? ''),
      score_code: row.score_code === null || row.score_code === undefined
        ? null
        : String(row.score_code),
      submitted: countString(row.submitted, 'campaign submitted count'),
      confirmed: countString(row.confirmed, 'campaign confirmed count'),
    };
  }).sort((left, right) => (
    left.campaign_id.localeCompare(right.campaign_id)
    || String(left.score_code).localeCompare(String(right.score_code))
    || left.campaign_name.localeCompare(right.campaign_name)
    || left.submitted.localeCompare(right.submitted)
    || left.confirmed.localeCompare(right.confirmed)
  ));
}

function canonicalizeSummary(row) {
  if (!row || typeof row !== 'object') {
    throw new Error('Report summary row is required');
  }
  const result = {};
  for (const field of SUMMARY_COUNT_FIELDS) {
    result[field] = countString(row[field], field);
  }
  result.pipeline_at = instant(row.pipeline_at);
  result.by_campaign = canonicalCampaigns(row.by_campaign);
  return result;
}

function assertSummaryParity(legacy, shadow, context = '') {
  const legacyJson = JSON.stringify(canonicalizeSummary(legacy));
  const shadowJson = JSON.stringify(canonicalizeSummary(shadow));
  if (legacyJson !== shadowJson) {
    throw new Error(`Client report parity mismatch${context ? ` (${context})` : ''}`);
  }
}

async function executeActivation({ mode, action, runId, repository }) {
  if (!repository || typeof repository.inspect !== 'function') {
    throw new Error('Activation repository is required');
  }
  if (mode !== 'dry-run' && mode !== 'apply') {
    throw new Error(`Invalid activation mode: ${String(mode)}`);
  }
  if (action === 'rollback') {
    if (mode === 'dry-run') return repository.inspect(null);
    return repository.rollback();
  }
  if (action === 'activate') {
    if (typeof repository.verifyParity !== 'function') {
      throw new Error('Parity verification is required before activation');
    }
    const inspection = await repository.inspect(runId);
    try {
      const parity = await repository.verifyParity(runId);
      if (mode === 'dry-run') {
        await repository.rollbackOpenParity();
        return { inspection, parity };
      }
      return await repository.activate(runId);
    } catch (error) {
      if (typeof repository.rollbackOpenParity === 'function') {
        await repository.rollbackOpenParity();
      }
      throw error;
    }
  }
  throw new Error(`Invalid activation action: ${String(action)}`);
}

class PostgresRollupActivationRepository {
  constructor({ client, clientUserId, allowedCampaignIds }) {
    if (!client || typeof client.query !== 'function') {
      throw new Error('A connected Postgres client is required');
    }
    this.client = client;
    this.clientUserId = assertUuid(clientUserId, 'client user id');
    this.allowedCampaignIds = Array.isArray(allowedCampaignIds)
      && allowedCampaignIds.length > 0
      ? normalizeAllowedCampaignIds(allowedCampaignIds)
      : [];
    this.parityTransactionRunId = null;
    this.parityVerified = false;
  }

  async inspect(runId) {
    if (runId === null) {
      const { rows } = await this.client.query(
        `SELECT
           activation.rollup_run_id::text AS active_run_id,
           activation.activated_at,
           run.status AS active_status,
           run.source_rows::text,
           run.source_job_days::text
         FROM public.client_report_large_score_rollup_activations AS activation
         JOIN public.client_report_large_score_rollup_runs AS run
           ON run.id = activation.rollup_run_id
          AND run.client_user_id = activation.client_user_id
         WHERE activation.client_user_id = $1::uuid`,
        [this.clientUserId],
      );
      return rows[0] || { active_run_id: null };
    }
    const { rows } = await this.client.query(
      `SELECT
         candidate.id::text AS candidate_run_id,
         candidate.status AS candidate_status,
         candidate.ready_at,
         candidate.source_rows::text,
         candidate.source_job_days::text,
         candidate.validation,
         activation.rollup_run_id::text AS active_run_id
       FROM public.client_report_large_score_rollup_runs AS candidate
       LEFT JOIN public.client_report_large_score_rollup_activations AS activation
         ON activation.client_user_id = candidate.client_user_id
       WHERE candidate.id = $1::uuid
         AND candidate.client_user_id = $2::uuid`,
      [assertUuid(runId, 'run-id'), this.clientUserId],
    );
    if (rows.length !== 1) throw new Error('Rollup run not found for client');
    return rows[0];
  }

  async verifyParity(runId) {
    if (this.allowedCampaignIds.length === 0) {
      throw new Error('Allowed campaign ids are required for parity verification');
    }
    const normalizedRunId = assertUuid(runId, 'run-id');
    if (this.parityTransactionRunId) {
      throw new Error('A parity transaction is already open');
    }
    await this.client.query(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ',
    );
    this.parityTransactionRunId = normalizedRunId;
    this.parityVerified = false;
    try {
      await this.client.query("SET LOCAL statement_timeout = '120s'");
      await this.client.query("SET LOCAL lock_timeout = '30s'");
      const boundsResult = await this.client.query(
        `SELECT
           (min(bucket.cohort_day)::timestamp
             AT TIME ZONE 'Europe/Moscow') AS from_utc,
           ((max(bucket.cohort_day) + 1)::timestamp
             AT TIME ZONE 'Europe/Moscow') AS to_utc,
           transaction_timestamp() AS as_of_utc
         FROM public.client_report_large_score_rollup_runs AS run
         JOIN public.client_report_large_score_rollup_buckets AS bucket
           ON bucket.rollup_run_id = run.id
          AND bucket.client_user_id = run.client_user_id
         WHERE run.id = $1::uuid
           AND run.client_user_id = $2::uuid
           AND run.status = 'ready'`,
        [normalizedRunId, this.clientUserId],
      );
      const bounds = boundsResult.rows[0] || {};
      const fromUtc = instant(bounds.from_utc);
      const toUtc = instant(bounds.to_utc);
      const asOfUtc = instant(bounds.as_of_utc);
      if (!fromUtc || !toUtc || !asOfUtc) {
        throw new Error('Ready rollup has no bounded cohort period');
      }
      const periodMs = new Date(toUtc).getTime() - new Date(fromUtc).getTime();
      if (periodMs <= 0 || periodMs > 367 * 24 * 60 * 60 * 1000) {
        throw new Error('Rollup parity period is invalid or exceeds 367 days');
      }

      const windows = buildParityWindows({
        coverageFromUtc: fromUtc,
        coverageToUtc: toUtc,
        asOfUtc,
      });

      let comparisons = 0;
      const campaignFilters = [null, ...this.allowedCampaignIds];
      for (const window of windows) {
        for (const scoreCode of SCORE_FILTERS) {
          for (const campaignId of campaignFilters) {
          const sharedParams = [
            this.clientUserId,
            window.fromUtc,
            window.toUtc,
            this.allowedCampaignIds,
            scoreCode,
            campaignId,
          ];
          const legacy = await this.client.query(
            `SELECT * FROM public.client_report_pipeline_summary(
               $1::uuid, $2::timestamptz, $3::timestamptz,
               $4::text[], $5::text, $6::text
             )`,
            sharedParams,
          );
          const shadow = await this.client.query(
            `SELECT * FROM public.client_report_pipeline_summary_shadow(
               $1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz,
               $5::text[], $6::text, $7::text
             )`,
            [this.clientUserId, normalizedRunId, ...sharedParams.slice(1)],
          );
          if (legacy.rows.length !== 1 || shadow.rows.length !== 1) {
            throw new Error('Report parity query returned an invalid row count');
          }
          assertSummaryParity(
            legacy.rows[0],
            shadow.rows[0],
            `windows=${window.labels.join('+')}, score=${scoreCode || 'all'}, campaign=${campaignId || 'all'}`,
          );
          comparisons += 1;
          }
        }
      }
      // The rollup stores the historical cache classification frozen at build
      // time. Comparing it with today's legacy calculation here detects cache
      // drift; activation remains in this same snapshot/transaction or fails.
      this.parityVerified = true;
      return { windows, comparisons };
    } catch (error) {
      await this.client.query('ROLLBACK').catch(() => {});
      this.parityTransactionRunId = null;
      this.parityVerified = false;
      throw error;
    }
  }

  async rollbackOpenParity() {
    if (!this.parityTransactionRunId) return;
    try {
      await this.client.query('ROLLBACK');
    } finally {
      this.parityTransactionRunId = null;
      this.parityVerified = false;
    }
  }

  async activate(runId) {
    const normalizedRunId = assertUuid(runId, 'run-id');
    if (
      !this.parityVerified
      || this.parityTransactionRunId !== normalizedRunId
    ) {
      throw new Error(
        'Activation requires a verified open parity transaction for this run',
      );
    }
    try {
      const { rows } = await this.client.query(
        `SELECT public.activate_client_report_large_score_rollup(
           $1::uuid, $2::uuid
         )::text AS rollup_run_id`,
        [this.clientUserId, normalizedRunId],
      );
      if (rows.length !== 1 || rows[0].rollup_run_id !== normalizedRunId) {
        throw new Error('Activation returned an invalid result');
      }
      await this.client.query('COMMIT');
      this.parityTransactionRunId = null;
      this.parityVerified = false;
      return rows[0].rollup_run_id;
    } catch (error) {
      await this.client.query('ROLLBACK').catch(() => {});
      this.parityTransactionRunId = null;
      this.parityVerified = false;
      throw error;
    }
  }

  async rollback() {
    const { rows } = await this.client.query(
      `SELECT public.deactivate_client_report_large_score_rollup(
         $1::uuid
       )::text AS rollup_run_id`,
      [this.clientUserId],
    );
    return rows[0] ? rows[0].rollup_run_id : null;
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  loadEnvFiles();
  const clientUserId = assertUuid(
    process.env.CLIENT_REPORT_ROLLUP_CLIENT_USER_ID,
    'CLIENT_REPORT_ROLLUP_CLIENT_USER_ID',
  );
  const allowedCampaignIds = options.action === 'activate'
    ? normalizeAllowedCampaignIds(
      String(process.env.CLIENT_REPORT_ROLLUP_ALLOWED_CAMPAIGN_IDS || '').split(','),
    )
    : [];
  const dbUrl = resolveDbUrl();
  if (!dbUrl) throw new Error('Portal database URL is not configured');
  const ssl = shouldUseSsl(dbUrl) ? { rejectUnauthorized: false } : undefined;
  const baseConfig = await connectionConfigWithIPv4(dbUrl, ssl);
  const client = new Client({
    ...baseConfig,
    application_name: 'client-report-large-score-rollup-activation',
  });
  await client.connect();
  try {
    const repository = new PostgresRollupActivationRepository({
      client,
      clientUserId,
      allowedCampaignIds,
    });
    const result = await executeActivation({ ...options, repository });
    console.log('[client-report-rollup-activation]', JSON.stringify(result));
    return result;
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      '[client-report-rollup-activation] failed:',
      error && error.message ? error.message : error,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  parseCliArgs,
  normalizeAllowedCampaignIds,
  canonicalizeSummary,
  assertSummaryParity,
  buildParityWindows,
  executeActivation,
  PostgresRollupActivationRepository,
  main,
};
