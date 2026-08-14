/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Selects (or rolls back) one client's verified large-score report rollup.
 * No flags ever mutate; --apply is required for activation or rollback.
 */
const { Client } = require('pg');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

function createProgressReporter({
  filePath = process.env.CLIENT_REPORT_ROLLUP_PROGRESS_FILE || null,
  tmpDir = os.tmpdir(),
  pid = process.pid,
  now = () => new Date(),
  appendFileSync = fs.appendFileSync,
  writeLine = console.log,
} = {}) {
  const progressPath = filePath || path.join(
    tmpDir,
    `client-report-large-score-rollup-activation-${pid}-${now().toISOString().replace(/[:.]/g, '-')}.jsonl`,
  );
  return (event) => {
    const line = JSON.stringify(event);
    appendFileSync(progressPath, `${line}\n`, {
      encoding: 'utf8',
      flag: 'a',
      mode: 0o600,
    });
    writeLine('[client-report-rollup-activation:progress]', line);
  };
}

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

function matrixWindowRows(windows) {
  return windows.map((window, index) => ({
    key: `window_${index + 1}`,
    labels: [...window.labels],
    from_utc: window.fromUtc,
    to_utc: window.toUtc,
  }));
}

function matrixContextKey({ window_key: windowKey, score_code: scoreCode, campaign_id: campaignId }) {
  return JSON.stringify([
    String(windowKey || ''),
    scoreCode === null || scoreCode === undefined ? null : String(scoreCode),
    campaignId === null || campaignId === undefined ? null : String(campaignId),
  ]);
}

function mismatchContext(cell) {
  if (!cell || typeof cell !== 'object') return null;
  return {
    window_key: String(cell.window_key || ''),
    labels: Array.isArray(cell.labels) ? cell.labels.map(String) : [],
    from_utc: cell.from_utc == null ? null : instant(cell.from_utc),
    to_utc: cell.to_utc == null ? null : instant(cell.to_utc),
    score_code: cell.score_code == null ? null : String(cell.score_code),
    campaign_id: cell.campaign_id == null ? null : String(cell.campaign_id),
    mismatch_context: cell.mismatch_context || null,
  };
}

