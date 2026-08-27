import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

// Allowed ranges (kept short — UI only exposes these three buttons).
// We translate to a Postgres interval string and the filename suffix.
const RANGES: Record<string, { interval: string; suffix: string }> = {
  '6h': { interval: '6 hours', suffix: '6h' },
  '24h': { interval: '24 hours', suffix: '24h' },
  '7d': { interval: '7 days', suffix: '7d' },
  // Месяц — горизонт, на котором видно медленное: аккаунт, замолчавший две
  // недели назад, в семидневном окне выглядит как всегда молчавший.
  '30d': { interval: '30 days', suffix: '30d' },
};

// Hard ceiling so a wildly busy campaign can't pull tens of millions of rows.
// 50k lines × ~200 bytes ≈ 10 MB plain text — generous for human inspection.
const MAX_ROWS = 50_000;
const PAGE_SIZE = 1_000; // Supabase default upper limit per range()

function slugify(name: string | null | undefined, fallback: string): string {
  const raw = (name ?? '').trim();
  if (!raw) return fallback;
  // Keep cyrillic readable, drop unsafe filesystem characters.
  return raw
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60);
}

function formatLine(row: { created_at: string; level: string; message: string }): string {
  // 2026-05-21 15:52:38  ERROR    Аккаунт 998950866849: ошибка подключения — ...
  const ts = row.created_at
    ? new Date(row.created_at).toISOString().replace('T', ' ').slice(0, 19)
    : '????-??-?? ??:??:??';
  const level = (row.level ?? 'info').toUpperCase().padEnd(7, ' ');
  return `${ts}  ${level}  ${row.message ?? ''}\n`;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.campaigns.by-id.logs.export.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const { id: campaignId } = await ctx.params;

      const rangeKey = (new URL(req.url).searchParams.get('range') ?? '24h').toLowerCase();
      const range = RANGES[rangeKey];
      if (!range) {
        return jsonError(`range должен быть одним из: ${Object.keys(RANGES).join(', ')}`, 400);
      }

      // Look up the campaign (and assert RLS visibility / existence in one go).
      const { data: campaign, error: cErr } = await auth.supabase
        .from('tg_outreach_campaigns')
        .select('id, name')
        .eq('id', campaignId)
        .maybeSingle();

      if (cErr) return jsonError(cErr.message, 500);
      if (!campaign) return jsonError('Кампания не найдена', 404);

      // Compute the lower time bound here (in Node) so each page query is
      // anchored to the same instant — otherwise paging across "now - 6h"
      // every request risks rows shifting in/out as time advances.
      const sinceMs = Date.now() - intervalToMs(range.interval);
      const sinceIso = new Date(sinceMs).toISOString();

      // Stream in chronological order so the downloaded file reads top-to-
      // bottom oldest-to-newest, which matches how operators read logs.
      let from = 0;
      let totalRows = 0;
      const chunks: string[] = [];

      while (totalRows < MAX_ROWS) {
        const to = from + PAGE_SIZE - 1;
        const { data, error } = await auth.supabase
          .from('tg_outreach_logs')
          .select('created_at, level, message')
          .eq('campaign_id', campaignId)
          .gte('created_at', sinceIso)
          .order('created_at', { ascending: true })
          .range(from, to);

        if (error) return jsonError(error.message, 500);
        if (!data || data.length === 0) break;

        for (const row of data) {
          chunks.push(formatLine(row));
          totalRows++;
          if (totalRows >= MAX_ROWS) break;
        }

        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }

      const truncated = totalRows >= MAX_ROWS;
      const header =
        `# TG Outreach campaign logs\n` +
        `# campaign: ${campaign.name ?? campaignId} (${campaignId})\n` +
        `# range:    ${range.suffix}  (since ${sinceIso})\n` +
        `# exported: ${new Date().toISOString()}\n` +
        `# rows:     ${totalRows}${truncated ? ` (TRUNCATED at MAX_ROWS=${MAX_ROWS})` : ''}\n` +
        `# ─────────────────────────────────────────────────────────────────────\n`;

      const body = header + chunks.join('');

      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const filename = `tg-outreach-${slugify(campaign.name, campaignId)}-${range.suffix}-${today}.txt`;

      return new NextResponse(body, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          // Both ASCII fallback and RFC 5987 form so cyrillic campaign names
          // survive the round-trip through browser download.
          'Content-Disposition':
            `attachment; filename="tg-outreach-logs-${range.suffix}-${today}.txt"; ` +
            `filename*=UTF-8''${encodeURIComponent(filename)}`,
          'Cache-Control': 'no-store',
        },
      });
    },
  );
}

/** Tiny helper: 'N hours' / 'N days' → ms. Only used for the few RANGES values. */
function intervalToMs(interval: string): number {
  const [nStr, unit] = interval.split(/\s+/);
  const n = Number(nStr);
  if (!Number.isFinite(n)) return 24 * 60 * 60 * 1000;
  if (unit.startsWith('hour')) return n * 60 * 60 * 1000;
  if (unit.startsWith('day')) return n * 24 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}
