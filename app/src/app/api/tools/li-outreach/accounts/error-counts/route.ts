import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const RANGES: Record<string, number> = {
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

// Same hard cap as the other log endpoints. 50k error/warning rows is way more
// than even a hyperactive week of campaigns.
const MAX_ROWS_SCAN = 50_000;
const PAGE_SIZE = 1_000;

/**
 * Returns the number of error/warning rows attributed to each LinkedIn account
 * across all campaigns, within a time window. Used by the
 * accounts list UI to render a "⚠ N errors" chip next to each card.
 *
 * Output: { range, since, truncated, counts: { [account_id]: { error, warning } } }
 *
 * Implementation note: relies on the account_id column added by migration
 * 20260521_0003 — older rows with NULL account_id are simply not counted.
 *
 * Query params:
 *   range?      6h | 24h | 7d (default 24h)
 */
export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.li-outreach.accounts.error-counts' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      if (!supabaseAdmin) return jsonError('Admin client not configured', 500);

      const url = new URL(req.url);
      const rangeKey = (url.searchParams.get('range') ?? '24h').toLowerCase();
      const rangeMs = RANGES[rangeKey];
      if (!rangeMs) return jsonError(`range должен быть одним из: ${Object.keys(RANGES).join(', ')}`, 400);

      // Counted across every campaign, not only the viewer's: accounts are
      // shared by the team (08.10.2026), so the chip must match the account log.
      const sinceIso = new Date(Date.now() - rangeMs).toISOString();
      const counts: Record<string, { error: number; warning: number }> = {};

      let from = 0;
      let scanned = 0;
      while (scanned < MAX_ROWS_SCAN) {
        const to = from + PAGE_SIZE - 1;
        const { data, error } = await supabaseAdmin
          .from('li_campaign_logs')
          .select('account_id, level')
          .not('account_id', 'is', null)
          .in('level', ['error', 'warning'])
          .gte('created_at', sinceIso)
          .range(from, to);

        if (error) return jsonError(error.message, 500);
        if (!data || data.length === 0) break;

        for (const row of data as Array<{ account_id: string; level: string }>) {
          const k = row.account_id;
          if (!counts[k]) counts[k] = { error: 0, warning: 0 };
          if (row.level === 'error') counts[k].error++;
          else if (row.level === 'warning') counts[k].warning++;
          scanned++;
          if (scanned >= MAX_ROWS_SCAN) break;
        }

        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }

      return NextResponse.json({
        range: rangeKey,
        since: sinceIso,
        truncated: scanned >= MAX_ROWS_SCAN,
        counts,
      });
    },
  );
}