function assertMatrixParity(payload, { windows, allowedCampaignIds }) {
  let result = payload;
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result);
    } catch {
      throw new Error('Parity matrix returned invalid JSON');
    }
  }
  if (!result || typeof result !== 'object') {
    throw new Error('Parity matrix result is required');
  }
  if (result.contract_verified !== true) {
    throw new Error('Parity matrix function contract drift was not verified');
  }
  if (result.coverage_verified !== true) {
    throw new Error('Parity matrix window/campaign coverage was not verified');
  }
  if (Number(result.source_scans) !== 1) {
    throw new Error('Parity matrix must prepare the live source in exactly one scan');
  }
  if (!Array.isArray(result.cells) || !Array.isArray(result.mismatches)) {
    throw new Error('Parity matrix cells and mismatches are required');
  }

  const expected = new Map();
  for (const window of windows) {
    for (const scoreCode of SCORE_FILTERS) {
      for (const campaignId of [null, ...allowedCampaignIds]) {
        const context = {
          window_key: window.key,
          labels: window.labels,
          from_utc: window.from_utc,
          to_utc: window.to_utc,
          score_code: scoreCode,
          campaign_id: campaignId,
        };
        expected.set(matrixContextKey(context), context);
      }
    }
  }
  const checkedCells = Number(result.checked_cells);
  if (!Number.isSafeInteger(checkedCells) || checkedCells !== expected.size) {
    throw new Error(
      `Parity matrix cardinality mismatch: expected=${expected.size}, checked=${String(result.checked_cells)}`,
    );
  }
  if (result.cells.length !== expected.size) {
    throw new Error(
      `Parity matrix cell count mismatch: expected=${expected.size}, actual=${result.cells.length}`,
    );
  }

  const seen = new Set();
  let firstMismatch = result.mismatches[0] || null;
  for (const rawCell of result.cells) {
    if (!rawCell || typeof rawCell !== 'object') {
      throw new Error('Parity matrix contains an invalid cell');
    }
    const key = matrixContextKey(rawCell);
    const expectedContext = expected.get(key);
    if (!expectedContext || seen.has(key)) {
      throw new Error(`Parity matrix contains an unexpected or duplicate context: ${key}`);
    }
    seen.add(key);
    const actualContext = mismatchContext(rawCell);
    if (
      JSON.stringify(actualContext.labels) !== JSON.stringify(expectedContext.labels)
      || actualContext.from_utc !== expectedContext.from_utc
      || actualContext.to_utc !== expectedContext.to_utc
    ) {
      throw new Error(`Parity matrix context metadata mismatch: ${key}`);
    }
    if (rawCell.matched !== true && !firstMismatch) firstMismatch = rawCell;
  }
  if (seen.size !== expected.size) {
    throw new Error(
      `Parity matrix context coverage mismatch: expected=${expected.size}, actual=${seen.size}`,
    );
  }
  if (result.mismatches.length > 0 || firstMismatch) {
    const context = mismatchContext(firstMismatch);
    const labels = context && context.labels.length > 0
      ? context.labels.join('+')
      : context && context.window_key;
    const error = new Error(
      `Client report parity mismatch (window=${labels || 'unknown'}, score=${context && context.score_code ? context.score_code : 'all'}, campaign=${context && context.campaign_id ? context.campaign_id : 'all'})`,
    );
    error.parityContext = context;
    throw error;
  }
  return {
    comparisons: expected.size,
    sourceScans: 1,
    contractVerified: true,
    coverageVerified: true,
    windows,
  };
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
      const parity = await repository.verifyParity(runId, {
        readOnly: mode === 'dry-run',
      });
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
  constructor({ client, clientUserId, allowedCampaignIds, progress = null }) {
    if (!client || typeof client.query !== 'function') {
      throw new Error('A connected Postgres client is required');
    }
    this.client = client;
    this.clientUserId = assertUuid(clientUserId, 'client user id');
    this.allowedCampaignIds = Array.isArray(allowedCampaignIds)
      && allowedCampaignIds.length > 0
      ? normalizeAllowedCampaignIds(allowedCampaignIds)
      : [];
    if (progress !== null && typeof progress !== 'function') {
      throw new Error('Progress reporter must be a function');
    }
    this.progress = progress;
    this.parityTransactionRunId = null;
    this.parityVerified = false;
    this.parityReadOnly = false;
    this.parityStage = null;
  }

  reportProgress(stage, details = {}) {
    if (!this.progress) return;
    this.progress({
      stage,
      client_user_id: this.clientUserId,
      run_id: this.parityTransactionRunId,
      at: new Date().toISOString(),
      ...details,
    });
  }

  async acquireClientLock() {
    const { rows } = await this.client.query(
      `SELECT pg_try_advisory_xact_lock(
         hashtextextended('client-report-large-score-rollup:' || $1::text, 0)
       ) AS acquired`,
      [this.clientUserId],
    );
    if (rows.length !== 1 || rows[0].acquired !== true) {
      throw new Error('Another client report rollup activation operation is running');
    }
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

  async verifyParity(runId, { readOnly = false } = {}) {
    if (this.allowedCampaignIds.length === 0) {
      throw new Error('Allowed campaign ids are required for parity verification');
    }
    const normalizedRunId = assertUuid(runId, 'run-id');
    if (this.parityTransactionRunId) {
      throw new Error('A parity transaction is already open');
    }
    await this.client.query(readOnly
      ? 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'
      : 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    this.parityTransactionRunId = normalizedRunId;
    this.parityVerified = false;
    this.parityReadOnly = readOnly;
    this.parityStage = 'client_lock';
    try {
      await this.acquireClientLock();
      this.reportProgress('transaction_started', { read_only: readOnly });
      await this.client.query("SET LOCAL statement_timeout = '900s'");
      await this.client.query("SET LOCAL lock_timeout = '30s'");
      this.parityStage = 'bounds';
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
      const matrixWindows = matrixWindowRows(windows);
      const expectedCells = matrixWindows.length
        * SCORE_FILTERS.length
        * (this.allowedCampaignIds.length + 1);
      this.reportProgress('bounds_loaded', {
        coverage_from_utc: fromUtc,
        coverage_to_utc: toUtc,
        as_of_utc: asOfUtc,
        windows: matrixWindows.length,
        expected_cells: expectedCells,
      });
      this.parityStage = 'matrix_compare';
      this.reportProgress('matrix_started', {
        expected_cells: expectedCells,
        windows: matrixWindows,
        score_codes: SCORE_FILTERS,
        campaign_ids: [null, ...this.allowedCampaignIds],
      });
      const matrixResult = await this.client.query(
        `SELECT public.verify_client_report_large_score_rollup_matrix(
           $1::uuid, $2::uuid, $3::jsonb, $4::text[]
         ) AS result`,
        [
          this.clientUserId,
          normalizedRunId,
          JSON.stringify(matrixWindows),
          this.allowedCampaignIds,
        ],
      );
      if (matrixResult.rows.length !== 1) {
        throw new Error('Parity matrix RPC returned an invalid row count');
      }
      const parity = assertMatrixParity(matrixResult.rows[0].result, {
        windows: matrixWindows,
        allowedCampaignIds: this.allowedCampaignIds,
      });
      this.reportProgress('matrix_verified', {
        checked_cells: parity.comparisons,
        source_scans: parity.sourceScans,
        contract_verified: parity.contractVerified,
        coverage_verified: parity.coverageVerified,
      });
      this.parityVerified = true;
      this.parityStage = 'verified';
      return parity;
    } catch (error) {
      await this.client.query('ROLLBACK').catch(() => {});
      const stage = this.parityStage || 'unknown';
      const context = error && error.parityContext
        ? error.parityContext
        : null;
      this.parityTransactionRunId = null;
      this.parityVerified = false;
      this.parityReadOnly = false;
      this.parityStage = null;
      try {
        this.reportProgress('failed', {
          run_id: normalizedRunId,
          failed_stage: stage,
          context,
          error: error && error.message ? error.message : String(error),
        });
      } catch {
        // Preserve the operation error after the transaction is safely closed.
      }
      const message = error && error.message ? error.message : String(error);
      if (message.includes(`stage=${stage}`)) throw error;
      const wrapped = new Error(`${message} (stage=${stage})`);
      if (context) wrapped.parityContext = context;
      throw wrapped;
    }
  }

  async rollbackOpenParity() {
    if (!this.parityTransactionRunId) return;
    const runId = this.parityTransactionRunId;
    try {
      await this.client.query('ROLLBACK');
    } finally {
      this.parityTransactionRunId = null;
      this.parityVerified = false;
      this.parityReadOnly = false;
      this.parityStage = null;
      this.reportProgress('rolled_back', { run_id: runId });
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
      if (this.parityReadOnly) {
        throw new Error('Activation cannot use a read-only parity transaction');
      }
      this.parityStage = 'activation';
      this.reportProgress('activation_started');
      const { rows } = await this.client.query(
        `SELECT public.activate_client_report_large_score_rollup(
           $1::uuid, $2::uuid
         )::text AS rollup_run_id`,
        [this.clientUserId, normalizedRunId],
      );
      if (rows.length !== 1 || rows[0].rollup_run_id !== normalizedRunId) {
        throw new Error('Activation returned an invalid result');
      }
      this.parityStage = 'commit';
      this.reportProgress('commit_started');
      await this.client.query('COMMIT');
      this.parityTransactionRunId = null;
      this.parityVerified = false;
      this.parityReadOnly = false;
      this.parityStage = null;
      try {
        this.reportProgress('committed', {
          run_id: normalizedRunId,
          activated_run_id: normalizedRunId,
        });
      } catch {
        // Commit is already durable; reporting must not create a false failure.
      }
      return rows[0].rollup_run_id;
    } catch (error) {
      await this.client.query('ROLLBACK').catch(() => {});
      const stage = this.parityStage || 'activation';
      this.parityTransactionRunId = null;
      this.parityVerified = false;
      this.parityReadOnly = false;
      this.parityStage = null;
      try {
        this.reportProgress('failed', {
          run_id: normalizedRunId,
          failed_stage: stage,
          error: error && error.message ? error.message : String(error),
        });
      } catch {}
      throw error;
    }
  }

  async rollback() {
    await this.client.query('BEGIN TRANSACTION');
    try {
      await this.acquireClientLock();
      const { rows } = await this.client.query(
        `SELECT public.deactivate_client_report_large_score_rollup(
           $1::uuid
         )::text AS rollup_run_id`,
        [this.clientUserId],
      );
      await this.client.query('COMMIT');
      return rows[0] ? rows[0].rollup_run_id : null;
    } catch (error) {
      await this.client.query('ROLLBACK').catch(() => {});
      throw error;
    }
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
      progress: createProgressReporter(),
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
  assertMatrixParity,
  createProgressReporter,
  executeActivation,
  PostgresRollupActivationRepository,
  main,
};
