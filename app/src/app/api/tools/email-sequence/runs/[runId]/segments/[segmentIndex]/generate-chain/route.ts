import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import type { EmailSequenceBrief } from '@/types';
import { callOpenAI } from '@/lib/emailSequence/llm';
import { safeStr } from '@/lib/emailSequence/templating';
import { PROMPT_LETTER_EXAMPLES } from '@/lib/emailSequence/promptLetterExamples.server';
import { startTrace } from '@/lib/tracer';
import { logError, logInfo } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
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

class RunCancelledError extends Error {
  constructor() {
    super('Запуск остановлен');
    this.name = 'RunCancelledError';
  }
}

function normalizeNewlines(text: string) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function splitLettersFromModelOutput(raw: string): Array<{ letter_index: 1 | 2 | 3 | 4; content: string }> {
  const text = normalizeNewlines(raw).trim();
  if (!text) return [];

  // Preferred format: ---LETTER 1--- ... ---LETTER 2--- ...
  const markerRe = /---\s*LETTER\s*([1-4])\s*---/gi;
  const markers: Array<{ idx: number; n: 1 | 2 | 3 | 4 }> = [];
  for (;;) {
    const m = markerRe.exec(text);
    if (!m) break;
    const n = Number(m[1]);
    if (n >= 1 && n <= 4) markers.push({ idx: m.index, n: n as 1 | 2 | 3 | 4 });
  }

  if (markers.length >= 2) {
    const byIdx = [...markers].sort((a, b) => a.idx - b.idx);
    const out: Array<{ letter_index: 1 | 2 | 3 | 4; content: string }> = [];
    for (let i = 0; i < byIdx.length; i += 1) {
      const cur = byIdx[i];
      const start = cur.idx;
      const end = i + 1 < byIdx.length ? byIdx[i + 1].idx : text.length;
      const block = text.slice(start, end);
      const content = block.replace(/---\s*LETTER\s*[1-4]\s*---/i, '').trim();
      if (content) out.push({ letter_index: cur.n, content });
    }
    const dedup = new Map<number, string>();
    for (const item of out) {
      if (!dedup.has(item.letter_index)) dedup.set(item.letter_index, item.content);
    }
    const result: Array<{ letter_index: 1 | 2 | 3 | 4; content: string }> = [];
    for (const n of [1, 2, 3, 4] as const) {
      const content = dedup.get(n);
      if (!content) continue;
      result.push({ letter_index: n, content });
    }
    return result;
  }

  // Fallback: split by "Тема:" occurrences.
  const blocks = text
    .split(/\n(?=Тема:)/g)
    .map((b) => b.trim())
    .filter(Boolean);

  if (blocks.length >= 4) {
    return (blocks.slice(0, 4) as string[]).map((content, i) => ({
      letter_index: (i + 1) as 1 | 2 | 3 | 4,
      content,
    }));
  }

  return [];
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function getIp(req: NextRequest) {
  const forwarded = req.headers.get('x-forwarded-for');
  if (!forwarded) return null;
  const [ip] = forwarded.split(',');
  return ip?.trim() || null;
}

function formatBrief(brief: EmailSequenceBrief): string {
  const lines: string[] = [];
  const add = (k: string, v: unknown) => {
    const s = safeStr(v).trim();
    if (s) lines.push(`- ${k}: ${s}`);
  };
  add('site', brief.site);
  add('Company', brief.Company);
  add('Product', brief.Product);
  add('Service', brief.Service);
  add('Segments', brief.Segments);
  add('CA', brief.ca);
  add('FIGURES', brief.FIGURES);
  add('sender_name', brief.sender_name);
  add('language', brief.language);
  add('notes', brief.notes);
  return lines.join('\n');
}

function buildContext(brief: EmailSequenceBrief, segment: Record<string, unknown>, prev: string[]) {
  const parts: string[] = [];
  parts.push('## prompt_letter_examples');
  parts.push('');
  parts.push('(Use as style/examples. Do not copy verbatim.)');
  parts.push('');
  parts.push('## Brief');
  parts.push(formatBrief(brief) || '- (empty)');
  parts.push('');
  parts.push('## Segment_Analysis');
  parts.push(safeStr(segment.segment_research) || '(empty)');
  parts.push('');
  parts.push('## Pains_And_Solutions');
  parts.push(safeStr(segment.pains_and_solutions) || '(empty)');
  parts.push('');
  parts.push('## Tasks_And_Solutions');
  parts.push(safeStr(segment.tasks_and_solutions) || '(empty)');
  parts.push('');
  parts.push('## Social_Proof');
  parts.push(safeStr(segment.social_proof) || '(empty)');
  parts.push('');
  parts.push('## Cases_LPR');
  parts.push(safeStr(segment.cases_lpr) || '(empty)');
  parts.push('');
  parts.push('## Buffer_Memory (previous letters)');
  if (prev.length === 0) parts.push('(none)');
  else {
    prev.forEach((txt, i) => {
      parts.push(`### Letter ${i + 1}`);
      parts.push(txt);
      parts.push('');
    });
  }
  return parts.join('\n');
}

function pickWriterModel(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  return value.slice(0, 120);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string; segmentIndex: string }> },
) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = getIp(req);
  const logMeta = { userId: user.id, requestId, route, ip };

  const { runId, segmentIndex } = await params;
  const idx = Number(segmentIndex);
  if (!runId) return jsonError('Missing runId', 400);
  if (!Number.isFinite(idx) || idx < 0 || idx > 4) return jsonError('Invalid segmentIndex (0-4)', 400);

  const ensureNotCancelled = async () => {
    const { data, error } = await supabase
      .from('email_sequence_runs')
      .select('status')
      .eq('id', runId)
      .single();
    if (error) throw new Error(error.message);
    if (String(data?.status ?? '').toLowerCase() === 'cancelled') throw new RunCancelledError();
  };

  const { data: run, error: runErr } = await supabase
    .from('email_sequence_runs')
    .select('id,brief')
    .eq('id', runId)
    .single();
  if (runErr) return jsonError(runErr.message, runErr.code === 'PGRST116' ? 404 : 500);

  const { data: segment, error: segErr } = await supabase
    .from('email_sequence_segments')
    .select('*')
    .eq('run_id', runId)
    .eq('segment_index', idx)
    .single();
  if (segErr) return jsonError(segErr.message, segErr.code === 'PGRST116' ? 404 : 500);

  const brief = (run.brief ?? {}) as EmailSequenceBrief;
  const sender = safeStr(brief.sender_name).trim();
  if (!sender) return jsonError('Brief is missing sender_name', 400);

  let body: { model?: string } = {};
  try {
    body = (await req.json()) as { model?: string };
  } catch {
    body = {};
  }
  const modelWriter =
    pickWriterModel(body.model) ??
    pickWriterModel(brief.writer_model) ??
    process.env.EMAIL_SEQUENCE_WRITER_MODEL ??
    'gpt-5.2';

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

  let trace: Awaited<ReturnType<typeof startTrace>> | null = null;

  try {
    await ensureNotCancelled();
    trace = await startTrace({
      name: 'email_sequence.generate_chain',
      input: {
        runId,
        segmentIndex: idx,
        model: modelWriter,
        requestId,
        route,
        ip,
        userId: user.id,
      },
      message: `Генерация цепочки писем (run=${runId}, сегмент=${idx + 1})`,
      userId: user.id,
    });

    await logInfo(
      'email.sequence.generate_chain.start',
      'Email sequence chain generation started',
      { runId, segmentIndex: idx, model: modelWriter },
      logMeta,
    );

    await ensureNotCancelled();

    // Reset letters for this segment.
    await supabase
      .from('email_sequence_letters')
      .delete()
      .eq('run_id', runId)
      .eq('segment_index', idx);

    const language = safeStr(brief.language).trim() || 'ru';

    const sys = [
      'Ты — AI Email Outreach Assistant.',
      'Нужно сгенерировать цепочку из 4 писем (письмо 1–4) для одного сегмента.',
      '',
      'Жёсткие правила:',
      '- Каждое письмо начинается с первой строки: "Тема: ...".',
      '- Язык письма: ' + language + '.',
      '- Подпись: только имя отправителя: ' + (sender || 'sender_name') + '. Без телефонов/сайтов/должностей.',
      '- Письмо 1: очень короткое, нейтральное, без продажи и описания продукта/оффера. Цель — попасть к ЛПР / попросить контакт.',
      '- Письмо 2: кратко представить кто мы/что делаем + 1–2 конкретных факта/доказательства + мягкий CTA (короткий созвон/ответ).',
      '- Письмо 3: снять ключевые возражения, подчеркнуть УТП, без агрессии.',
      '- Письмо 4: финальное, корректно закрыть, оставить дверь открытой, лёгкий FOMO без давления.',
      '',
      'Формат вывода ОБЯЗАТЕЛЕН (без лишнего текста):',
      '---LETTER 1---',
      '<текст письма 1>',
      '---LETTER 2---',
      '<текст письма 2>',
      '---LETTER 3---',
      '<текст письма 3>',
      '---LETTER 4---',
      '<текст письма 4>',
    ].join('\n');

    const examples = [
      '## Examples (do not copy verbatim)',
      '',
      '### Letter 1 examples',
      PROMPT_LETTER_EXAMPLES.letter1,
      '',
      '### Letter 2 examples',
      PROMPT_LETTER_EXAMPLES.letter2,
      '',
      '### Letter 3 examples',
      PROMPT_LETTER_EXAMPLES.letter3,
      '',
      '### Letter 4 examples',
      PROMPT_LETTER_EXAMPLES.letter4,
    ].join('\n');

    const userContext = buildContext(brief, segment, [])
      .replace('(Use as style/examples. Do not copy verbatim.)', examples);

    const chainSpan = await trace?.startChild({
      name: 'email_sequence.chain_single_call',
      input: { runId, segmentIndex: idx, model: modelWriter, sysChars: sys.length, contextChars: userContext.length },
      message: 'OpenAI: генерация 4 писем одним запросом',
    });

    let raw = '';
    try {
      await ensureNotCancelled();
      raw = await callOpenAI({
        model: modelWriter,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: userContext },
        ],
        temperature: 0.6,
        maxTokens: 2600,
        timeoutMs: 180_000,
      });
      await chainSpan?.end({ textChars: raw.length }, `Ок (${raw.length} chars)`);
    } catch (err) {
      await chainSpan?.fail(err, { sysChars: sys.length, contextChars: userContext.length });
      throw err;
    }

    await ensureNotCancelled();

    const letters = splitLettersFromModelOutput(raw);
    if (letters.length !== 4) {
      throw new Error(`Не удалось разобрать 4 письма из ответа модели (получено: ${letters.length})`);
    }

    const payload = letters.map((l) => ({
      run_id: runId,
      segment_index: idx,
      letter_index: l.letter_index,
      content: l.content,
    }));

    const { error: insErr } = await supabase.from('email_sequence_letters').insert(payload);
    if (insErr) throw new Error(insErr.message);

    await ensureNotCancelled();

    await supabase
      .from('email_sequence_runs')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', runId);

    await trace?.end(
      {
        letters: letters.map((t) => ({ letterIndex: t.letter_index, chars: t.content.length })),
      },
      'Цепочка писем сгенерирована',
    );

    await logInfo(
      'email.sequence.generate_chain.success',
      'Email sequence chain generation completed',
      { runId, segmentIndex: idx, letters: letters.length },
      logMeta,
    );

    return NextResponse.json({
      letters: letters.map((l) => l.content),
      tariff_usage: tariffUsage ? await getClientTariffUsage(user.id) : null,
    });
  } catch (err) {
    if (err instanceof RunCancelledError) {
      await trace?.end({ cancelled: true }, 'Остановлено пользователем');
      await supabase
        .from('email_sequence_runs')
        .update({ status: 'cancelled', error_message: null, updated_at: new Date().toISOString() })
        .eq('id', runId);
      return jsonError(err.message, 409);
    }
    const msg = err instanceof Error ? err.message : 'Unknown error';
    await trace?.fail(err, { runId, segmentIndex: idx });
    await logError(
      'email.sequence.generate_chain.failed',
      err,
      { runId, segmentIndex: idx, model: modelWriter },
      logMeta,
    );
    await supabase
      .from('email_sequence_runs')
      .update({ status: 'failed', error_message: msg, updated_at: new Date().toISOString() })
      .eq('id', runId);
    return jsonError(msg, 500);
  }
}

