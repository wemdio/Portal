import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

interface PatchBody {
  action?: 'start' | 'pause' | 'finish';
}

/** GET — кампания целиком: шаги, ящики, свежие получатели. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.campaigns.get' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const [{ data: campaign }, { data: steps }, { data: pool }, { data: recipients }] = await Promise.all([
      supabaseAdmin.from('sender_campaigns').select('*').eq('id', id).maybeSingle(),
      supabaseAdmin.from('sender_campaign_steps').select('*').eq('campaign_id', id).order('step_no'),
      supabaseAdmin.from('sender_campaign_mailboxes').select('mailbox_id').eq('campaign_id', id),
      supabaseAdmin
        .from('sender_recipients')
        .select('id, email, name, status, last_step_sent, next_step_at, replied_at')
        .eq('campaign_id', id)
        .order('created_at', { ascending: false })
        .limit(200),
    ]);

    if (!campaign) return jsonError('Кампания не найдена', 404);

    return NextResponse.json({
      campaign,
      steps: steps ?? [],
      mailboxIds: (pool ?? []).map((row) => String(row.mailbox_id)),
      recipients: recipients ?? [],
    });
  });
}

/**
 * PATCH — запустить, поставить на паузу или закрыть кампанию.
 * При запуске получатели, которым ещё ничего не отправляли, становятся в
 * очередь немедленно: дальше их разложит по окну отправки планировщик.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.campaigns.patch' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const body = (await req.json().catch(() => null)) as PatchBody | null;
    if (!body?.action) return jsonError('Не указано действие', 400);

    const nowIso = new Date().toISOString();

    if (body.action === 'start') {
      const { count } = await supabaseAdmin
        .from('sender_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', id)
        .eq('status', 'active');
      if (!count) return jsonError('В кампании нет получателей', 422);

      const { count: mailboxCount } = await supabaseAdmin
        .from('sender_campaign_mailboxes')
        .select('mailbox_id', { count: 'exact', head: true })
        .eq('campaign_id', id);
      if (!mailboxCount) return jsonError('В кампании нет ящиков', 422);

      await supabaseAdmin
        .from('sender_recipients')
        .update({ next_step_at: nowIso, updated_at: nowIso })
        .eq('campaign_id', id)
        .eq('status', 'active')
        .is('next_step_at', null);
    }

    const status = body.action === 'start' ? 'running' : body.action === 'pause' ? 'paused' : 'done';
    const patch: Record<string, unknown> = { status, updated_at: nowIso };
    if (body.action === 'start') patch.started_at = nowIso;

    const { error } = await supabaseAdmin.from('sender_campaigns').update(patch).eq('id', id);
    if (error) return jsonError(error.message, 500);

    // Пауза и закрытие снимают уже запланированные, но ещё не отправленные
    // письма: иначе кампания продолжила бы «доезжать» после остановки.
    if (body.action !== 'start') {
      await supabaseAdmin
        .from('sender_messages')
        .update({ status: 'canceled' })
        .eq('campaign_id', id)
        .eq('status', 'scheduled');
    }

    return NextResponse.json({ ok: true, status });
  });
}
