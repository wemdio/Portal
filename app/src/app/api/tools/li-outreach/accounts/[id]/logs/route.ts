import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const RANGES: Record<string, number> = {
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

// Cap for JSON payload sanity (~1 MB at ~200 bytes/row). Larger windows than
// this are best fetched via the .txt export endpoint.
const MAX_ROWS = 5_000;
const PAGE_SIZE = 1_000;

interface LogRow {
  created_at: string;
  level: string;
  message: string;
  lead_name: string | null;
  step_index: number | null;
  campaign_id: string;
}

function slugify(name: string | null | undefined, fallback: string): string {
  const raw = (name ?? '').trim();
  if (!raw) return fallback;
  return raw.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-').slice(0, 60);
}

function formatTxtLine(row: LogRow, campaignName: string | null): string {
  const ts = row.created_at
    ? new Date(row.created_at).toISOString().replace('T', ' ').slice(0, 19)
    : '????-??-?? ??:??:??';
  const level = (row.level ?? 'info').toUpperCase().padEnd(7, ' ');
  const parts: string[] = [];
  if (campaignName) parts.push(`[${campaignName}]`);
  if (row.lead_name) parts.push(`<${row.lead_name}>`);
  if (row.step_index != null) parts.push(`step:${row.step_index}`);
  const prefix = parts.join(' ');
  return `${ts}  ${level}  ${prefix ? prefix + '  ' : ''}${row.message ?? ''}\n`;
}

/**
 * Per-account log feed. Accounts in li-outreach are user-level (not
 * campaign-level), so this endpoint surfaces logs across ALL campaigns
 * where this account was used.
 *
 * Filter is a true FK lookup against the account_id column added in
 * migration 20260521_0003 — no fragile substring matching.
 *
 * Query params:
 *   range?  6h | 24h | 7d (default 24h)
 *   format? json (default) | txt
 *
 * JSON shape: { items, range, since, truncated }
 * TXT shape: plain text attachment with the same metadata header as the
 * campaign-level export.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.li-outreach.accounts.by-id.logs' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      if (!supabaseAdmin) return jsonError('Admin client not configured', 500);

      const { id: accountId } = await ctx.params;
      const url = new URL(req.url);
      const rangeKey = (url.searchParams.get('range') ?? '24h').toLowerCase();
      const format = (url.searchParams.get('format') ?? 'json').toLowerCase();

      const rangeMs = RANGES[rangeKey];
      if (!rangeMs) return jsonError(`range должен быть одним из: ${Object.keys(RANGES).join(', ')}`, 400);

      // Verify ownership of the account and load display data for the header.
      const { data: account, error: accErr } = await supabaseAdmin
        .from('li_accounts')
        .select('id, name, unipile_account_id, user_id')
        .eq('id', accountId)
        .maybeSingle();
      if (accErr) return jsonError(accErr.message, 500);
      if (!account || account.user_id !== auth.user.id) {
        return jsonError('LinkedIn-аккаунт не найден или не принадлежит пользователю', 404);
      }
      const accountLabel =
        (account.name as string | null)?.trim() ||
        (account.unipile_account_id as string) ||
        accountId;

      // Owned campaigns for display names + the account_id constraint already
      // pins us to user's own campaigns (li_accounts.user_id), but keep the
      // ownership safety net anyway.
      const { data: ownedCampaigns, error: ocErr } = await supabaseAdmin
        .from('li_campaigns')
        .select('id, name')
        .eq('user_id', auth.user.id);
      if (ocErr) return jsonError(ocErr.message, 500);
      const ownedIds = (ownedCampaigns ?? []).map((c) => c.id as string);
      const campaignNameById = new Map<string, string>(
        (ownedCampaigns ?? []).map((c) => [c.id as string, c.name as string]),
      );

      const sinceIso = new Date(Date.now() - rangeMs).toISOString();
      const items: LogRow[] = [];
      let from = 0;

      while (items.length < MAX_ROWS && ownedIds.length > 0) {
        const to = from + PAGE_SIZE - 1;
        const { data, error } = await supabaseAdmin
          .from('li_campaign_logs')
          .select('created_at, level, message, lead_name, step_index, campaign_id')
          .eq('account_id', accountId)
          .in('campaign_id', ownedIds)
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: true })
          .range(from, to);

        if (error) return jsonError(error.message, 500);
        if (!data || data.length === 0) break;
        for (const row of data as LogRow[]) {
          items.push(row);
          if (items.length >= MAX_ROWS) break;
        }
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }

      const truncated = items.length >= MAX_ROWS;

      if (format === 'txt') {
        const header =
          `# LinkedIn Outreach account logs\n` +
          `# account:  ${accountLabel} (${account.id})\n` +
          `# range:    ${rangeKey}  (since ${sinceIso})\n` +
          `# exported: ${new Date().toISOString()}\n` +
          `# rows:     ${items.length}${truncated ? ` (TRUNCATED at MAX_ROWS=${MAX_ROWS})` : ''}\n` +
          `# ─────────────────────────────────────────────────────────────────────\n`;

        const body =
          header +
          items.map((row) => formatTxtLine(row, campaignNameById.get(row.campaign_id) ?? null)).join('');

        const today = new Date().toISOString().slice(0, 10);
        const filename = `li-outreach-account-${slugify(accountLabel, accountId)}-${rangeKey}-${today}.txt`;

        return new NextResponse(body, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition':
              `attachment; filename="li-outreach-account-${rangeKey}-${today}.txt"; ` +
              `filename*=UTF-8''${encodeURIComponent(filename)}`,
            'Cache-Control': 'no-store',
          },
        });
      }

      // JSON: enrich each row with the campaign display name so the modal can
      // show context without a second round-trip.
      const enriched = items.map((row) => ({
        ...row,
        campaign: { name: campaignNameById.get(row.campaign_id) ?? 'Unknown' },
      }));

      return NextResponse.json({
        range: rangeKey,
        since: sinceIso,
        truncated,
        account: { id: account.id, name: accountLabel },
        items: enriched,
      });
    },
  );
}
