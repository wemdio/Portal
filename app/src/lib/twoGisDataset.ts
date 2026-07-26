import 'server-only';
import { Pool, type PoolClient } from 'pg';
import { assertTwoGisDatasetTarget } from '@/lib/twoGis/importGuard';

const connectionString = process.env.TWOGIS_DATASET_DB_URL;
let pool: Pool | null = null;
let exportPool: Pool | null = null;
let targetVerification: Promise<void> | null = null;

function createPool(
  max: number,
  applicationName: string,
): Pool {
  const created = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    statement_timeout: 60_000,
    application_name: applicationName,
  });
  created.on('error', (error) => {
    console.error(`[${applicationName}] idle pool error:`, error.message);
  });
  return created;
}

function getPool(): Pool | null {
  if (!connectionString) return null;
  if (!pool) {
    pool = createPool(3, 'portal-2gis-interactive');
  }
  return pool;
}

function getExportPool(): Pool | null {
  if (!connectionString) return null;
  if (!exportPool) {
    exportPool = createPool(2, 'portal-2gis-export');
  }
  return exportPool;
}

async function getVerifiedPool(): Promise<Pool> {
  const activePool = getPool();
  if (!activePool) throw new Error('TWOGIS_DATASET_DB_URL not configured');
  if (!targetVerification) {
    targetVerification = assertTwoGisDatasetTarget({
      query: async (text: string, params?: unknown[]) => {
        const result = await activePool.query(text, params);
        return { rows: result.rows };
      },
    }).catch((error) => {
      targetVerification = null;
      throw error;
    });
  }
  await targetVerification;
  return activePool;
}

export function isTwoGisDatasetConfigured(): boolean {
  return Boolean(connectionString);
}

export async function twoGisDatasetQuery<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const activePool = await getVerifiedPool();
  const result = await activePool.query(text, params);
  return result.rows as T[];
}

export async function twoGisDatasetConnect(): Promise<PoolClient> {
  const activePool = await getVerifiedPool();
  return activePool.connect();
}

export async function twoGisDatasetExportConnect(): Promise<PoolClient> {
  await getVerifiedPool();
  const activePool = getExportPool();
  if (!activePool) throw new Error('TWOGIS_DATASET_DB_URL not configured');
  return activePool.connect();
}
