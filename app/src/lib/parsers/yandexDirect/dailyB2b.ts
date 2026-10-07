/**
 * Ежедневный сбор рекламодателей Директа по B2B-библиотеке (решение 07.10.2026).
 *
 * Источник 'direct' автоаутрича RU читает свежие строки yandex_direct_results,
 * а сами они появлялись только от ручных задач. Теперь воркер hh раз в сутки
 * (с 01:00 МСК — чтобы закончить до проверки автодобора в 09:00) создаёт
 * обычную задачу yandex_direct_jobs: следующий отрезок YD_B2B_KEYWORDS ×
 * города-миллионники, только реклама. Выполняет её тот же runner.ts.
 *
 * Отрезок продолжает с ключа после последнего ключа предыдущей удачной
 * ежедневной задачи, по кругу. Метка задачи — колонка daily_day (день МСК),
 * у строк результатов — ниша DAILY_B2B_NICHE.
 *
 * Работает сам, без настроек (решение пользователя 07.10.2026). Env — только
 * чтобы поменять поведение (контейнер worker-hh):
 *   DIRECT_DAILY_B2B_ENABLED=0       — выключить;
 *   DIRECT_DAILY_B2B_REQUESTS=400    — запросов XMLStock в день (ключи × 13 городов):
 *                                      400 — круг по библиотеке примерно за неделю;
 *   DIRECT_DAILY_B2B_OWNER_ID=<uuid> — владелец задач; без него — тот, кто
 *                                      включил автодобор RU (outreach_autofill.owner_id).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { YD_B2B_KEYWORDS } from './b2bKeywords';
import { resolveRegions } from './regions';

export const DAILY_B2B_NICHE = 'B2B ежедневно';
export const DAILY_B2B_REGIONS = ['millionniki'];
/** Час МСК, с которого создаётся задача дня. */
export const DAILY_B2B_HOUR_MSK = 1;
const DEFAULT_DAILY_REQUESTS = 400;
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Включён по умолчанию; выключается явным 0/false/no/off. */
export function dailyB2bEnabled(): boolean {
  return !/^(0|false|no|off)$/i.test(process.env.DIRECT_DAILY_B2B_ENABLED?.trim() ?? '');
}

export function dailyB2bRequests(): number {
  const n = Math.floor(Number(process.env.DIRECT_DAILY_B2B_REQUESTS));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_REQUESTS;
}

