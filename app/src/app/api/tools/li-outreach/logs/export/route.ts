import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError, checkIsAdmin } from '@/lib/liOutreach/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

// Match the three buckets used by tg-outreach for consistency.
const RANGES: Record<string, { ms: number; suffix: string }> = {
  '6h': { ms: 6 * 60 * 60 * 1000, suffix: '6h' },
  '24h': { ms: 24 * 60 * 60 * 1000, suffix: '24h' },
  '7d': { ms: 7 * 24 * 60 * 60 * 1000, suffix: '7d' },
};

// Hard cap so a chatty week of logs can't OOM the export.
// 50k rows × ~200 bytes ≈ 10 MB plain text — generous for inspection.
const MAX_ROWS = 50_000;
const PAGE_SIZE = 1_000;

function slugify(name: string | null | undefined, fallback: string): string {
  const raw = (name ?? '').trim();
  if (!raw) return fallback;
  return raw.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-').slice(0, 60);
}

interface LogRow {
  created_at: string;
  level: string;
  message: string;
  lead_name: string | null;
  step_index: number | null;
  campaign_id: string;
  account_id: string | null;
}

function formatLine(row: LogRow, campaignName: string | null, accountName: string | null): string {
  const ts = row.created_at
    ? new Date(row.created_at).toISOString().replace('T', ' ').slice(0, 19)
    : '????-??-?? ??:??:??';
  const level = (row.level ?? 'info').toUpperCase().padEnd(7, ' ');
  const parts: string[] = [];
  if (campaignName) parts.push(`[${campaignName}]`);
  if (accountName) parts.push(`{${accountName}}`);
  if (row.lead_name) parts.push(`<${row.lead_name}>`);
  if (row.step_index != null) parts.push(`step:${row.step_index}`);
  const prefix = parts.join(' ');
  return `${ts}  ${level}  ${prefix ? prefix + '  ' : ''}${row.message ?? ''}\n`;
}

/**
 * Plain-text export of li-outreach campaign logs over a fixed time window.
 *
 * Respects the same filters as the JSON /logs endpoint (campaign_id, level,
 * plus the new optional account_id) so the file matches whatever the user
 * currently sees in the Logs tab. RLS is enforced by joining against
 * li_campaigns owned by the requesting user.
 *
 * Query params:
 *   range?       6h | 24h | 7d (default 24h)
 *   campaign_id? uuid (optional)
 *   account_id?  uuid (optional)
 *   level?       info | warning | error (optional)
 */
