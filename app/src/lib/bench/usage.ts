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

/** Расход за сутки по одному инструменту. */
export interface BenchToolDayUsage {
  /** id инструмента; null — обращения без инструмента (список, статус ключа). */
  tool: string | null;
  requests: number;
  jobs: number;
  rows: number;
  /** Отказы по лимиту (429). */
  limited: number;
  /** Прочие ошибки: 4xx кроме 429 и 5xx. */
  errors: number;
}

export interface BenchDayUsage {
  /** Календарная дата по Москве, YYYY-MM-DD. */
  date: string;
  jobs: number;
  rows: number;
  requests: number;
  /**
   * Больше всего запросов за одну календарную минуту этих суток — то же, что
   * «в минуту» за сегодня, только задним числом: видно, подходил ли ключ к
   * потолку rpm в прошлые дни.
   */
  peak_per_minute: number;
  limited: number;
  errors: number;
  /** Разбивка по инструментам, самые расходные сверху. */
  tools: BenchToolDayUsage[];
}

interface JournalRow {
  key_id: string;
  tool?: string | null;
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
    .select('key_id, tool, action, status_code, rows_returned, created_at')
    .eq('key_id', keyId)
    .gte('created_at', from.toISOString())
    .limit(MAX_JOURNAL_ROWS);

  const byDate = new Map<string, BenchDayUsage>();
  for (let i = 0; i < days; i += 1) {
    const date = mskDate(new Date(from.getTime() + i * DAY_MS).toISOString());
    byDate.set(date, {
      date, jobs: 0, rows: 0, requests: 0, peak_per_minute: 0, limited: 0, errors: 0, tools: [],
    });
  }

  const perMinute = new Map<string, number>();
  const toolsByDate = new Map<string, Map<string, BenchToolDayUsage>>();
  for (const row of (data ?? []) as JournalRow[]) {
    const date = mskDate(row.created_at);
    const bucket = byDate.get(date);
    if (!bucket) continue;

    const job = row.action === 'create_job' && row.status_code < 300;
    const rows = Number(row.rows_returned ?? 0);
    const limited = row.status_code === 429;
    const failed = row.status_code >= 400 && !limited;

    bucket.requests += 1;
    if (job) bucket.jobs += 1;
    bucket.rows += rows;
    if (limited) bucket.limited += 1;
    if (failed) bucket.errors += 1;

    const minute = row.created_at.slice(0, 16);
    const inMinute = (perMinute.get(minute) ?? 0) + 1;
    perMinute.set(minute, inMinute);
    if (inMinute > bucket.peak_per_minute) bucket.peak_per_minute = inMinute;

    const tools = toolsByDate.get(date) ?? new Map<string, BenchToolDayUsage>();
    toolsByDate.set(date, tools);
    const toolKey = row.tool ?? '';
    const tool = tools.get(toolKey) ?? { tool: row.tool ?? null, requests: 0, jobs: 0, rows: 0, limited: 0, errors: 0 };
    tools.set(toolKey, tool);
    tool.requests += 1;
    if (job) tool.jobs += 1;
    tool.rows += rows;
    if (limited) tool.limited += 1;
    if (failed) tool.errors += 1;
  }

  for (const [date, tools] of toolsByDate) {
    const bucket = byDate.get(date);
    if (!bucket) continue;
    bucket.tools = [...tools.values()].sort((a, b) => b.rows - a.rows || b.requests - a.requests);
  }

  // Свежие дни сверху — так же, как в журнале обращений рядом.
  return [...byDate.values()].reverse();
}
