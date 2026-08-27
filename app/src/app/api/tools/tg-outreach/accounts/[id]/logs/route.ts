import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const RANGES: Record<string, number> = {
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/**
 * Потолки разные, потому что читатели разные.
 *
 * JSON уходит в модалку и рисуется в DOM — там пять тысяч строк уже предел
 * читаемости, а больше просто вешает вкладку. Файл читают в редакторе, и за
 * месяц у болтливого аккаунта строк набирается заметно больше пяти тысяч:
 * обрезать выгрузку по тому же порогу значило бы отдать оператору файл, в
 * котором молча нет половины истории.
 */
const MAX_ROWS_JSON = 5_000;
const MAX_ROWS_TXT = 50_000;
const PAGE_SIZE = 1_000;

function slugify(name: string | null | undefined, fallback: string): string {
  const raw = (name ?? '').trim();
  if (!raw) return fallback;
  return raw.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-').slice(0, 60);
}

function formatTxtLine(row: { created_at: string; level: string; message: string }): string {
  const ts = row.created_at
    ? new Date(row.created_at).toISOString().replace('T', ' ').slice(0, 19)
    : '????-??-?? ??:??:??';
  const level = (row.level ?? 'info').toUpperCase().padEnd(7, ' ');
  return `${ts}  ${level}  ${row.message ?? ''}\n`;
}

/**
 * Per-account log feed. Accounts have no FK in tg_outreach_logs, so we match
 * by substring of `account.session_name` against the log message — that's how
 * the worker writes account-tied lines (gramClient and campaignLoop both
 * prefix with `${session_name}:` or `Аккаунт ${session_name}: ...`).
 *
 * Query: ?range=6h|24h|7d|30d&format=json|txt (default json, 24h)
 *  - format=json → { items, range, since, truncated }
 *  - format=txt  → text/plain attachment (same shape as the campaign-level
 *                  /logs/export endpoint, for parity)
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.accounts.by-id.logs.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const { id: accountId } = await ctx.params;

      const url = new URL(req.url);
      const rangeKey = (url.searchParams.get('range') ?? '24h').toLowerCase();
      const format = (url.searchParams.get('format') ?? 'json').toLowerCase();

      const rangeMs = RANGES[rangeKey];
      if (!rangeMs) {
        return jsonError(`range должен быть одним из: ${Object.keys(RANGES).join(', ')}`, 400);
      }

      // Load the account so we can (a) know its session_name and (b) let RLS
      // enforce that the caller owns the parent campaign.
      const { data: account, error: aErr } = await auth.supabase
        .from('tg_outreach_accounts')
        .select('id, session_name, campaign_id')
        .eq('id', accountId)
        .maybeSingle();

      if (aErr) return jsonError(aErr.message, 500);
      if (!account) return jsonError('Аккаунт не найден', 404);

      const maxRows = format === 'txt' ? MAX_ROWS_TXT : MAX_ROWS_JSON;
      const sinceMs = Date.now() - rangeMs;
      const sinceIso = new Date(sinceMs).toISOString();

      // Use case-insensitive substring match. session_name is usually a phone
      // number (digits) so case doesn't matter, but ilike keeps us safe for
      // labels like 'MainAccount'.
      const pattern = `%${account.session_name}%`;

      let from = 0;
      const items: Array<{ created_at: string; level: string; message: string }> = [];

      while (items.length < maxRows) {
        const to = from + PAGE_SIZE - 1;
        const { data, error } = await auth.supabase
          .from('tg_outreach_logs')
          .select('created_at, level, message')
          .eq('campaign_id', account.campaign_id)
          .gte('created_at', sinceIso)
          .ilike('message', pattern)
          .order('created_at', { ascending: true })
          .range(from, to);

        if (error) return jsonError(error.message, 500);
        if (!data || data.length === 0) break;

        for (const row of data) {
          items.push(row);
          if (items.length >= maxRows) break;
        }

        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }

      const truncated = items.length >= maxRows;

      if (format === 'txt') {
        const header =
          `# TG Outreach account logs\n` +
          `# account:  ${account.session_name} (${account.id})\n` +
          `# range:    ${rangeKey}  (since ${sinceIso})\n` +
          `# exported: ${new Date().toISOString()}\n` +
          `# rows:     ${items.length}${truncated ? ` (TRUNCATED at MAX_ROWS=${maxRows})` : ''}\n` +
          `# ─────────────────────────────────────────────────────────────────────\n`;

        const body = header + items.map(formatTxtLine).join('');
        const today = new Date().toISOString().slice(0, 10);
        const filename = `tg-outreach-account-${slugify(account.session_name, account.id)}-${rangeKey}-${today}.txt`;

        return new NextResponse(body, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition':
              `attachment; filename="tg-outreach-account-${rangeKey}-${today}.txt"; ` +
              `filename*=UTF-8''${encodeURIComponent(filename)}`,
            'Cache-Control': 'no-store',
          },
        });
      }

      return NextResponse.json({
        range: rangeKey,
        since: sinceIso,
        truncated,
        items,
      });
    },
  );
}
