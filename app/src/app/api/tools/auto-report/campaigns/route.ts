import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken } from '@/lib/supabaseRouteClient';
import { createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { fetchInstantlyCampaignsList } from '@/lib/tools/autoReportBuilder';
import {
  readInstantlyCampaignCatalog,
  isCatalogStale,
} from '@/lib/tools/instantlyCampaignCatalog';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const INSTANTLY_API_KEY =
  (process.env.INSTANTLY_API_KEY ?? process.env.INSTANTLY_PORTAL_API_KEY ?? '').trim();

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(_req: NextRequest) {
  return withToolTrace(
    { request: _req, operation: 'tools.auto-report.campaigns.get' },
    async () => {
        const sourceParam = _req.nextUrl.searchParams.get('source');
        const forceInstantly = sourceParam === 'instantly';

        const token = getBearerToken(_req.headers.get('authorization'));
        if (!token) return jsonError('Необходима авторизация', 401);

        const supabase = createAuthedSupabaseClient(token);
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return jsonError('Необходима авторизация', 401);

        // Кампании «Рассылки»: из её же таблицы, в форме списка Instantly, чтобы
        // экран выбора не различал источники. Статусы — коды Instantly.
        if (_req.nextUrl.searchParams.get('provider') === 'sender') {
          if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);
          const { data, error } = await supabaseAdmin
            .from('sender_campaigns')
            .select('id, name, status, created_at, updated_at')
            .order('created_at', { ascending: false });
          if (error) return jsonError(error.message, 500);
          const statusCode: Record<string, number> = { draft: 0, running: 1, paused: 2, done: 3 };
          return NextResponse.json({
            campaigns: (data ?? []).map((row) => ({
              id: String(row.id),
              name: String(row.name ?? ''),
              status: statusCode[String(row.status)] ?? 0,
              timestamp_created: row.created_at ?? undefined,
              timestamp_updated: row.updated_at ?? undefined,
            })),
            meta: { source: 'sender' as const, lastSyncedAt: null, stale: false, backgroundSync: false },
          });
        }

        if (!INSTANTLY_API_KEY) {
          return jsonError('Сервис не настроен (INSTANTLY_API_KEY или INSTANTLY_PORTAL_API_KEY)', 503);
        }

        try {
          if (supabaseAdmin && !forceInstantly) {
            const { campaigns, lastSyncedAt } = await readInstantlyCampaignCatalog();
            const stale = isCatalogStale(lastSyncedAt);

            return NextResponse.json({
              campaigns,
              meta: {
                source: 'database' as const,
                lastSyncedAt,
                stale,
                backgroundSync: false,
              },
            });
          }

          const list = await fetchInstantlyCampaignsList(INSTANTLY_API_KEY, {
            accountId: 'main',
            consumer: 'auto_report_campaigns',
          });
          const sorted = [...list].sort((a, b) => {
            const at = a.timestamp_created ?? a.timestamp_updated ?? '';
            const bt = b.timestamp_created ?? b.timestamp_updated ?? '';
            const an = at ? Date.parse(at) : NaN;
            const bn = bt ? Date.parse(bt) : NaN;
            if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return bn - an;
            if (at && bt && at !== bt) return bt.localeCompare(at);
            return (b.name ?? '').localeCompare(a.name ?? '', 'ru');
          });
          const source = forceInstantly ? 'instantly_direct' : 'instantly_fallback';
          return NextResponse.json({
            campaigns: sorted,
            meta: {
              source,
              lastSyncedAt: null,
              stale: false,
              backgroundSync: false,
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Ошибка загрузки кампаний';
          return jsonError(message, 500);
        }
    },
  );
}
