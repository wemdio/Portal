import 'server-only';
import { Pool } from 'pg';

/**
 * Read-only connection to the analytics dataset DB (`instantly_dataset` on the
 * production server, 139.60.162.12:35432). This is the studio's structured copy of all
 * Instantly outreach — see wiki/CLAUDE.md. The operational `instantly` DB is
 * reached via supabaseInstantly (PostgREST); THIS is a plain Postgres we query
 * with pg, the same DB the app/scripts/instantly-dataset/* scripts use.
 *
 * Module-level singleton pool so we don't open a connection per request.
 */
const connectionString = process.env.INSTANTLY_DATASET_DB_URL;

let pool: Pool | null = null;

function getPool(): Pool | null {
  if (!connectionString) return null;
  if (!pool) {
    pool = new Pool({
      connectionString,
      // Дашборд «Нагрузка почт» пускает 4 запроса через Promise.all — при max: 3
      // один из них гарантированно ждал освобождения коннекта на каждой загрузке,
      // а при двух одновременных пользователях всё вставало в очередь по 3.
      // 10 — с запасом под параллельные страницы и всё ещё скромно для Postgres.
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
      // statement-level guard: insight queries are scoped by campaign_id and
      // should be sub-second; fail fast rather than hang a request.
      statement_timeout: 15_000,
    });
    pool.on('error', (err) => {
      console.error('[instantlyDataset] idle pool error:', err.message);
    });
  }
  return pool;
}

export function isDatasetConfigured(): boolean {
  return Boolean(connectionString);
}

export async function datasetQuery<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const p = getPool();
  if (!p) throw new Error('INSTANTLY_DATASET_DB_URL not configured');
  const res = await p.query(text, params);
  return res.rows as T[];
}

/**
 * Keep mv_subject_ab_within_campaign reasonably fresh WITHOUT a prod cron, so
 * the whole feature ships via merge+redeploy (the prod sync.mjs copy is updated
 * by a manual script, not CI). Called fire-and-forget from the insights route.
 *
 * The atomic claim — UPDATE ... WHERE refreshed_at < cutoff RETURNING — lets
 * exactly ONE concurrent request win the right to refresh (pool-safe; no
 * session advisory locks). REFRESH ... CONCURRENTLY can't run in a txn and
 * doesn't block reads. We don't await it: prod runs `next start` (a persistent
 * Node server), so the detached refresh completes after the response is sent.
 */
let refreshInFlight = false;
export async function refreshAbIfStale(maxAgeHours = 20): Promise<void> {
  const p = getPool();
  if (!p || refreshInFlight) return;
  try {
    const claim = await p.query(
      `UPDATE insights_mv_state SET refreshed_at = now()
       WHERE name = 'mv_subject_ab_within_campaign'
         AND refreshed_at < now() - ($1 || ' hours')::interval
       RETURNING 1`,
      [String(maxAgeHours)],
    );
    if (claim.rowCount === 0) return; // fresh, or another request already claimed it
    refreshInFlight = true;
    p.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_subject_ab_within_campaign')
      .catch((e: Error) => console.error('[instantlyDataset] mv refresh failed:', e.message))
      .finally(() => { refreshInFlight = false; });
  } catch (e) {
    console.error('[instantlyDataset] refresh claim failed:', (e as Error).message);
  }
}
