import 'server-only';
import { Pool } from 'pg';

/**
 * Read-only connection to the analytics dataset DB (`instantly_dataset` on the
 * DB server, 144.31.54.166:35432). This is the studio's structured copy of all
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
      max: 3,
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
