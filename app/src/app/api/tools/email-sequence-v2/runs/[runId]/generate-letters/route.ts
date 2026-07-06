import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { callLLM } from '@/lib/emailSequenceV2/llm';
import { getPrimerAck, getPrimerPrompt, getTaskPrompt, normalizeOutputLanguage } from '@/lib/emailSequenceV2/prompts';
import { buildLetterGenerationContext } from '@/lib/emailSequenceV2/buildContext';
import { parseLettersFromModelOutput } from '@/lib/emailSequenceV2/letterParser';
import type { EmailSequenceV2RunRow } from '@/types';
import { logError, logInfo } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { blockDemo } from '@/lib/auth/blockDemo';
import {
  countChains,
  getBillingPeriodStart,
  getClientTariffRow,
  getClientStatus,
  getClientTariffUsage,
  resolveEffectiveLimits,
} from '@/lib/tariffs';

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

  const demo = await blockDemo(supabase, user.id);
  if (demo) return demo;

  const { runId } = await params;
  if (!runId) return jsonError('Missing runId', 400);

  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const logMeta = { userId: user.id, requestId, route };

  let body: { model?: string; language?: string } = {};
  try {
    body = (await req.json()) as { model?: string; language?: string };
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
  const outputLanguage = normalizeOutputLanguage(body.language ?? typedRun.output_language);

  let tariffUsage: Awaited<ReturnType<typeof getClientTariffUsage>> | null = null;
  if (supabaseAdmin) {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();
    if (profile?.role === 'client') {
      const tariffRow = await getClientTariffRow(user.id);
      const clientStatus = getClientStatus(tariffRow);
      if (clientStatus === 'setup') {
        return jsonError('Ваш личный кабинет настраивается. Пожалуйста, подождите — мы скоро всё подготовим.', 403);
      }
      if (clientStatus !== 'active') {
        return jsonError('Подписка не активна. Оплатите тариф для продолжения работы.', 403);
      }
      const limits = resolveEffectiveLimits(tariffRow);
      const periodStart = getBillingPeriodStart(tariffRow);
      const usedThisPeriod = await countChains(user.id, periodStart);
      tariffUsage = await getClientTariffUsage(user.id);
      if (usedThisPeriod >= limits.max_chains_per_month) {
        return jsonError(
          `Лимит генераций цепочек: ${limits.max_chains_per_month} / мес. ` +
          `Использовано: ${usedThisPeriod}. Осталось: ${Math.max(0, limits.max_chains_per_month - usedThisPeriod)}.`,
          429,
        );
      }
    }
  }

  await supabase
    .from('email_sequence_v2_runs')
    .update({
      status: 'generating_letters',
      writer_model: model,
      output_language: outputLanguage,
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
        { role: 'system', content: getPrimerPrompt(outputLanguage) },
        { role: 'user', content: userContext },
        { role: 'assistant', content: getPrimerAck(outputLanguage) },
        { role: 'user', content: getTaskPrompt(outputLanguage) },
      ],
      temperature: 0.65,
      maxTokens: 6500,
      timeoutMs: 240_000,
      title: 'Portal - Email Sequence v2 - Letters',
    });

    const letters = parseLettersFromModelOutput(raw);
    // Промпт просит 3–5 писем; верхнюю границу держим 6 (толерантность к
    // моделям, которые «перевыполняют») — важно не завалить прогон парс-ошибкой.
    if (letters.length < 3 || letters.length > 6) {
      throw new Error(
        `Не удалось получить 3-5 писем из ответа модели (получено: ${letters.length}).`,
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
      // Дефолтный график: первое сразу, дальше каждые 2 дня. Клиент может
      // поменять per-letter в редакторе цепочки.
      wait_days: i === 0 ? 0 : 2,
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

    return NextResponse.json({
      run: updated,
      letters: lettersRows ?? [],
      tariff_usage: tariffUsage ? await getClientTariffUsage(user.id) : null,
    });
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
