import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken } from '@/lib/supabaseRouteClient';
import { createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { fetchInstantlyCampaignsList } from '@/lib/tools/autoReportBuilder';
import {
  readInstantlyCampaignCatalog,
  syncInstantlyCampaignCatalog,
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

        const token = getBearerToken(_req.headers.get('authorization'));
        if (!token) return jsonError('Необходима авторизация', 401);

        const supabase = createAuthedSupabaseClient(token);
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return jsonError('Необходима авторизация', 401);

        if (!INSTANTLY_API_KEY) {
          return jsonError('Сервис не настроен (INSTANTLY_API_KEY или INSTANTLY_PORTAL_API_KEY)', 503);
        }

        try {
          if (supabaseAdmin) {
            const { campaigns, lastSyncedAt } = await readInstantlyCampaignCatalog();
            const empty = campaigns.length === 0;
            const stale = isCatalogStale(lastSyncedAt);

            if (empty || stale) {
              void syncInstantlyCampaignCatalog(INSTANTLY_API_KEY).catch((err) => {
                console.error('[instantly-catalog] background sync failed', err);
              });
            }

            return NextResponse.json({
              campaigns,
              meta: {
                source: 'database' as const,
                lastSyncedAt,
                stale,
                backgroundSync: empty || stale,
              },
            });
          }

          const list = await fetchInstantlyCampaignsList(INSTANTLY_API_KEY);
          const sorted = [...list].sort((a, b) => {
            const at = a.timestamp_created ?? a.timestamp_updated ?? '';
            const bt = b.timestamp_created ?? b.timestamp_updated ?? '';
            const an = at ? Date.parse(at) : NaN;
            const bn = bt ? Date.parse(bt) : NaN;
            if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return bn - an;
            if (at && bt && at !== bt) return bt.localeCompare(at);
            return (b.name ?? '').localeCompare(a.name ?? '', 'ru');
          });
          return NextResponse.json({
            campaigns: sorted,
            meta: {
              source: 'instantly_fallback' as const,
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
