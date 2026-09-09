/** Shared LIST /emails gate for standalone dataset scripts. No provider calls.
 * Uses the SAME main-Portal functions/account key as the application, never the
 * analytics/Instantly operational DB. Missing storage is a hard deferral.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export class DatasetEmailReadDeferredError extends Error {
  constructor(reason, retryAfterMs = 30_000) {
    super(`Instantly email read deferred: ${reason}; retry after ${Math.ceil(retryAfterMs)} ms`);
    this.name = 'DatasetEmailReadDeferredError';
    this.emailReadDeferred = true;
    this.noRetry = true;
    this.retryAfterMs = retryAfterMs;
  }
}

export function createDatasetEmailReadBudget(env, {
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  createPool,
  accountId = 'main',
} = {}) {
  const account = String(accountId).trim().toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-') || 'main';
  const maxWaitRaw = Number(env.INSTANTLY_EMAIL_READ_BUDGET_MAX_WAIT_MS ?? 300_000);
  const maxWait = Number.isFinite(maxWaitRaw) && maxWaitRaw > 0 ? Math.min(3_600_000, maxWaitRaw) : 300_000;
  const restUrl = String(env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/+$/, '');
  const restKey = env.SUPABASE_SERVICE_ROLE_KEY;
  let pool;
  let localUntil = 0;

  function mainPool() {
    if (pool) return pool;
    const raw = env.MAIN_DB_URL;
    let parsed;
    try { parsed = new URL(raw); } catch { throw new DatasetEmailReadDeferredError('main_budget_storage_unavailable'); }
    // MAIN_DB_URL is already provisioned for sync-portal-mirror from the
    // application's server-side DATABASE_URL. Never infer it from analytics.
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
        raw === env.INSTANTLY_DATASET_DB_URL ||
        ['instantly', 'instantly_dataset'].includes(decodeURIComponent(parsed.pathname.slice(1)))) {
      throw new DatasetEmailReadDeferredError('main_budget_storage_unavailable');
    }
    const build = createPool ?? ((config) => new (require('pg').Pool)(config));
    pool = build({ connectionString: raw, max: 1, connectionTimeoutMillis: 2500,
      idleTimeoutMillis: 1000, allowExitOnIdle: true, statement_timeout: 2500, query_timeout: 2500 });
    // An idle disconnect is not permission to bypass storage on the next read.
    pool.on?.('error', () => {});
    return pool;
  }

  async function rpc(name, parameters) {
    try {
      if (restUrl && restKey) {
        const response = await fetchImpl(`${restUrl}/rest/v1/rpc/${name}`, {
          method: 'POST',
          headers: { apikey: restKey, Authorization: `Bearer ${restKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(parameters), signal: AbortSignal.timeout(2500),
        });
        if (!response.ok) throw new Error('main budget RPC unavailable');
        return await response.json();
      }
      const values = name === 'instantly_reserve_email_read'
        ? [parameters.p_account, parameters.p_priority]
        : [parameters.p_account, parameters.p_retry_after_ms];
      // Function name is a private fixed call site, never provider/user input.
      const sql = name === 'instantly_reserve_email_read'
        ? 'select public.instantly_reserve_email_read($1, $2) as result'
        : 'select public.instantly_defer_email_reads($1, $2) as result';
      const result = await mainPool().query(sql, values);
      return result.rows?.[0]?.result;
    } catch (error) {
      if (error?.emailReadDeferred) throw error;
      throw new DatasetEmailReadDeferredError('main_budget_storage_unavailable');
    }
  }

  async function waitForSlot() {
    const deadline = now() + maxWait;
    for (;;) {
      const remaining = deadline - now();
      if (remaining <= 0) throw new DatasetEmailReadDeferredError('budget_wait_exhausted');
      let wait = localUntil - now();
      if (wait <= 0) {
        const result = await rpc('instantly_reserve_email_read', { p_account: account, p_priority: 'recovery' });
        if (result?.granted === true && result.retry_after_ms === 0) return;
        if (result?.granted !== false || !['budget', 'cooldown'].includes(result.reason) ||
            typeof result.retry_after_ms !== 'number' || !Number.isFinite(result.retry_after_ms) || result.retry_after_ms <= 0) {
          throw new DatasetEmailReadDeferredError('main_budget_storage_unavailable');
        }
        wait = result.retry_after_ms;
      }
      // Batch work waits for an actual shared slot; it never converts its own
      // timeout into fail-open traffic. No paid AI/provider request occurs here.
      if (wait >= deadline - now()) throw new DatasetEmailReadDeferredError('budget_wait_exhausted', wait);
      await sleep(Math.max(100, wait));
    }
  }

  async function cooldown(retryAfter) {
    const value = String(retryAfter ?? '').trim();
    const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
    const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now();
    const wait = Number.isFinite(parsed) && parsed >= 0 && parsed < Number.MAX_SAFE_INTEGER
      ? Math.max(1000, Math.ceil(parsed)) : 60_000 + Math.floor(Math.random() * 10_000);
    localUntil = Math.max(localUntil, now() + wait);
    const result = await rpc('instantly_defer_email_reads', { p_account: account, p_retry_after_ms: wait });
    if (result?.deferred !== true || typeof result.retry_after_ms !== 'number' ||
        !Number.isFinite(result.retry_after_ms) || result.retry_after_ms <= 0) {
      throw new DatasetEmailReadDeferredError('main_budget_storage_unavailable');
    }
    localUntil = Math.max(localUntil, now() + result.retry_after_ms);
    return Math.max(wait, result.retry_after_ms);
  }

  return { waitForSlot, cooldown, close: async () => { if (pool) await pool.end(); } };
}
