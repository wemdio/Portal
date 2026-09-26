import { NextResponse, type NextRequest } from 'next/server';
import { logAudit, logError } from '@/lib/loggerServer';
import { outreachApiKey } from '@/lib/outreachLlm/client';
import { authed, jsonError } from '@/lib/polzaRuOutreach/routeAuth';
import { RU_OUTREACH_PARSER_TYPE, sanitizeRuOutreachConfig, type RuOutreachConfig } from '@/lib/polzaRuOutreach/types';

export const dynamic = 'force-dynamic';

/** История запусков «Нашего автоаутрича». */
export async function GET(req: NextRequest) {
  const auth = await authed(req);
  if ('error' in auth) return auth.error;
  const { data, error } = await auth.supabase
    .from('parser_jobs')
    .select('*')
    .eq('parser_type', RU_OUTREACH_PARSER_TYPE)
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) {
    await logError('polza_ru_outreach.jobs.list.failed', error, undefined, { userId: auth.user.id });
    return jsonError(error.message, 500);
  }
  return NextResponse.json({ jobs: data ?? [] });
}

/**
 * Запуск оффера: профиль фиксируется здесь и дальше не меняется. Лимит на ИИ
 * (llm_budget_usd) проходит ту же санитизацию, что и остальной конфиг.
 */
export async function POST(req: NextRequest) {
  const auth = await authed(req);
  if ('error' in auth) return auth.error;
  // Без своего ключа запуск упал бы в воркере на первой же компании — говорим
  // сразу, запуск не создаём.
  if (!outreachApiKey('ru')) {
    return jsonError('Не задан ключ ИИ для русского автоаутрича (POLZA_RU_OUTREACH_API_KEY в .env сервера)', 400);
  }
  let raw: Partial<RuOutreachConfig>;
  try {
    raw = (await req.json()) as Partial<RuOutreachConfig>;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  if (!raw || typeof raw !== 'object') return jsonError('Invalid config payload', 400);

  const config = sanitizeRuOutreachConfig(raw);
  const { count } = await auth.supabase
    .from('polza_ru_senders')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active');
  if (!count) return jsonError('Нет активной подписи отправителя — добавьте её во вкладке «Библиотеки»', 400);

  const { data, error } = await auth.supabase
    .from('parser_jobs')
    .insert({
      user_id: auth.user.id,
      parser_type: RU_OUTREACH_PARSER_TYPE,
      status: 'pending',
      progress_stage: 'pending',
      progress_percent: 0,
      config,
    })
    .select('*')
    .single();
  if (error) {
    await logError('polza_ru_outreach.job.create.failed', error, { config }, { userId: auth.user.id });
    return jsonError(error.message, 500);
  }
  await logAudit('polza_ru_outreach.job.created', 'Наш автоаутрич: запуск создан', { jobId: data?.id, config }, { userId: auth.user.id });
  return NextResponse.json({ job: data });
}
