import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { proxyCountryName } from '@/lib/tgOutreach/proxyCountry';

export const dynamic = 'force-dynamic';

const DEAD_LIST = 'Не работают';
const NO_COUNTRY_LIST = 'Авто · страна не определена';
const MOVE_CHUNK = 200;

/**
 * POST — разложить проверенные «Неопределённые» прокси по спискам (15.10.2026).
 *
 * Рабочие (Telegram через них доступен) — в «Авто · <Страна>», нерабочие — в
 * «Не работают». Списки создаются сами, если их ещё нет. Непроверенные
 * прокси остаются в «Неопределённых»: страна и вердикт берутся из последней
 * проверки (POST /proxies/check c save=true).
 *
 * Запрос: { campaign_id }   Ответ: { moved, groups: [{ name, count }] }
 */
export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.tg-outreach.proxies.auto-sort.post' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    let body: { campaign_id?: string };
    try {
      body = await req.json();
    } catch {
      return jsonError('Неверный JSON', 400);
    }
    const campaignId = body.campaign_id;
    if (!campaignId) return jsonError('campaign_id обязателен', 400);

    // Проверенные прокси без списка: страницами — в кампании их тысячи.
    const rows: { id: string; check_status: string | null; country_code: string | null }[] = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await auth.supabase
        .from('tg_outreach_proxies')
        .select('id, check_status, country_code')
        .eq('campaign_id', campaignId)
        .is('proxy_list_id', null)
        .not('checked_at', 'is', null)
        .order('id')
        .range(from, from + PAGE - 1);
      if (error) return jsonError(error.message, 500);
      rows.push(...((data ?? []) as typeof rows));
      if (!data || data.length < PAGE) break;
    }

    const byList = new Map<string, string[]>();
    for (const r of rows) {
      const name =
        r.check_status === 'ok'
          ? r.country_code
            ? `Авто · ${proxyCountryName(r.country_code) ?? r.country_code}`
            : NO_COUNTRY_LIST
          : DEAD_LIST;
      const ids = byList.get(name) ?? [];
      ids.push(r.id);
      byList.set(name, ids);
    }
    if (!byList.size) return NextResponse.json({ moved: 0, groups: [] });

    const { data: existing, error: listsErr } = await auth.supabase
      .from('tg_outreach_proxy_lists')
      .select('id, name')
      .eq('campaign_id', campaignId);
    if (listsErr) return jsonError(listsErr.message, 500);
    const listIdByName = new Map((existing ?? []).map((l: { id: string; name: string }) => [l.name, l.id]));

    const groups: { name: string; count: number }[] = [];
    for (const [name, ids] of byList) {
      let listId = listIdByName.get(name);
      if (!listId) {
        const { data: created, error: createErr } = await auth.supabase
          .from('tg_outreach_proxy_lists')
          .insert({ campaign_id: campaignId, name })
          .select('id')
          .single();
        if (createErr || !created) return jsonError(createErr?.message ?? 'Не удалось создать список', 500);
        listId = (created as { id: string }).id;
      }
      for (let i = 0; i < ids.length; i += MOVE_CHUNK) {
        const { error: moveErr } = await auth.supabase
          .from('tg_outreach_proxies')
          .update({ proxy_list_id: listId })
          .eq('campaign_id', campaignId)
          .in('id', ids.slice(i, i + MOVE_CHUNK));
        if (moveErr) return jsonError(moveErr.message, 500);
      }
      groups.push({ name, count: ids.length });
    }

    return NextResponse.json({ moved: rows.length, groups });
  });
}
