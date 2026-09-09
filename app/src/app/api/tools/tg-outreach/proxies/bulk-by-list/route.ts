import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * Удалить все прокси конкретного списка в кампании.
 *
 * Используется из UI при удалении списка с включённой галочкой «удалить
 * прокси вместе со списком». Без этого эндпоинта UI пришлось бы сначала
 * тащить все прокси списка в браузер (лишний трафик и RLS-фильтрация), а тут
 * сервер делает один DELETE сразу по `proxy_list_id` + `campaign_id`.
 *
 * Удаление аккаунтов, привязанных к этим прокси, идёт каскадом
 * (`tg_outreach_accounts.proxy_id ON DELETE SET NULL` — миграция 20260310):
 * прокси исчезают, а аккаунты остаются жить без прокси (то же поведение,
 * что и для одиночного DELETE /proxies/[id]).
 *
 * Сам список после этого тоже удаляется — вызывающий делает второй
 * запрос DELETE /proxy-lists/[id]. Двухшагово, потому что комбинировать
 * «удалить прокси + удалить список» в одной ручке означало бы смешать два
 * разных сценария (с галочкой и без) в одну логику — а они и в UI, и по
 * эффекту разные.
 */
export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.proxies.bulk-by-list.post' },
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

      const listId = (body.list_id as string)?.trim();
      if (!listId) return jsonError('list_id обязателен', 400);

      // Сначала отвязываем прокси от аккаунтов, чтобы не сжечь связи каскадом
      // сюрпризом: ON DELETE SET NULL сам отвяжет, но явный шаг снимает с
      // оператора вопрос «а что с аккаунтами» и держит поведение одинаковым
      // с одиночным DELETE /proxies/[id].
      const { data: proxyRows, error: selErr } = await auth.supabase
        .from('tg_outreach_proxies')
        .select('id')
        .eq('campaign_id', campaignId)
        .eq('proxy_list_id', listId);
      if (selErr) return jsonError(selErr.message, 500);

      const ids = (proxyRows ?? []).map((r) => (r as { id: string }).id);
      if (ids.length) {
        const { error: accErr } = await auth.supabase
          .from('tg_outreach_accounts')
          .update({ proxy_id: null })
          .in('proxy_id', ids);
        if (accErr) return jsonError(accErr.message, 500);

        const { error: delErr } = await auth.supabase
          .from('tg_outreach_proxies')
          .delete()
          .eq('campaign_id', campaignId)
          .eq('proxy_list_id', listId);
        if (delErr) return jsonError(delErr.message, 500);
      }

      return NextResponse.json({ deleted_count: ids.length });
    },
  );
}
