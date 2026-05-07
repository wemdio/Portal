import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { callLLM } from '@/lib/emailSequenceV2/llm';
import { PRIMER_PROMPT, TASK_PROMPT } from '@/lib/emailSequenceV2/prompts';
import { buildLetterGenerationContext } from '@/lib/emailSequenceV2/buildContext';
import { parseLettersFromModelOutput } from '@/lib/emailSequenceV2/letterParser';
import type { EmailSequenceV2RunRow } from '@/types';
import { logError, logInfo } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const { runId } = await params;
  if (!runId) return jsonError('Missing runId', 400);

  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const logMeta = { userId: user.id, requestId, route };

  let body: { model?: string } = {};
  try {
    body = (await req.json()) as { model?: string };
  } catch {
    body = {};
  }

  const { data: run, error: runErr } = await supabase
    .from('email_sequence_v2_runs')
    .select('*')
    .eq('id', runId)
    .single();
  if (runErr) return jsonError(runErr.message, runErr.code === 'PGRST116' ? 404 : 500);
  if (run.user_id !== user.id) return jsonError('Forbidden', 403);

  const typedRun = run as EmailSequenceV2RunRow;

  if (!(typedRun.brief_text ?? '').trim()) {
    return jsonError('Сначала загрузите бриф (этап 1).', 400);
  }
  if (!(typedRun.values_text ?? '').trim()) {
    return jsonError('Сначала сгенерируйте ценности (этап 1).', 400);
  }
  if (!(typedRun.segment_text ?? '').trim()) {
    return jsonError('Сначала укажите сегмент базы (этап 2).', 400);
  }

  const model = (body.model && body.model.trim()) || typedRun.writer_model || 'gpt-5.2';

  await supabase
    .from('email_sequence_v2_runs')
    .update({
      status: 'generating_letters',
      writer_model: model,
      error_message: null,
    })
    .eq('id', runId);

  await logInfo(
    'email-sequence-v2.generate-letters.start',
    'Генерация цепочки писем запущена',
    { runId, model },
    logMeta,
  );

  try {
    const userContext = await buildLetterGenerationContext(typedRun);

    const raw = await callLLM({
      model,
      messages: [
        { role: 'system', content: PRIMER_PROMPT },
        { role: 'user', content: userContext },
        { role: 'assistant', content: 'Входящие данные обработаны. Жду команду.' },
        { role: 'user', content: TASK_PROMPT },
      ],
      temperature: 0.65,
      maxTokens: 6500,
      timeoutMs: 240_000,
      title: 'Portal - Email Sequence v2 - Letters',
    });

    const letters = parseLettersFromModelOutput(raw);
    if (letters.length < 4 || letters.length > 6) {
      throw new Error(
        `Не удалось получить 4-6 писем из ответа модели (получено: ${letters.length}).`,
      );
    }

    // Replace existing AI-generated letters but keep user-added ones (если когда-то решим объединять).
    // Для простоты сейчас полностью пересоздаем все.
    await supabase.from('email_sequence_v2_letters').delete().eq('run_id', runId);

    const payload = letters.map((l, i) => ({
      run_id: runId,
      letter_index: i + 1,
      subject: l.subject,
      body: l.body,
      is_user_added: false,
    }));
    const { error: insErr } = await supabase.from('email_sequence_v2_letters').insert(payload);
    if (insErr) throw new Error(insErr.message);

    const { data: updated, error: updErr } = await supabase
      .from('email_sequence_v2_runs')
      .update({ status: 'completed' })
      .eq('id', runId)
      .select('*')
      .single();
    if (updErr) throw new Error(updErr.message);

    await logInfo(
      'email-sequence-v2.generate-letters.success',
      'Цепочка сгенерирована',
      { runId, letters: letters.length },
      logMeta,
    );

    const { data: lettersRows } = await supabase
      .from('email_sequence_v2_letters')
      .select('*')
      .eq('run_id', runId)
      .order('letter_index', { ascending: true });

    return NextResponse.json({ run: updated, letters: lettersRows ?? [] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    await supabase
      .from('email_sequence_v2_runs')
      .update({ status: 'failed', error_message: msg })
      .eq('id', runId);
    await logError('email-sequence-v2.generate-letters.failed', err, { runId, model }, logMeta);
    return jsonError(msg, 500);
  }
}
