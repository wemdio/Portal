import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * Переместить пачку прокси в список.
 *
 * body: { ids: string[], list_id: string | null, campaign_id: string }
 *
 * Один UPDATE на всю пачку, не цикл по строкам: даже на 50 прокси это один
 * сетевой обмен вместо пятидесяти, и латентность не складывается. RLS
 * автоматически отрежет чужие строки — лишние id просто не обновятся.
 *
 * campaign_id обязателен, чтобы RLS-проверка шла по нужной кампании
 * (политика смотрит на владельца кампании, а не напрямую на прокси).
 */
export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.proxies.bulk-move.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      let body: Record<string, unknown>;
      try {
        body = await req.json();
      } catch {
        return jsonError('Неверный JSON', 400);
      }

      const campaignId = (body.campaign_id as string)?.trim();
      if (!campaignId) return jsonError('campaign_id обязателен', 400);

      const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).map(String) : [];
      if (!ids.length) return jsonError('ids обязателен и не пуст', 400);

      if (!('list_id' in body)) return jsonError('list_id обязателен', 400);
      const raw = body.list_id;
      if (raw !== null && typeof raw !== 'string') {
        return jsonError('list_id должен быть uuid или null', 400);
      }

      const { data, error } = await auth.supabase
        .from('tg_outreach_proxies')
        .update({ proxy_list_id: raw })
        .eq('campaign_id', campaignId)
        .in('id', ids)
        .select('id');

      if (error) return jsonError(error.message, 500);

      // Сколько реально обновилось — могло быть меньше ids, если часть уже
      // удалили или если RLS их отрезала. Возвращаем массив — клиент знает
      // истину без перезагрузки.
      return NextResponse.json({ updated: data ?? [] });
    },
  );
}
