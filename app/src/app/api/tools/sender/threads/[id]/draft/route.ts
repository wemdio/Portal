import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { generateSenderDraft, latestOpenDraft, loadSenderReplyContext, SenderDraftError } from '@/lib/senderReplies/draft';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';
// Gemini с поиском по сайтам отвечает до пары минут, с повторами — дольше.
export const maxDuration = 300;

function parseLanguage(value: unknown): 'ru' | 'en' | null {
  return value === 'ru' || value === 'en' ? value : null;
}

function fail(err: unknown) {
  if (err instanceof SenderDraftError) return jsonError(err.message, err.status);
  return jsonError(err instanceof Error ? err.message : 'Не удалось подготовить ответ', 502);
}

/** GET — открытый черновик ИИ и выбранный язык переписки. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.threads.draft.get' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);
    const { id } = await params;
    try {
      const [ctx, draft] = await Promise.all([loadSenderReplyContext(supabaseAdmin, id), latestOpenDraft(supabaseAdmin, id)]);
      return NextResponse.json({ draft, language: ctx.language, hasBrief: Boolean(ctx.campaign.reply_brief?.trim()) });
    } catch (err) {
      return fail(err);
    }
  });
}

/** POST { language } — сгенерировать персонализированный ответ. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.threads.draft.generate' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { language?: unknown } | null;
    const language = parseLanguage(body?.language) ?? 'ru';
    try {
      const draft = await generateSenderDraft(supabaseAdmin, id, auth.user.id, language);
      return NextResponse.json({ draft });
    } catch (err) {
      return fail(err);
    }
  });
}

/** PUT { language } — запомнить язык ответа на переписке без генерации. */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.threads.draft.language' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { language?: unknown } | null;
    const language = parseLanguage(body?.language);
    if (!language) return jsonError('Язык — ru или en', 400);
    const { error } = await supabaseAdmin.from('sender_recipients').update({ reply_language: language }).eq('id', id);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true, language });
  });
}
