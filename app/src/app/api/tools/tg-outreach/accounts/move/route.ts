import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { logCampaign } from '@/lib/tgOutreach/campaignLog';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const MAX_REASON = 500;

/**
 * POST — перенести аккаунты в другую кампанию.
 *
 * Обе кампании обязаны быть остановлены, и это не формальность: круг рассылки
 * держит сессии живыми и раздаёт аккаунтам прокси по ходу работы. Переезд из-под
 * работающего круга означает, что часть аккаунта уже уехала, а сессию всё ещё
 * держит чужая кампания (две сессии на один аккаунт — AUTH_KEY_DUPLICATED).
 *
 * Аккаунт переезжает в том состоянии, в каком он был: включённый остаётся
 * включённым, цена, профиль и история на месте. С ним едет и его прокси
 * (22.10.2026): прокси принадлежит кампании, и без него аккаунт на новом месте
 * подключился бы с IP сервера.
 *
 * Куда переносить — любая остановленная кампания. Правило «перенесённый можно
 * только вернуть домой» снято 22.10.2026: переезды идут между кампаниями
 * свободно, а след остаётся в журнале переносов и в пометке «откуда пришёл».
 */
export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.tg-outreach.accounts.move.post' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const body = (await req.json().catch(() => null)) as
      | { account_ids?: unknown; to_campaign_id?: unknown; reason?: unknown }
      | null;
    if (!body) return jsonError('Неверный JSON', 400);

    const ids = Array.isArray(body.account_ids)
      ? [...new Set(body.account_ids.filter((v): v is string => typeof v === 'string' && v.length > 0))]
      : [];
    if (!ids.length) return jsonError('Не выбрано ни одного аккаунта', 400);

    const toCampaignId = typeof body.to_campaign_id === 'string' ? body.to_campaign_id : '';
    if (!toCampaignId) return jsonError('Выберите кампанию, куда переносим', 400);

    // Причина обязательна: через месяц «почему этот аккаунт здесь» — первый и
    // единственный вопрос, и отвечать на него будет нечем.
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, MAX_REASON) : '';
    if (!reason) return jsonError('Укажите причину переноса', 400);

    const { data: accounts, error: accError } = await auth.supabase
      .from('tg_outreach_accounts')
      .select('id, campaign_id, session_name, proxy_id, moved_from_campaign_id, moved_from_campaign_name')
      .in('id', ids);
    if (accError) return jsonError(accError.message, 500);
    if (!accounts?.length) return jsonError('Аккаунты не найдены', 404);

    const fromIds = [...new Set(accounts.map((a) => String(a.campaign_id)))];
    if (fromIds.length > 1) {
      return jsonError('Аккаунты из разных кампаний — переносите по одной кампании за раз', 400);
    }
    const fromCampaignId = fromIds[0];
    if (fromCampaignId === toCampaignId) {
      return jsonError('Аккаунты уже в этой кампании', 400);
    }

    const { data: campaigns, error: campError } = await auth.supabase
      .from('tg_outreach_campaigns')
      .select('id, name, status')
      .in('id', [fromCampaignId, toCampaignId]);
    if (campError) return jsonError(campError.message, 500);

    const from = campaigns?.find((c) => String(c.id) === fromCampaignId);
    const to = campaigns?.find((c) => String(c.id) === toCampaignId);
    if (!to) return jsonError('Кампания, куда переносим, не найдена', 404);

    // «error» — это тоже остановленная кампания: круг в ней не идёт.
    const stopped = (status: unknown) => status === 'stopped' || status === 'error';
    if (from && !stopped(from.status)) {
      return jsonError(`Кампания «${from.name}» не остановлена — сначала остановите её`, 409);
    }
    if (!stopped(to.status)) {
      return jsonError(`Кампания «${to.name}» не остановлена — сначала остановите её`, 409);
    }

    const { data: profile } = await auth.supabase
      .from('profiles')
      .select('full_name, email')
      .eq('id', auth.user.id)
      .maybeSingle();
    const byName =
      (profile?.full_name as string | null) || (profile?.email as string | null) || auth.user.email || null;

    // Запись о переносе идёт ПЕРЕД самим переносом: если упасть между ними,
    // лишняя строка истории безобиднее, чем аккаунт в чужой кампании без
    // объяснения, откуда он там взялся.
    const { error: logError } = await auth.supabase.from('tg_outreach_account_moves').insert(
      accounts.map((a) => ({
        account_id: a.id,
        from_campaign_id: fromCampaignId,
        from_campaign_name: (from?.name as string | null) ?? null,
        to_campaign_id: toCampaignId,
        to_campaign_name: (to.name as string | null) ?? null,
        reason,
        moved_by: auth.user.id,
        moved_by_name: byName,
      })),
    );
    if (logError) return jsonError(logError.message, 500);

    /**
     * Прокси едет вместе с аккаунтом.
     *
     * Строка прокси принадлежит кампании (круг читает прокси по campaign_id),
     * поэтому её переписываем на новую кампанию — со списком «без списка»: списки
     * тоже принадлежат старой кампании. Если тем же прокси пользуются аккаунты,
     * которые остаются, — переносим копию (адрес тот же, статистика с нуля),
     * чтобы не оставить их без прокси.
     */
    const movedIds = new Set(accounts.map((a) => String(a.id)));
    const proxyIds = [...new Set(accounts.map((a) => a.proxy_id).filter((p): p is string => Boolean(p)))];
    const newProxyFor = new Map<string, string>();
    let proxiesMoved = 0;
    let proxiesCopied = 0;
    if (proxyIds.length) {
      const { data: sharedRows, error: sharedError } = await auth.supabase
        .from('tg_outreach_accounts')
        .select('id, proxy_id')
        .in('proxy_id', proxyIds);
      if (sharedError) return jsonError(sharedError.message, 500);
      const stays = new Set(
        (sharedRows ?? []).filter((r) => !movedIds.has(String(r.id))).map((r) => String(r.proxy_id)),
      );

      const { data: proxyRows, error: proxyError } = await auth.supabase
        .from('tg_outreach_proxies')
        .select('id, url, name, is_active, country_code')
        .in('id', proxyIds);
      if (proxyError) return jsonError(proxyError.message, 500);

      for (const proxy of proxyRows ?? []) {
        const proxyId = String(proxy.id);
        if (stays.has(proxyId)) {
          const { data: copy, error: copyError } = await auth.supabase
            .from('tg_outreach_proxies')
            .insert({
              campaign_id: toCampaignId,
              url: proxy.url,
              name: proxy.name,
              is_active: proxy.is_active,
              country_code: proxy.country_code,
            })
            .select('id')
            .single();
          if (copyError) return jsonError(copyError.message, 500);
          newProxyFor.set(proxyId, String(copy.id));
          proxiesCopied += 1;
        } else {
          const { error: moveProxyError } = await auth.supabase
            .from('tg_outreach_proxies')
            .update({ campaign_id: toCampaignId, proxy_list_id: null })
            .eq('id', proxyId);
          if (moveProxyError) return jsonError(moveProxyError.message, 500);
          newProxyFor.set(proxyId, proxyId);
          proxiesMoved += 1;
        }
      }
    }

    /**
     * Сам перенос. Включённость, цена, профиль и остальное не трогаем — аккаунт
     * переезжает как есть. Меняются кампания, прокси (на перенесённый или его
     * копию) и пометка «откуда пришёл».
     *
     * Пометка: возврат в кампанию, откуда аккаунт пришёл, снимает её — он дома.
     * Любой другой перенос записывает, из какой кампании аккаунт приехал сейчас.
     * Пишем по одному: у аккаунтов разные прокси и разная история.
     */
    const movedAt = new Date().toISOString();
    for (const a of accounts) {
      const returning = a.moved_from_campaign_id != null && String(a.moved_from_campaign_id) === toCampaignId;
      const { error: moveError } = await auth.supabase
        .from('tg_outreach_accounts')
        .update({
          campaign_id: toCampaignId,
          ...(a.proxy_id ? { proxy_id: newProxyFor.get(String(a.proxy_id)) ?? a.proxy_id } : {}),
          moved_from_campaign_id: returning ? null : fromCampaignId,
          moved_from_campaign_name: returning ? null : ((from?.name as string | null) ?? null),
          moved_reason: returning ? null : reason,
          moved_at: returning ? null : movedAt,
        })
        .eq('id', a.id);
      if (moveError) return jsonError(moveError.message, 500);
    }

    /**
     * Журналы обеих кампаний.
     *
     * Запись уходит и туда, откуда ушли, и туда, куда пришли: на вкладке «Логи»
     * оператор смотрит одну кампанию, и «аккаунты просто исчезли» в одной из них
     * — ровно тот случай, ради которого журнал и ведут.
     *
     * Имена сессий перечислены в строке намеренно: журнал аккаунта собирается
     * поиском его session_name по сообщениям, так что эта же запись попадёт и в
     * карточку каждого переехавшего аккаунта.
     */
    const who = byName ?? 'неизвестно кто';
    const names = accounts.map((a) => String(a.session_name)).join(', ');
    const proxyNote = proxyIds.length
      ? ` Прокси: перенесено ${proxiesMoved}${proxiesCopied ? `, скопировано ${proxiesCopied}` : ''}.`
      : '';
    const moveLine = (direction: string) =>
      `${who}: перенёс аккаунты ${direction}. Аккаунтов ${accounts.length} (${names}).${proxyNote} Причина: ${reason}`;

    await Promise.all([
      from
        ? logCampaign(
            auth.supabase,
            fromCampaignId,
            'info',
            moveLine(`в кампанию «${to.name ?? toCampaignId}»`),
          )
        : Promise.resolve(),
      logCampaign(
        auth.supabase,
        toCampaignId,
        'info',
        moveLine(`из кампании «${from?.name ?? fromCampaignId}»`),
      ),
    ]);

    return NextResponse.json({
      moved: accounts.length,
      proxies_moved: proxiesMoved,
      proxies_copied: proxiesCopied,
      to_campaign_name: to.name ?? null,
    });
  });
}
