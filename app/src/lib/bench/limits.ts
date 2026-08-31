import type { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { BenchKeyRow } from './auth';
import { benchError } from './errors';

export type BenchAction = 'read' | 'create_job' | 'results' | 'stop' | 'search';

/**
 * Начало текущих МСК-суток в UTC. Сутки считаем по московскому дню — иначе
 * норма обнулялась бы в три часа ночи по Москве, посреди рабочей ночи
 * ночных парсеров.
 */
function mskDayStartUtc(now: Date): string {
  const msk = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const start = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate());
  return new Date(start - 3 * 60 * 60 * 1000).toISOString();
}

function withRetryAfter(response: NextResponse, seconds: number): NextResponse {
  response.headers.set('Retry-After', String(seconds));
  return response;
}

/**
 * Потолки считаются по журналу обращений — одинаково для любого инструмента,
 * без похода в пятнадцать разных таблиц задач.
 */
export async function checkBenchLimits(
  key: BenchKeyRow,
  action: BenchAction,
  now: Date = new Date(),
): Promise<NextResponse | null> {
  if (!supabaseAdmin) return null;

  const minuteAgo = new Date(now.getTime() - 60_000).toISOString();
  const { count: lastMinute } = await supabaseAdmin
    .from('bench_api_requests')
    .select('id', { count: 'exact', head: true })
    .eq('key_id', key.id)
    .gte('created_at', minuteAgo);

  if ((lastMinute ?? 0) >= key.rpm_limit) {
    return withRetryAfter(
      benchError('rate_limited', `Не больше ${key.rpm_limit} запросов в минуту`, {
        limit: key.rpm_limit,
        retry_after_seconds: 60,
      }),
      60,
    );
  }

  const dayStart = mskDayStartUtc(now);

  if (action === 'create_job') {
    // Считаем только успешные постановки: отказ по кривым параметрам не
    // должен съедать суточную норму, иначе отладка чужого скрипта выжигает
    // её за десять минут и человек приходит к нам разбираться.
    const { count: createdToday } = await supabaseAdmin
      .from('bench_api_requests')
      .select('id', { count: 'exact', head: true })
      .eq('key_id', key.id)
      .eq('action', 'create_job')
      .lt('status_code', 300)
      .gte('created_at', dayStart);

    if ((createdToday ?? 0) >= key.daily_jobs_limit) {
      return benchError(
        'quota_exceeded',
        `Исчерпана суточная норма: ${key.daily_jobs_limit} задач`,
        { limit: key.daily_jobs_limit, resets_at: dayStart },
      );
    }
  }

  if (action === 'results' || action === 'search') {
    // Норма строк общая для выгрузки результатов и поиска: и то и другое
    // выносит данные наружу, и делить их значило бы удвоить потолок.
    const { data } = await supabaseAdmin
      .from('bench_api_requests')
      .select('rows_returned')
      .eq('key_id', key.id)
      .gte('created_at', dayStart);

    const rowsToday = ((data ?? []) as Array<{ rows_returned?: number }>).reduce(
      (sum, row) => sum + Number(row.rows_returned ?? 0),
      0,
    );
    if (rowsToday >= key.daily_rows_limit) {
      return benchError(
        'quota_exceeded',
        `Исчерпана суточная норма: ${key.daily_rows_limit} строк`,
        { limit: key.daily_rows_limit, resets_at: dayStart },
      );
    }
  }

  return null;
}

interface CountableQuery {
  select: (columns: string, opts: { count: 'exact'; head: true }) => CountableQuery;
  in: (column: string, values: string[]) => Promise<{ count: number | null }>;
}

/**
 * Потолок одновременных задач.
 *
 * Параллельность обработки у воркеров общая на всех: если робот поставит
 * десяток задач разом, он отодвинет в очереди живых сотрудников. Считается
 * по таблице самого инструмента через клиент робота — то есть видит только
 * его собственные задачи, чужие в счёт не идут.
 */
export async function checkActiveJobs(
  db: { from: (table: string) => unknown },
  key: BenchKeyRow,
  table: string,
  activeStatuses: string[],
): Promise<NextResponse | null> {
  const query = db.from(table) as CountableQuery;
  const { count } = await query.select('id', { count: 'exact', head: true }).in('status', activeStatuses);

  if ((count ?? 0) >= key.max_active_jobs) {
    return benchError(
      'conflict',
      `Не больше ${key.max_active_jobs} незавершённых задач одновременно`,
      { limit: key.max_active_jobs },
    );
  }
  return null;
}
