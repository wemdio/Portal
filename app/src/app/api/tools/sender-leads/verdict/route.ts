import { NextRequest, NextResponse } from 'next/server';
import { logAudit } from '@/lib/loggerServer';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import type { LeadVerdict, ThreadVerdictDto } from '@/lib/senderLeads/history';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET ?recipientId= — метка переписки и последняя оценка ИИ по ней: окно
 * переписки в «Рассылке» показывает объяснение и кнопки «Лид» / «Не лид».
 */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.senderLeads.verdict.get' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const recipientId = new URL(req.url).searchParams.get('recipientId') ?? '';
    if (!UUID_RE.test(recipientId)) return jsonError('Не указана переписка', 400);

    const [{ data: recipient, error }, { data: qualifications }] = await Promise.all([
      supabaseAdmin
        .from('sender_recipients')
        .select('lead_verdict, lead_verdict_source, lead_verdict_at')
        .eq('id', recipientId)
        .maybeSingle(),
      supabaseAdmin
        .from('sender_reply_qualifications')
        .select('status, ai_reason, qualified_at, tg_sent_at')
        .eq('recipient_id', recipientId)
        .neq('status', 'skipped')
        .order('created_at', { ascending: false })
        .limit(1),
    ]);
    if (error) return jsonError(error.message, 500);
    if (!recipient) return jsonError('Переписка не найдена', 404);

    const last = qualifications?.[0] ?? null;
    const body: ThreadVerdictDto = {
      verdict: recipient.lead_verdict ?? null,
      verdictSource: recipient.lead_verdict_source ?? null,
      verdictAt: recipient.lead_verdict_at ?? null,
      lastQualification: last
        ? { status: last.status, aiReason: last.ai_reason, qualifiedAt: last.qualified_at, tgSentAt: last.tg_sent_at }
        : null,
    };
    return NextResponse.json(body);
  });
}

/**
 * PATCH { recipientId, verdict: 'lead' | 'not_lead' } — ручная метка.
 *
 * Приоритетнее ИИ: воркер не перебивает метку с источником manual. «Не лид»
 * до отправки в чат отменяет отправку (проверка в воркере). «Лид» вручную
 * в чат не шлёт — человек его уже видит.
 */
export async function PATCH(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.senderLeads.verdict.update' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const body = (await req.json().catch(() => null)) as { recipientId?: unknown; verdict?: unknown } | null;
    const recipientId = typeof body?.recipientId === 'string' ? body.recipientId : '';
    const verdict = body?.verdict;
    if (!UUID_RE.test(recipientId)) return jsonError('Не указана переписка', 400);
    if (verdict !== 'lead' && verdict !== 'not_lead') return jsonError('Метка — «lead» или «not_lead»', 400);

    const at = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from('sender_recipients')
      .update({
        lead_verdict: verdict satisfies LeadVerdict,
        lead_verdict_source: 'manual',
        lead_verdict_at: at,
        lead_verdict_by: auth.user.id,
      })
      .eq('id', recipientId)
      .select('id, email')
      .maybeSingle();
    if (error) return jsonError(error.message, 500);
    if (!data) return jsonError('Переписка не найдена', 404);

    await logAudit(
      'sender.leads.verdict.manual',
      `Рассылка: переписка ${data.email} отмечена «${verdict === 'lead' ? 'Лид' : 'Не лид'}» вручную`,
      { recipientId, verdict },
      { userId: auth.user.id },
    );

    return NextResponse.json({ ok: true, verdict, verdictSource: 'manual', verdictAt: at });
  });
}
