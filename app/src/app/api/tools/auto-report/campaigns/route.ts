import { NextRequest, NextResponse } from 'next/server';
import { getBearerToken } from '@/lib/supabaseRouteClient';
import { createAuthedSupabaseClient } from '@/lib/supabaseRouteClient';
import { fetchInstantlyCampaignsList } from '@/lib/tools/autoReportBuilder';
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
          const campaigns = await fetchInstantlyCampaignsList(INSTANTLY_API_KEY);
          const sorted = [...campaigns].sort((a, b) => {
            const at = a.timestamp_created ?? a.timestamp_updated ?? '';
            const bt = b.timestamp_created ?? b.timestamp_updated ?? '';
            // ISO timestamps can be compared lexicographically, but date parsing is safer for unexpected formats.
            const an = at ? Date.parse(at) : NaN;
            const bn = bt ? Date.parse(bt) : NaN;
            if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return bn - an;
            if (at && bt && at !== bt) return bt.localeCompare(at);
            return (b.name ?? '').localeCompare(a.name ?? '', 'ru');
          });
          return NextResponse.json({ campaigns: sorted });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Ошибка загрузки кампаний';
          return jsonError(message, 500);
        }
    },
  );
}
