/** @jest-environment node */

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadBenchHistory, loadBenchUsage } from '@/lib/bench/usage';

// 12:00 МСК первого сентября: московские сутки начались в 21:00 UTC 31 августа.
const NOW = new Date('2026-09-01T09:00:00Z');

function req(over: Record<string, unknown>) {
  return {
    key_id: 'k1',
    action: 'results',
    status_code: 200,
    rows_returned: 0,
    created_at: '2026-09-01T05:00:00Z',
    ...over,
  };
}

function db(rows: Array<Record<string, unknown>>): SupabaseClient {
  return createMockSupabase({
    tables: { bench_api_requests: rows },
  }) as unknown as SupabaseClient;
}

describe('расход за сегодня', () => {
  it('считает запросы за последнюю минуту', async () => {
    const usage = await loadBenchUsage(
      db([
        req({ created_at: '2026-09-01T08:59:40Z' }),
        req({ created_at: '2026-09-01T08:59:50Z' }),
        req({ created_at: '2026-09-01T08:00:00Z' }),
      ]),
      NOW,
    );
    expect(usage.k1.requests_last_minute).toBe(2);
  });

  it('в задачи считает только успешные постановки', async () => {
    // Ровно как лимитер: отказ по кривым параметрам норму не тратит, иначе
    // отладка скрипта выжигала бы её за десять минут.
    const usage = await loadBenchUsage(
      db([
        req({ action: 'create_job', status_code: 200 }),
        req({ action: 'create_job', status_code: 400 }),
        req({ action: 'create_job', status_code: 500 }),
      ]),
      NOW,
    );
    expect(usage.k1.jobs_today).toBe(1);
  });

  it('суммирует строки со всех обращений', async () => {
    const usage = await loadBenchUsage(
      db([
        req({ action: 'results', rows_returned: 500 }),
        req({ action: 'search', rows_returned: 200 }),
      ]),
      NOW,
    );
    expect(usage.k1.rows_today).toBe(700);
  });

  it('считает ключи по отдельности', async () => {
    const usage = await loadBenchUsage(
      db([req({ rows_returned: 10 }), req({ key_id: 'k2', rows_returned: 40 })]),
      NOW,
    );
    expect(usage.k1.rows_today).toBe(10);
    expect(usage.k2.rows_today).toBe(40);
  });

  it('ключ без обращений просто отсутствует в ответе', async () => {
    const usage = await loadBenchUsage(db([]), NOW);
    expect(usage.k1).toBeUndefined();
  });
});

describe('история по дням', () => {
  it('возвращает запрошенное число дней, свежие сверху', async () => {
    const days = await loadBenchHistory(db([]), 'k1', 10, NOW);
    expect(days).toHaveLength(10);
    expect(days[0].date).toBe('2026-09-01');
    expect(days[9].date).toBe('2026-08-23');
  });

  it('тихий день отдаётся нулями, а не пропускается', async () => {
    // Дыра в истории неотличима от «данных нет» — а это разные вещи.
    const days = await loadBenchHistory(db([req({ rows_returned: 5 })]), 'k1', 3, NOW);
    expect(days.map((d) => d.rows)).toEqual([5, 0, 0]);
  });

  it('раскладывает обращения по московским суткам', async () => {
    // 20:30 UTC 31 августа — это ещё 31-е по Москве (23:30).
    // 21:30 UTC 31 августа — уже 1 сентября (00:30).
    const days = await loadBenchHistory(
      db([
        req({ created_at: '2026-08-31T20:30:00Z', rows_returned: 1 }),
        req({ created_at: '2026-08-31T21:30:00Z', rows_returned: 10 }),
      ]),
      'k1',
      3,
      NOW,
    );
    const byDate = Object.fromEntries(days.map((d) => [d.date, d.rows]));
    expect(byDate['2026-08-31']).toBe(1);
    expect(byDate['2026-09-01']).toBe(10);
  });

  it('чужие обращения в историю ключа не попадают', async () => {
    const days = await loadBenchHistory(
      db([req({ rows_returned: 7 }), req({ key_id: 'k2', rows_returned: 999 })]),
      'k1',
      3,
      NOW,
    );
    expect(days.reduce((sum, d) => sum + d.rows, 0)).toBe(7);
  });
});
