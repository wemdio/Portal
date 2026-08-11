import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  twoGisDatasetConnect,
  twoGisDatasetExportConnect,
  twoGisDatasetQuery,
} from '@/lib/twoGisDataset';
import { TWO_GIS_IMPORT_LOCK } from './importSnapshot';
import {
  buildTwoGisCountQuery,
  buildTwoGisExportBatchQuery,
  buildTwoGisSearchQuery,
  normalizeTwoGisFilters,
} from './query';
import type {
  TwoGisCard,
  TwoGisFacets,
  TwoGisFilters,
} from './types';
import { TWO_GIS_MAX_EXPORT_ROWS } from './types';

const EXPORT_TICKET_TTL_MINUTES = 15;

/**
 * Id текущего снапшота 2GIS-датасета — iterateTwoGisCards требует его явно
 * (стрим привязан к снапшоту, чтобы импорт нового среза не ломал курсор).
 * null → датасет недоступен, прогон пропускаем.
 *
 * Общая точка для обоих пайплайнов-потребителей (gisSignalOutreach и
 * OutreachOS top-up) — не дублировать.
 */
export async function getLatestTwoGisSnapshotId(): Promise<number | null> {
  try {
    const rows = await twoGisDatasetQuery<{ id: string | number }>(
      `SELECT id
       FROM public.dataset_snapshots
       ORDER BY imported_at DESC
       LIMIT 1`,
    );
    const id = Number(rows[0]?.id);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export async function countTwoGisCards(filters: TwoGisFilters): Promise<number> {
  const query = buildTwoGisCountQuery(filters);
  const rows = await twoGisDatasetQuery<{ count: string | number }>(query.text, query.params);
  return Number(rows[0]?.count ?? 0);
}

export async function searchTwoGisCards(
  filters: TwoGisFilters,
  options: { limit?: number; cursor?: string } = {},
): Promise<{ rows: TwoGisCard[]; nextCursor: string | null }> {
  const query = buildTwoGisSearchQuery(filters, options);
  const rows = await twoGisDatasetQuery<TwoGisCard>(query.text, query.params);
  const requested = Number.isFinite(options.limit) ? Number(options.limit) : 100;
  const limit = Math.min(Math.max(Math.trunc(requested), 1), 200);
  return {
    rows,
    nextCursor: rows.length === limit ? rows.at(-1)?.id ?? null : null,
  };
}

export async function getTwoGisFacets(): Promise<TwoGisFacets> {
  const [cities, categories, subcategories, snapshots] = await Promise.all([
    twoGisDatasetQuery<{ value: string; count: string | number }>(
      'SELECT value, row_count AS count FROM public.facet_cities ORDER BY row_count DESC, value ASC',
    ),
    twoGisDatasetQuery<{ value: string; count: string | number }>(
      'SELECT value, row_count AS count FROM public.facet_categories ORDER BY row_count DESC, value ASC',
    ),
    twoGisDatasetQuery<{ category: string; value: string; count: string | number }>(
      `SELECT category, value, row_count AS count
       FROM public.facet_subcategories
       ORDER BY category ASC, row_count DESC, value ASC`,
    ),
    twoGisDatasetQuery<{ scope: string; snapshot_date: string | Date; accepted_rows: string | number }>(
      `SELECT scope, snapshot_date, accepted_rows
       FROM public.dataset_snapshots
       ORDER BY imported_at DESC
       LIMIT 1`,
    ),
  ]);
  const snapshot = snapshots[0];
  if (!snapshot) {
    throw new Error('2GIS dataset snapshot metadata is missing');
  }
  const dateValue = snapshot?.snapshot_date;
  const date = dateValue instanceof Date
    ? dateValue.toISOString().slice(0, 10)
    : String(dateValue ?? '2026-07-26').slice(0, 10);

  return {
    cities: cities.map((row) => ({ value: row.value, count: Number(row.count) })),
    categories: categories.map((row) => ({ value: row.value, count: Number(row.count) })),
    subcategories: subcategories.map((row) => ({
      category: row.category,
      value: row.value,
      count: Number(row.count),
    })),
    snapshot: {
      scope: snapshot.scope,
      date,
      rows: Number(snapshot.accepted_rows),
    },
  };
}

function hashTicket(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function createTwoGisExportTicket(
  userId: string,
  filters: TwoGisFilters,
): Promise<
  | { token: string; rowCount: number }
  | { limited: true; rowCount: number; maxRows: number }
  | null
> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashTicket(token);
  const normalizedFilters = normalizeTwoGisFilters(filters);
  const client = await twoGisDatasetConnect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query(
      'SELECT pg_advisory_xact_lock_shared(hashtext($1))',
      [TWO_GIS_IMPORT_LOCK],
    );

    const countQuery = buildTwoGisCountQuery(normalizedFilters);
    const countResult = await client.query<{ count: string | number }>(
      countQuery.text,
      countQuery.params,
    );
    const rowCount = Number(countResult.rows[0]?.count ?? 0);
    if (rowCount === 0) {
      await client.query('COMMIT');
      transactionOpen = false;
      return null;
    }
    if (rowCount > TWO_GIS_MAX_EXPORT_ROWS) {
      await client.query('COMMIT');
      transactionOpen = false;
      return {
        limited: true,
        rowCount,
        maxRows: TWO_GIS_MAX_EXPORT_ROWS,
      };
    }

    const snapshot = await client.query<{ id: string | number }>(
      `SELECT id
       FROM public.dataset_snapshots
       ORDER BY imported_at DESC
       LIMIT 1`,
    );
    const snapshotId = Number(snapshot.rows[0]?.id);
    if (!Number.isSafeInteger(snapshotId) || snapshotId <= 0) {
      throw new Error('Cannot create 2GIS export ticket without snapshot metadata');
    }

    const inserted = await client.query<{ token_hash: string }>(
      `WITH expired AS (
         DELETE FROM public.export_tickets
         WHERE expires_at <= now()
       )
       INSERT INTO public.export_tickets
         (token_hash, user_id, snapshot_id, filters, row_count, expires_at)
       VALUES (
         $1,
         $2,
         $3,
         $4::jsonb,
         $5,
         now() + ($6 || ' minutes')::interval
       )
       RETURNING token_hash`,
      [
        tokenHash,
        userId,
        snapshotId,
        JSON.stringify(normalizedFilters),
        rowCount,
        String(EXPORT_TICKET_TTL_MINUTES),
      ],
    );
    if (!inserted.rows[0]) {
      throw new Error('2GIS export ticket was not stored');
    }

    await client.query('COMMIT');
    transactionOpen = false;
    return { token, rowCount };
  } catch (error) {
    if (transactionOpen) {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getTwoGisExportTicket(
  token: string,
): Promise<{
  filters: TwoGisFilters;
  rowCount: number;
  snapshotId: number;
} | null> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return null;
  const rows = await twoGisDatasetQuery<{
    filters: TwoGisFilters;
    row_count: string | number;
    snapshot_id: string | number;
  }>(
    `DELETE FROM public.export_tickets
     WHERE token_hash = $1
       AND expires_at > now()
     RETURNING filters, row_count, snapshot_id`,
    [hashTicket(token)],
  );
  if (!rows[0]) return null;
  return {
    filters: normalizeTwoGisFilters(rows[0].filters ?? {}),
    rowCount: Number(rows[0].row_count),
    snapshotId: Number(rows[0].snapshot_id),
  };
}

export async function* iterateTwoGisCards(
  filters: TwoGisFilters,
  options: {
    batchSize?: number;
    snapshotId: number;
    client?: PoolClient;
  },
): AsyncGenerator<TwoGisCard[]> {
  const requested = Number.isFinite(options.batchSize) ? Number(options.batchSize) : 5_000;
  const batchSize = Math.min(Math.max(Math.trunc(requested), 1), 10_000);
  let cursor: string | undefined;
  const client = options.client ?? await twoGisDatasetExportConnect();
  let lockHeld = false;

  try {
    await client.query(
      'SELECT pg_advisory_lock_shared(hashtext($1))',
      [TWO_GIS_IMPORT_LOCK],
    );
    lockHeld = true;

    const snapshot = await client.query<{ id: string | number }>(
      `SELECT id
       FROM public.dataset_snapshots
       ORDER BY imported_at DESC
       LIMIT 1`,
    );
    if (Number(snapshot.rows[0]?.id) !== options.snapshotId) {
      throw new Error('2GIS snapshot changed; create a new export ticket');
    }

    for (;;) {
      const query = buildTwoGisExportBatchQuery(filters, { batchSize, cursor });
      const result = await client.query<TwoGisCard>(query.text, query.params);
      const rows = result.rows;
      if (rows.length === 0) return;
      yield rows;
      if (rows.length < batchSize) return;
      cursor = rows.at(-1)?.id;
      if (!cursor) return;
    }
  } finally {
    if (lockHeld) {
      await client
        .query(
          'SELECT pg_advisory_unlock_shared(hashtext($1))',
          [TWO_GIS_IMPORT_LOCK],
        )
        .catch((error: unknown) => {
          console.error(
            '[2gis-parser] failed to release snapshot lock:',
            error instanceof Error ? error.message : String(error),
          );
        });
    }
    client.release();
  }
}
