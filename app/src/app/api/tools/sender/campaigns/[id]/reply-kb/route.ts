import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/** Длиннее брифа на практике не бывает: это не документ, а выжимка для ИИ. */
const MAX_FIELD = 20_000;

/**
 * База знаний кампании для ИИ-ответов лидам: бриф, тон, пример письма.
 * Всё необязательно — без брифа ИИ опирается на нашу цепочку писем.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.campaigns.reply-kb.get' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);
    const { id } = await params;
    const { data, error } = await supabaseAdmin
      .from('sender_campaigns')
      .select('id, name, reply_brief, reply_tone, reply_example')
      .eq('id', id)
      .maybeSingle();
    if (error) return jsonError(error.message, 500);
    if (!data) return jsonError('Кампания не найдена', 404);
    return NextResponse.json({
      name: data.name,
      brief: data.reply_brief ?? '',
      tone: data.reply_tone ?? '',
      example: data.reply_example ?? '',
    });
  });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.sender.campaigns.reply-kb.put' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const field = (key: string) => (typeof body?.[key] === 'string' ? (body[key] as string).trim() : '');
    const patch = { reply_brief: field('brief'), reply_tone: field('tone'), reply_example: field('example') };
    if (Object.values(patch).some((v) => v.length > MAX_FIELD)) return jsonError('Поле слишком длинное', 400);
    const { error } = await supabaseAdmin.from('sender_campaigns').update(patch).eq('id', id);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  });
}
