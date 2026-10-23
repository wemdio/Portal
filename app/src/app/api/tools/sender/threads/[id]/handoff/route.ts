import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import {
  enqueueSenderHandoff,
  HandoffAlreadyQueuedError,
  loadSenderHandoffContext,
  parseEmailList,
} from '@/lib/sender/clientHandoff';
import { buildHandoffDraft } from '@/lib/instantly/handoffLegend';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const MAX_BODY_CHARS = 20_000;
const MAX_CC = 10;

const API_KEY = () =>
  process.env.OPENROUTER_INSTANTLY_LEAD_API_KEY ??
  process.env.OPENROUTER_BRIEF_API_KEY ??
  '';

/**
 * GET — можно ли передать лида клиенту из этой переписки и с чем: кому письмо,
 * кто в копии, черновик по легенде проекта (lib/sender/clientHandoff). С
 * ?ai=1 и включённым у проекта ИИ-пересказом легенда подстраивается под ответ
 * лида, как у передачи из Instantly; сбой ИИ — легенда как есть. ИИ — только
 * по кнопке передачи, не при каждом открытии переписки.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.threads.handoff.get' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const ctx = await loadSenderHandoffContext(supabaseAdmin, supabaseInstantly, id);
    if (!ctx) return jsonError('Переписка не найдена', 404);
    const wantAi = req.nextUrl.searchParams.get('ai') === '1';
    const draft = ctx.blocked === null && ctx.aiAdapt && wantAi
      ? await buildHandoffDraft({
          aiAdapt: true,
          legend: ctx.legend,
          leadName: ctx.leadName,
          leadReplyText: ctx.reply?.body ?? '',
          apiKey: API_KEY(),
        })
      : ctx.draft;
    return NextResponse.json({
      available: ctx.blocked === null,
      reason: ctx.blocked,
      to: ctx.to,
      cc: ctx.cc,
      draft,
      aiAdapt: ctx.aiAdapt,
      mailbox: ctx.mailboxEmail,
      // Без клиента письмо уйдёт, но в кабинет лид не запишется — экран предупредит.
      clientLinked: Boolean(ctx.clientUserId),
    });
  });
}

/**
 * POST — передать лида: письмо в тот же тред с ящика переписки, клиент в
 * копии; получатель отмечается лидом, в кабинет клиента лид попадёт, когда
 * письмо уйдёт.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.threads.handoff' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { text?: unknown; cc?: unknown } | null;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) return jsonError('Письмо пустое', 400);
    if (text.length > MAX_BODY_CHARS) return jsonError('Письмо слишком длинное', 400);

    const ctx = await loadSenderHandoffContext(supabaseAdmin, supabaseInstantly, id);
    if (!ctx) return jsonError('Переписка не найдена', 404);
    if (ctx.blocked) return jsonError(ctx.blocked, 409);

    // Копию оператор может поправить; не прислал её вовсе — копия по умолчанию.
    // Опечатку не выбрасываем молча: письмо без клиента в копии — не передача.
    let cc = ctx.cc;
    if (Array.isArray(body?.cc)) {
      const parsed = parseEmailList(body.cc.filter((value): value is string => typeof value === 'string').join(','));
      if (parsed.invalid.length) return jsonError(`Неверные адреса в копии: ${parsed.invalid.join(', ')}`, 400);
      cc = parsed.emails;
    }
    if (!cc.length) return jsonError('Укажите почту клиента для копии', 400);
    if (cc.length > MAX_CC) return jsonError(`В копии не больше ${MAX_CC} адресов`, 400);
    if (cc.includes(ctx.to)) return jsonError('Адрес лида не может стоять в копии', 400);

    try {
      const result = await enqueueSenderHandoff({ db: supabaseAdmin, ctx, text, cc, userId: auth.user.id });
      return NextResponse.json({ ok: true, ...result });
    } catch (e) {
      if (e instanceof HandoffAlreadyQueuedError) return jsonError(e.message, 409);
      return jsonError(e instanceof Error ? e.message : 'Не удалось передать лида', 500);
    }
  });
}
