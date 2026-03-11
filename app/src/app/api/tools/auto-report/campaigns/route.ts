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
          return NextResponse.json({ campaigns });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Ошибка загрузки кампаний';
          return jsonError(message, 500);
        }
    },
  );
}
