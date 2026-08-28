import type { SupabaseClient } from '@supabase/supabase-js';
import { latestSeasonalActivationAt } from './launchPortfolio';
import { seasonalityInputHash } from './launchTemplate';
import {
  buildRuSeasonalityPrioritySnapshot,
  readStoredRuSeasonality,
} from './ruSeasonality';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const REFRESHABLE_STATUSES = new Set(['prepared', 'queued']);
const REFRESH_PAGE_SIZE = 200;
const MAX_REFRESH_ITEMS = 10_000;

export type VeLaunchTimingRefreshCode =
  | 'VE_LAUNCH_TIMING_ITEM_INVALID'
  | 'VE_LAUNCH_TIMING_HASH_MISMATCH'
  | 'VE_LAUNCH_TIMING_RUN_DAYS_INVALID'
  | 'VE_LAUNCH_TIMING_READ_FAILED'
  | 'VE_LAUNCH_TIMING_REFRESH_FAILED';

export class VeLaunchTimingRefreshError extends Error {
  constructor(
    public readonly code: VeLaunchTimingRefreshCode,
    message: string,
  ) {
    super(message);
    this.name = 'VeLaunchTimingRefreshError';
  }
}

export interface VeLaunchTimingSourceRow {
  id?: unknown;
  portfolio_id?: unknown;
  hypothesis_id?: unknown;
  status?: unknown;
  seasonality_input_hash?: unknown;
  seasonality_snapshot?: unknown;
  estimated_run_days?: unknown;
}

export interface VeLaunchTimingRefreshItem {
  item_id: string;
  seasonality_input_hash: string;
  priority_snapshot: ReturnType<typeof buildRuSeasonalityPrioritySnapshot>;
  latest_activation_at: string | null;
}

function positiveNumber(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Rebuild only date-derived fields. The persisted assessment remains immutable;
 * its hash is recalculated before any mutation payload can leave this process.
 */
export function buildRuLaunchTimingRefreshItems(
  rows: readonly VeLaunchTimingSourceRow[],
  now: Date = new Date(),
): VeLaunchTimingRefreshItem[] {
  if (!Number.isFinite(now.getTime())) {
    throw new VeLaunchTimingRefreshError(
      'VE_LAUNCH_TIMING_ITEM_INVALID',
      'Timing refresh requires a valid timestamp.',
    );
  }

  const result: VeLaunchTimingRefreshItem[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.portfolio_id !== 'ru' || !REFRESHABLE_STATUSES.has(String(row.status ?? ''))) {
      continue;
    }
    const itemId = typeof row.id === 'string' ? row.id : '';
    if (!UUID_RE.test(itemId) || seen.has(itemId)) {
      throw new VeLaunchTimingRefreshError(
        'VE_LAUNCH_TIMING_ITEM_INVALID',
        `Invalid or duplicate RU launch timing item: ${itemId || '<missing>'}`,
      );
    }
    seen.add(itemId);

    const hypothesisId = row.hypothesis_id === null
      ? null
      : typeof row.hypothesis_id === 'string'
        ? row.hypothesis_id
        : null;
    const seasonality = readStoredRuSeasonality(row.seasonality_snapshot);
    const expectedHash = seasonalityInputHash({ hypothesisId, seasonality });
    const storedHash = typeof row.seasonality_input_hash === 'string'
      ? row.seasonality_input_hash
      : '';
    if (!HASH_RE.test(storedHash) || storedHash !== expectedHash) {
      throw new VeLaunchTimingRefreshError(
        'VE_LAUNCH_TIMING_HASH_MISMATCH',
        `Immutable seasonality snapshot hash mismatch for ${itemId}.`,
      );
    }

    const estimatedRunDays = positiveNumber(row.estimated_run_days);
    if (estimatedRunDays === null) {
      throw new VeLaunchTimingRefreshError(
        'VE_LAUNCH_TIMING_RUN_DAYS_INVALID',
        `Estimated run duration is missing for ${itemId}.`,
      );
    }
    const prioritySnapshot = buildRuSeasonalityPrioritySnapshot(seasonality, now);
    result.push({
      item_id: itemId,
      seasonality_input_hash: storedHash,
      priority_snapshot: prioritySnapshot,
      latest_activation_at: latestSeasonalActivationAt({
        seasonal_deadline_date: prioritySnapshot.seasonal_deadline_date,
        estimated_run_days: estimatedRunDays,
      }),
    });
  }
  return result;
}

