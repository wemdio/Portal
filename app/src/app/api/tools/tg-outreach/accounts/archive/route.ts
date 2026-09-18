import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { parseArchiveBody } from '@/lib/tgOutreach/accountArchive';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * POST — убрать аккаунты кампании в архив с причиной.
 *
 * Архивный аккаунт выключается: воркеры рассылки и прогрева берут только
 * включённые, так что из работы он уходит на ближайшем круге. Фильтр по
 * campaign_id обязателен — чужой id в списке не должен задеть соседнюю
 * кампанию. Уже лежащие в архиве не трогаем: дата и причина первого ухода
 * важнее повторного нажатия.
 */
export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.tg-outreach.accounts.archive.post' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const parsed = parseArchiveBody(await req.json().catch(() => null));
    if (!parsed.ok) return jsonError(parsed.error, 400);

    const { data: profile } = await auth.supabase
      .from('profiles')
      .select('full_name, email')
      .eq('id', auth.user.id)
      .maybeSingle();
    const byName = (profile?.full_name as string | null) || (profile?.email as string | null) || auth.user.email || null;

    const { data, error } = await auth.supabase
      .from('tg_outreach_accounts')
      .update({
        archived_at: new Date().toISOString(),
        archive_reason: parsed.reason,
        archive_note: parsed.note,
        archived_by_name: byName,
        is_active: false,
      })
      .eq('campaign_id', parsed.campaignId)
      .in('id', parsed.ids)
      .is('archived_at', null)
      .select('id');

    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true, count: data?.length ?? 0 });
  });
}

/**
 * DELETE — вернуть аккаунты из архива в список кампании.
 *
 * Возвращаются выключенными: за время в архиве сессия могла умереть или
 * кулдаун не кончиться, и сразу пускать такой аккаунт в рассылку опасно.
 * Оператор проверяет и включает его сам. Причину стираем — она про прошлый
 * уход, при следующем будет своя.
 */
export async function DELETE(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.tg-outreach.accounts.archive.delete' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const body = (await req.json().catch(() => null)) as { campaign_id?: unknown; ids?: unknown } | null;
    const campaignId = typeof body?.campaign_id === 'string' ? body.campaign_id : '';
    if (!campaignId) return jsonError('campaign_id обязателен', 400);
    const ids = Array.isArray(body?.ids) ? body.ids.filter((v): v is string => typeof v === 'string') : [];
    if (!ids.length) return jsonError('Выберите аккаунты', 400);

    const { data, error } = await auth.supabase
      .from('tg_outreach_accounts')
      .update({ archived_at: null, archive_reason: null, archive_note: null, archived_by_name: null })
      .eq('campaign_id', campaignId)
      .in('id', ids)
      .not('archived_at', 'is', null)
      .select('id');

    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true, count: data?.length ?? 0 });
  });
}