/** День МСК в виде YYYY-MM-DD. */
export function mskDayOf(now: Date): string {
  return new Date(now.getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

export function mskHourOf(now: Date): number {
  return new Date(now.getTime() + MSK_OFFSET_MS).getUTCHours();
}

/**
 * Следующий отрезок библиотеки: count ключей после lastKeyword, по кругу.
 * lastKeyword не найден (первый запуск, ключ убрали из библиотеки) — с начала.
 */
export function nextDailySlice(library: readonly string[], lastKeyword: string | null, count: number): string[] {
  if (library.length === 0) return [];
  const size = Math.min(library.length, Math.max(1, Math.floor(count)));
  const at = lastKeyword ? library.indexOf(lastKeyword) : -1;
  const start = (at + 1) % library.length;
  return Array.from({ length: size }, (_, i) => library[(start + i) % library.length]);
}

async function resolveOwner(db: SupabaseClient): Promise<string | null> {
  const fromEnv = process.env.DIRECT_DAILY_B2B_OWNER_ID?.trim();
  if (fromEnv) return fromEnv;
  const { data, error } = await db.from('outreach_autofill').select('owner_id').eq('lang', 'ru').maybeSingle();
  if (error) throw new Error(`outreach_autofill не прочитан: ${error.message}`);
  return (data?.owner_id as string | null | undefined) ?? null;
}

/** Последний ключ последней ежедневной задачи, где прошёл хоть один запрос. */
async function lastCoveredKeyword(db: SupabaseClient): Promise<string | null> {
  const { data, error } = await db
    .from('yandex_direct_jobs')
    .select('keywords, processed_requests, errors_count')
    .not('daily_day', 'is', null)
    .eq('status', 'completed')
    .order('daily_day', { ascending: false })
    .limit(10);
  if (error) throw new Error(`прошлые ежедневные задачи не прочитаны: ${error.message}`);
  // Задача, где все запросы упали (кончился баланс XMLStock), отрезок не покрыла —
  // повторяем его, а не перескакиваем.
  const done = (data ?? []).find((j) => Number(j.processed_requests) > Number(j.errors_count));
  const raw: unknown = done ? done.keywords : null;
  const keywords: unknown[] = Array.isArray(raw) ? raw : [];
  const last = keywords[keywords.length - 1];
  return typeof last === 'string' ? last : null;
}

export type DailyB2bResult =
  | { status: 'created'; jobId: string; day: string; keywords: number; requests: number }
  | { status: 'skipped'; reason: string };

/**
 * Создаёт задачу дня, если пора и её ещё нет. Безопасно звать часто:
 * до 01:00 МСК и после создания — один дешёвый запрос (или ни одного).
 */
export async function ensureDailyB2bJob(db: SupabaseClient, now = new Date()): Promise<DailyB2bResult> {
  if (!dailyB2bEnabled()) return { status: 'skipped', reason: 'выключено (DIRECT_DAILY_B2B_ENABLED)' };
  if (mskHourOf(now) < DAILY_B2B_HOUR_MSK) return { status: 'skipped', reason: 'ещё рано' };
  const day = mskDayOf(now);

  const { data: existing, error: existingErr } = await db
    .from('yandex_direct_jobs')
    .select('id')
    .eq('daily_day', day)
    .limit(1)
    .maybeSingle();
  if (existingErr) throw new Error(`задача дня не прочитана: ${existingErr.message}`);
  if (existing) return { status: 'skipped', reason: `задача на ${day} уже есть` };

  // Вчерашняя ещё идёт — ждём её: иначе отрезок посчитается от позавчерашней и повторится.
  const { data: active, error: activeErr } = await db
    .from('yandex_direct_jobs')
    .select('id')
    .not('daily_day', 'is', null)
    .in('status', ['pending', 'processing'])
    .limit(1)
    .maybeSingle();
  if (activeErr) throw new Error(`активные ежедневные задачи не прочитаны: ${activeErr.message}`);
  if (active) return { status: 'skipped', reason: `ждём прошлую ежедневную задачу ${active.id}` };

  const owner = await resolveOwner(db);
  if (!owner) {
    return {
      status: 'skipped',
      reason: 'нет владельца: задайте DIRECT_DAILY_B2B_OWNER_ID или включите автодобор RU',
    };
  }

  const regions = resolveRegions(DAILY_B2B_REGIONS);
  const perDay = Math.max(1, Math.floor(dailyB2bRequests() / Math.max(1, regions.length)));
  const keywords = nextDailySlice(YD_B2B_KEYWORDS, await lastCoveredKeyword(db), perDay);

  const { data: job, error } = await db
    .from('yandex_direct_jobs')
    .insert({
      user_id: owner,
      niche: DAILY_B2B_NICHE,
      keyword_mode: 'manual',
      keywords,
      expand_suggest: false,
      include_organic: false,
      regions: DAILY_B2B_REGIONS,
      daily_day: day,
    })
    .select('id')
    .single();
  if (error) {
    // Уникальный индекс по daily_day: задачу дня успел создать другой воркер.
    if (error.code === '23505') return { status: 'skipped', reason: `задача на ${day} уже есть` };
    throw new Error(`задача дня не создана: ${error.message}`);
  }
  return {
    status: 'created',
    jobId: String(job.id),
    day,
    keywords: keywords.length,
    requests: keywords.length * regions.length,
  };
}
