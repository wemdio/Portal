import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

// Match the time buckets used elsewhere in the campaign UI for consistency.
const RANGES: Record<string, number> = {
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

// Hard ceiling on rows we scan. A campaign with 25 accounts × ~12 errors/account/day
// is ~300 rows for 24h, ~2100 for 7d. 50k is comfortably above any realistic chatty
// campaign and still finishes in well under a second.
const MAX_ROWS_SCAN = 50_000;
const PAGE_SIZE = 1_000;

// How many recent unmatched messages to surface to the UI. The side panel only
// needs a short list — bumping this past ~30 just bloats the response.
const OTHER_RECENT_LIMIT = 30;

type OtherLogRow = {
  id: number;
  level: 'error' | 'warning';
  message: string;
  created_at: string;
};

/**
 * Returns the number of error/warning log rows that mention each account's
 * session_name within a time window. Used by the accounts list to render
 * a small "errors" chip next to each row without N+1 queries.
 *
 * Also returns "other" errors — rows that didn't match any account, which the
 * logs-tab side panel uses to surface campaign-wide failures (DB errors,
 * GPT timeouts, supervisor crashes…) that aren't attributable to a single
 * session.
 *
 * Matching strategy: tg_outreach_logs has no account_id column — accounts
 * appear in the message text as written by gramClient.buildClients and
 * campaignLoop. We do a single fetch of recent error/warning rows and
 * group them client-side by the longest session_name found inside each
 * message. Cheaper than 25 ILIKE queries and avoids pg trigram indexes.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.accounts.error-counts.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const { id: campaignId } = await ctx.params;
      const rangeKey = (new URL(req.url).searchParams.get('range') ?? '24h').toLowerCase();
      const rangeMs = RANGES[rangeKey];
      if (!rangeMs) {
        return jsonError(`range должен быть одним из: ${Object.keys(RANGES).join(', ')}`, 400);
      }

      // Get account session_names + ids so we can return both for the UI.
      const { data: accounts, error: aErr } = await auth.supabase
        .from('tg_outreach_accounts')
        .select('id, session_name')
        .eq('campaign_id', campaignId);

      if (aErr) return jsonError(aErr.message, 500);

      const sinceIso = new Date(Date.now() - rangeMs).toISOString();
      const untilIso = new Date().toISOString();

      const counts: Record<string, { error: number; warning: number; account_id: string }> = {};
      for (const a of accounts ?? []) {
        counts[a.session_name] = { error: 0, warning: 0, account_id: a.id };
      }

      // Sort by length descending so when one session_name is a substring of
      // another (rare with phone numbers, but possible with labels like
      // 'main' vs 'main2'), the longer name wins.
      const accountsByLength = [...(accounts ?? [])].sort(
        (a, b) => b.session_name.length - a.session_name.length,
      );

      const other: { error: number; warning: number; recent: OtherLogRow[] } = {
        error: 0,
        warning: 0,
        recent: [],
      };

      // Fast path: campaign has no accounts. We still want to count "other"
      // errors (everything is "other" in that case) so the panel isn't empty.
      let from = 0;
      let scanned = 0;

      while (scanned < MAX_ROWS_SCAN) {
        const to = from + PAGE_SIZE - 1;
        const { data, error } = await auth.supabase
          .from('tg_outreach_logs')
          .select('id, level, message, created_at')
          .eq('campaign_id', campaignId)
          .gte('created_at', sinceIso)
          .in('level', ['error', 'warning'])
          .order('created_at', { ascending: false })
          .range(from, to);

        if (error) return jsonError(error.message, 500);
        if (!data || data.length === 0) break;

        for (const row of data) {
          const msg = row.message ?? '';
          let matched = false;
          // First match wins — accountsByLength is longest-first.
          for (const a of accountsByLength) {
            if (msg.includes(a.session_name)) {
              const bucket = row.level === 'error' ? 'error' : 'warning';
              counts[a.session_name][bucket]++;
              matched = true;
              break;
            }
          }
          if (!matched) {
            const bucket = row.level === 'error' ? 'error' : 'warning';
            other[bucket]++;
            if (other.recent.length < OTHER_RECENT_LIMIT) {
              other.recent.push({
                id: row.id,
                level: row.level as 'error' | 'warning',
                message: msg,
                created_at: row.created_at,
              });
            }
          }
          scanned++;
          if (scanned >= MAX_ROWS_SCAN) break;
        }

        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }

      return NextResponse.json({
        range: rangeKey,
        since: sinceIso,
        until: untilIso,
        truncated: scanned >= MAX_ROWS_SCAN,
        counts,
        other,
      });
    },
  );
}
