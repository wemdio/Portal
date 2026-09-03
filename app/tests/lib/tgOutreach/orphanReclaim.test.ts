/** @jest-environment node */

/**
 * Что осталось от сторожа сирот и авто-резюма: НИЧЕГО, и это проверяется.
 *
 * Оба механизма сняты вместе с переездом кампаний на единый жизненный цикл
 * задач (app/src/lib/jobs/lifecycle.ts): команда «старт» больше не висит в
 * статусе «выполняется» всё время жизни кампании — она закрывается тем же
 * запросом, который её взял, — а брошенную кампанию определяет истёкшая
 * аренда, одинаково при любом числе реплик. Проверки, закреплявшие снятые
 * механизмы (сторож сирот, авто-резюм, воскрешение остановленной кампании
 * через них), удалены вместе с ними.
 *
 * Здесь остались две, которые проверяют живой код: сброс зависших команд при
 * старте процесса и захват команды из очереди.
 */

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: jest.fn() },
}));

jest.mock('@/lib/tgOutreach/campaignLoop', () => ({
  runCampaignLoop: jest.fn().mockResolvedValue(undefined),
  refetchEmptyDialogs: jest.fn().mockResolvedValue(undefined),
}));

import { resetStuckJobs, claimJob, START_ACTIONS } from '../../../worker/tgOutreach';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

type JobRow = {
  id: string;
  campaign_id: string;
  action: string;
  status: string;
  started_at: string | null;
  user_id?: string;
};
type CampaignRow = { id: string; status: string; user_id?: string };
type WarmupRunRow = { id: string; campaign_id: string; status: string };

const OLD = new Date(Date.now() - 60 * 60_000).toISOString();

/**
 * Поддельный Supabase честнее, чем в workerResumeCampaigns.test.ts: применяет
 * eq/in-фильтры к строкам и материализует update в строках — иначе цепочку
 * «сторож → авто-резюм → claimJob» через состояние базы не проверить.
 *
 * Отдельно важны две вещи, на которых прошлые двойники давали ложную зелень:
 *  - список колонок в select() соблюдается. Иначе код, забывший запросить
 *    нужную колонку, в тесте работает, а в проде получает undefined — ровно так
 *    прошёл незамеченным баг с `attempts` в TG-инциденте 18.08;
 *  - update возвращает строки ПОСЛЕ записи, а фильтр применяется к состоянию
 *    ДО неё, как в PostgREST. Иначе claimJob не смог бы вернуть захваченную
 *    джобу, и проверки «ничего не захватилось» проходили бы по ложной причине.
 */
function makeDb(rows: { campaigns?: CampaignRow[]; jobs?: JobRow[]; warmupRuns?: WarmupRunRow[] }) {
  const inserts: Array<{ table: string; data: unknown }> = [];
  const updates: Array<{ table: string; data: Record<string, unknown>; filters: Record<string, unknown> }> = [];

  const tableRows = (table: string): Array<Record<string, unknown>> => {
    if (table === 'tg_outreach_campaigns') return (rows.campaigns ?? []) as never;
    if (table === 'tg_outreach_jobs') return (rows.jobs ?? []) as never;
    if (table === 'tg_outreach_warmup_runs') return (rows.warmupRuns ?? []) as never;
    return [];
  };

  const from = jest.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    let pendingUpdate: { data: Record<string, unknown> } | null = null;
    let affected: Array<Record<string, unknown>> | null = null;
    let columns: string[] | null = null;

    const applyFilters = (list: Array<Record<string, unknown>>) =>
      list.filter((row) =>
        Object.entries(filters).every(([col, val]) =>
          Array.isArray(val) ? val.includes(row[col]) : row[col] === val,
        ),
      );

    const project = (list: Array<Record<string, unknown>>) => {
      if (!columns) return list;
      return list.map((row) => Object.fromEntries(columns!.map((c) => [c, row[c]])));
    };

    // Update доезжает до строк только когда цепочку дождались — как в жизни.
    const finalize = () => {
      if (!pendingUpdate) return;
      const matched = applyFilters(tableRows(table));
      for (const row of matched) Object.assign(row, pendingUpdate.data);
      affected = matched;
      pendingUpdate = null;
    };

    const rowsOut = () => {
      finalize();
      return project(affected ?? applyFilters(tableRows(table)));
    };

    const builder: Record<string, unknown> = {
      select: (cols?: string) => {
        if (cols && cols !== '*') columns = cols.split(',').map((c) => c.trim());
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return builder;
      },
      in: (col: string, val: unknown[]) => {
        filters[col] = val;
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      update: (data: Record<string, unknown>) => {
        pendingUpdate = { data };
        updates.push({ table, data, filters });
        return builder;
      },
      insert: (data: unknown) => {
        inserts.push({ table, data });
        return builder;
      },
      then: (resolve: (v: unknown) => void) => {
        resolve({ data: rowsOut(), error: null });
      },
      maybeSingle: async () => ({ data: rowsOut()[0] ?? null, error: null }),
      single: async () => ({ data: rowsOut()[0] ?? null, error: null }),
    };
    return builder;
  });

  (supabaseAdmin!.from as jest.Mock).mockImplementation(from);
  return { from, inserts, updates };
}

const orphanStart = (over: Partial<JobRow> = {}): JobRow => ({
  id: 'job-1',
  campaign_id: 'camp-1',
  action: 'start',
  status: 'running',
  started_at: OLD,
  ...over,
});

describe('очередь команд: что осталось после переезда на аренду', () => {
  it('положительный контроль: pending start-джобу воркер действительно забирает', async () => {
    // Команда «старт» ничего не запускает, но должна корректно браться из
    // очереди: на ней просыпается опрос, и без этого запуск кампании ждал бы
    // запасного тика.
    makeDb({
      campaigns: [{ id: 'camp-1', status: 'running' }],
      jobs: [orphanStart({ status: 'pending', started_at: null })],
    });

    expect(await claimJob(START_ACTIONS)).toMatchObject({ campaign_id: 'camp-1', action: 'start' });
  });

  it('на старте зависшая control-джоба возвращается в очередь: воля оператора не теряется', async () => {
    // Стоп/рестарт — прямое действие человека. Его нельзя закрывать молча:
    // иначе оператор нажал «Стоп» перед падением процесса, а кампания поехала.
    const { updates } = makeDb({
      campaigns: [{ id: 'camp-1', status: 'running' }],
      jobs: [orphanStart({ id: 'job-stop', action: 'stop' })],
    });

    await resetStuckJobs();

    const upd = updates.find((u) => u.table === 'tg_outreach_jobs');
    expect(upd!.data.status).toBe('pending');
  });
});
