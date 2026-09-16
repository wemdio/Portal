import type { SupabaseClient } from '@supabase/supabase-js';
import { mskDayStartUtc } from './limits';

/**
 * Сколько ключ уже израсходовал. Считается по тому же журналу и той же границе
 * суток, что и сами лимиты (`mskDayStartUtc`) — иначе цифра на экране
 * разошлась бы с той, по которой API реально отказывает, и доверять экрану
 * стало бы нельзя.
 *
 * `max_active_jobs` сюда не входит: он считается по таблицам задач и живёт
 * мгновением, а не сутками. Показывать его рядом с суточными счётчиками
 * значило бы сравнивать несравнимое.
 */
export interface BenchKeyUsage {
  requests_last_minute: number;
  jobs_today: number;
  rows_today: number;
}

export interface BenchDayUsage {
  /** Календарная дата по Москве, YYYY-MM-DD. */
  date: string;
  jobs: number;
  rows: number;
  requests: number;
}

interface JournalRow {
  key_id: string;
  action: string;
  status_code: number;
  rows_returned: number | null;
  created_at: string;
}

/**
 * Потолок на выборку журнала. Экран админки — не аналитика: если за сутки
 * набралось больше обращений, чем здесь, счётчик будет занижен, но страница
 * не ляжет. Реальные объёмы на порядки меньше.
 */
const MAX_JOURNAL_ROWS = 50_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const MSK_SHIFT_MS = 3 * 60 * 60 * 1000;

/** Дата по Москве в виде YYYY-MM-DD. */
function mskDate(iso: string): string {
  return new Date(new Date(iso).getTime() + MSK_SHIFT_MS).toISOString().slice(0, 10);
}

/**
 * Расход всех ключей за сегодня — одним запросом к журналу.
 *
 * Одним, а не по ключу на каждый: ключей на экране может быть десяток, и
 * отдельный запрос на каждого превратил бы открытие страницы в очередь
 * round-trip'ов к базе.
 */
export async function loadBenchUsage(
  admin: SupabaseClient,
  now: Date = new Date(),
): Promise<Record<string, BenchKeyUsage>> {
  const dayStart = mskDayStartUtc(now);
  const minuteAgo = new Date(now.getTime() - 60_000).getTime();

  const { data } = await admin
    .from('bench_api_requests')
    .select('key_id, action, status_code, rows_returned, created_at')
    .gte('created_at', dayStart)
    .limit(MAX_JOURNAL_ROWS);

  const usage: Record<string, BenchKeyUsage> = {};
  for (const row of (data ?? []) as JournalRow[]) {
    const entry = (usage[row.key_id] ??= {
      requests_last_minute: 0,
      jobs_today: 0,
      rows_today: 0,
    });

    if (new Date(row.created_at).getTime() >= minuteAgo) entry.requests_last_minute += 1;
    // Только успешные постановки — ровно как в лимитере: отказ по кривым
    // параметрам суточную норму не тратит.
    if (row.action === 'create_job' && row.status_code < 300) entry.jobs_today += 1;
    entry.rows_today += Number(row.rows_returned ?? 0);
  }
  return usage;
}

/**
 * Расход одного ключа по дням. Дни без обращений возвращаются нулями — иначе
 * в истории были бы дыры, и «тихий день» не отличался бы от «данных нет».
 */
export async function loadBenchHistory(
  admin: SupabaseClient,
  keyId: string,
  days: number,
  now: Date = new Date(),
): Promise<BenchDayUsage[]> {
  const todayStart = new Date(mskDayStartUtc(now));
  const from = new Date(todayStart.getTime() - (days - 1) * DAY_MS);

  const { data } = await admin
    .from('bench_api_requests')
    .select('key_id, action, status_code, rows_returned, created_at')
    .eq('key_id', keyId)
    .gte('created_at', from.toISOString())
    .limit(MAX_JOURNAL_ROWS);

  const byDate = new Map<string, BenchDayUsage>();
  for (let i = 0; i < days; i += 1) {
    const date = mskDate(new Date(from.getTime() + i * DAY_MS).toISOString());
    byDate.set(date, { date, jobs: 0, rows: 0, requests: 0 });
  }

  for (const row of (data ?? []) as JournalRow[]) {
    const bucket = byDate.get(mskDate(row.created_at));
    if (!bucket) continue;
    bucket.requests += 1;
    if (row.action === 'create_job' && row.status_code < 300) bucket.jobs += 1;
    bucket.rows += Number(row.rows_returned ?? 0);
  }

  // Свежие дни сверху — так же, как в журнале обращений рядом.
  return [...byDate.values()].reverse();
}