export interface VeLaunchTimingRefreshResult {
  refreshed: true;
  changed: boolean;
  plan_version: number | null;
  refreshed_items: number;
}

/** Service-only DB boundary for one atomic RU timing refresh. */
export async function refreshRuLaunchPortfolioTiming(input: {
  db: SupabaseClient;
  rows?: readonly VeLaunchTimingSourceRow[];
  now?: Date;
}): Promise<VeLaunchTimingRefreshResult> {
  const now = input.now ?? new Date();
  let rows = input.rows;
  if (!rows) {
    const allRows: VeLaunchTimingSourceRow[] = [];
    let offset = 0;
    let total: number | null = null;
    while (total === null || offset < total) {
      const { data, error, count } = await input.db
        .from('ve_launch_queue_items')
        .select(
          'id, portfolio_id, hypothesis_id, status, seasonality_input_hash, seasonality_snapshot, estimated_run_days',
          { count: 'exact' },
        )
        .eq('portfolio_id', 'ru')
        .in('status', ['prepared', 'queued'])
        .order('id', { ascending: true })
        .range(offset, offset + REFRESH_PAGE_SIZE - 1);
      if (error) {
        throw new VeLaunchTimingRefreshError('VE_LAUNCH_TIMING_READ_FAILED', error.message);
      }
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
        throw new VeLaunchTimingRefreshError(
          'VE_LAUNCH_TIMING_READ_FAILED',
          'RU timing refresh could not prove a complete queue snapshot.',
        );
      }
      if (total === null) total = count;
      else if (count !== total) {
        throw new VeLaunchTimingRefreshError(
          'VE_LAUNCH_TIMING_READ_FAILED',
          'RU timing queue changed during pagination.',
        );
      }
      if (total > MAX_REFRESH_ITEMS) {
        throw new VeLaunchTimingRefreshError(
          'VE_LAUNCH_TIMING_READ_FAILED',
          `RU timing refresh exceeds the safe ${MAX_REFRESH_ITEMS}-item limit.`,
        );
      }
      const page = (data ?? []) as VeLaunchTimingSourceRow[];
      if (page.length === 0 && offset < total) {
        throw new VeLaunchTimingRefreshError(
          'VE_LAUNCH_TIMING_READ_FAILED',
          'RU timing refresh pagination stopped before the queue was complete.',
        );
      }
      allRows.push(...page);
      offset += page.length;
    }
    rows = allRows;
  }

  const items = buildRuLaunchTimingRefreshItems(rows, now);
  if (items.length === 0) {
    return { refreshed: true, changed: false, plan_version: null, refreshed_items: 0 };
  }

  const { data, error } = await input.db.rpc('ve_refresh_launch_seasonality_timing', {
    p_portfolio_id: 'ru',
    p_items: items,
    p_now: now.toISOString(),
  });
  if (error) {
    throw new VeLaunchTimingRefreshError('VE_LAUNCH_TIMING_REFRESH_FAILED', error.message);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.refreshed !== true) {
    throw new VeLaunchTimingRefreshError(
      'VE_LAUNCH_TIMING_REFRESH_FAILED',
      'Timing refresh RPC returned an invalid acknowledgement.',
    );
  }

  return {
    refreshed: true,
    changed: data.changed === true,
    plan_version:
      typeof data.plan_version === 'number' && Number.isInteger(data.plan_version)
        ? data.plan_version
        : null,
    refreshed_items: items.length,
  };
}
