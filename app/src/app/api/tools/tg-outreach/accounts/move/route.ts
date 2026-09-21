import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const MAX_REASON = 500;

/**
 * POST — перенести аккаунты в другую кампанию.
 *
 * Обе кампании обязаны быть остановлены, и это не формальность: круг рассылки
 * держит сессии живыми и раздаёт аккаунтам прокси по ходу работы. Переезд из-под
 * работающего круга означает, что часть аккаунта уже уехала, а сессию всё ещё
 * держит чужая кампания.
 *
 * Прокси не едет вместе с аккаунтом: пул мобильных прокси закреплён за
 * кампанией (один клиент — свои прокси), поэтому на новом месте прокси
 * назначается заново. Сессия у мобильных прокси липкая, так что смена адреса
 * для Telegram ничем не отличается от обычной ротации.
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
      .select('id, campaign_id, session_name')
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
     * Прокси снимается, аккаунт выключается.
     *
     * Прокси принадлежит прежней кампании, и на новом месте его нет. Аккаунт
     * без прокси в работу не берут, но выключаем мы его отдельно и намеренно:
     * так он не уедет в бой раньше, чем оператор назначит ему прокси и
     * посмотрит, что с ним вообще.
     */
    const { data: moved, error: moveError } = await auth.supabase
      .from('tg_outreach_accounts')
      .update({ campaign_id: toCampaignId, proxy_id: null, is_active: false })
      .in('id', accounts.map((a) => a.id))
      .select('id');
    if (moveError) return jsonError(moveError.message, 500);

    return NextResponse.json({
      moved: moved?.length ?? 0,
      to_campaign_name: to.name ?? null,
    });
  });
}