export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.li-outreach.logs.export' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      if (!supabaseAdmin) return jsonError('Admin client not configured', 500);

      const url = new URL(req.url);
      const rangeKey = (url.searchParams.get('range') ?? '24h').toLowerCase();
      const range = RANGES[rangeKey];
      if (!range) return jsonError(`range должен быть одним из: ${Object.keys(RANGES).join(', ')}`, 400);

      const campaignIdFilter = url.searchParams.get('campaign_id');
      const accountIdFilter = url.searchParams.get('account_id');
      const level = url.searchParams.get('level');

      // Admins can export logs across all users' campaigns; regular users are
      // scoped to their own. Mirrors /campaigns/[id]/logs admin behaviour.
      const admin = await checkIsAdmin(auth.user.id);

      // Pull owned campaigns for RLS-equivalent guard + display names.
      let ocQ = supabaseAdmin.from('li_campaigns').select('id, name');
      if (!admin) ocQ = ocQ.eq('user_id', auth.user.id);
      const { data: ownedCampaigns, error: ocErr } = await ocQ;
      if (ocErr) return jsonError(ocErr.message, 500);
      const ownedIds = (ownedCampaigns ?? []).map((c) => c.id);
      if (campaignIdFilter && !ownedIds.includes(campaignIdFilter)) {
        return jsonError('Кампания не найдена или не принадлежит пользователю', 404);
      }
      if (ownedIds.length === 0) {
        return new NextResponse('# Нет ни одной кампании у пользователя — экспортировать нечего.\n', {
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }

      const campaignNameById = new Map<string, string>(
        (ownedCampaigns ?? []).map((c) => [c.id, c.name as string]),
      );

      // Pull owned accounts (in batch) so we can label rows by account.name.
      // Accounts are per-user — for admins we need the full set so labels work
      // when exporting logs from another user's campaign.
      let accQ = supabaseAdmin.from('li_accounts').select('id, name, unipile_account_id');
      if (!admin) accQ = accQ.eq('user_id', auth.user.id);
      const { data: accounts, error: accErr } = await accQ;
      if (accErr) return jsonError(accErr.message, 500);
      const accountLabelById = new Map<string, string>(
        (accounts ?? []).map((a) => [
          a.id as string,
          ((a.name as string | null)?.trim() || (a.unipile_account_id as string) || (a.id as string)),
        ]),
      );

      const sinceMs = Date.now() - range.ms;
      const sinceIso = new Date(sinceMs).toISOString();

      let from = 0;
      let totalRows = 0;
      const chunks: string[] = [];

      while (totalRows < MAX_ROWS) {
        const to = from + PAGE_SIZE - 1;
        let q = supabaseAdmin
          .from('li_campaign_logs')
          .select('created_at, level, message, lead_name, step_index, campaign_id, account_id')
          .in('campaign_id', campaignIdFilter ? [campaignIdFilter] : ownedIds)
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: true })
          .range(from, to);

        if (accountIdFilter) q = q.eq('account_id', accountIdFilter);
        if (level && ['info', 'warning', 'error'].includes(level)) q = q.eq('level', level);

        const { data, error } = await q;
        if (error) return jsonError(error.message, 500);
        if (!data || data.length === 0) break;

        for (const row of data as LogRow[]) {
          chunks.push(
            formatLine(
              row,
              campaignNameById.get(row.campaign_id) ?? null,
              row.account_id ? (accountLabelById.get(row.account_id) ?? null) : null,
            ),
          );
          totalRows++;
          if (totalRows >= MAX_ROWS) break;
        }

        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }

      const truncated = totalRows >= MAX_ROWS;

      // Build a descriptive filename. If campaign_id was given, scope it; if
      // account_id was given, mention that too; otherwise call it the full
      // user view.
      const scopeParts: string[] = [];
      if (campaignIdFilter) {
        scopeParts.push(slugify(campaignNameById.get(campaignIdFilter) ?? campaignIdFilter, 'campaign'));
      }
      if (accountIdFilter) {
        scopeParts.push(`acc-${slugify(accountLabelById.get(accountIdFilter) ?? accountIdFilter, 'account')}`);
      }
      const scope = scopeParts.length ? scopeParts.join('-') : 'all';
      const today = new Date().toISOString().slice(0, 10);
      const fullFilename = `li-outreach-${scope}-${range.suffix}-${today}.txt`;

      const header =
        `# LinkedIn Outreach logs\n` +
        (campaignIdFilter
          ? `# campaign: ${campaignNameById.get(campaignIdFilter)} (${campaignIdFilter})\n`
          : `# campaigns: all (${ownedIds.length})\n`) +
        (accountIdFilter
          ? `# account:  ${accountLabelById.get(accountIdFilter) ?? accountIdFilter}\n`
          : '') +
        (level ? `# level:    ${level}\n` : '') +
        `# range:    ${range.suffix}  (since ${sinceIso})\n` +
        `# exported: ${new Date().toISOString()}\n` +
        `# rows:     ${totalRows}${truncated ? ` (TRUNCATED at MAX_ROWS=${MAX_ROWS})` : ''}\n` +
        `# ─────────────────────────────────────────────────────────────────────\n`;

      return new NextResponse(header + chunks.join(''), {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition':
            `attachment; filename="li-outreach-logs-${range.suffix}-${today}.txt"; ` +
            `filename*=UTF-8''${encodeURIComponent(fullFilename)}`,
          'Cache-Control': 'no-store',
        },
      });
    },
  );
}
