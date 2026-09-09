import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { computeListStats } from '@/lib/tgOutreach/proxyListStats';

export const dynamic = 'force-dynamic';

/**
 * Сводка по «Неопределённым» — прокси кампании без proxy_list_id.
 *
 * Отдельный роут, потому что Next.js не пропускает null/[id] в динамическом
 * сегменте, а условный GET в `[id]/stats` с id = '__undefined__' читался бы
 * хуже. Здесь id = null по смыслу, а не по URL.
 *
 * Поведение совпадает с `proxy-lists/[id]/stats`, но без проверки наличия
 * списка — у «Неопределённых» нет строки в БД.
 */
export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.proxies.undefined.stats.get' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const campaignId = new URL(req.url).searchParams.get('campaign_id');
      if (!campaignId) return jsonError('campaign_id обязателен', 400);

      const stats = await computeListStats({
        campaignId,
        listId: null,
        supabase: auth.supabase,
      });
      return NextResponse.json(stats);
    },
  );
}
