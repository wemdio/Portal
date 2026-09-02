/** @jest-environment node */

/**
 * Аудит 20.08.2026, две находки в стороже сирот (коммит 1d3c65097).
 *
 * 1. reclaimOrphanedStartJobs возвращал осиротевшую start-джобу в `pending`,
 *    не глядя на статус кампании. claimJob/handleStartJob статус не проверяют,
 *    а runCampaignLoop на входе безусловно пишет status='running' — то есть
 *    остановленная оператором кампания воскресала сама. Правильный путь:
 *    сирота закрывается, а решение о рестарте принимает resumeRunningCampaigns
 *    — он вызывается следующим в том же тике и уже статус-гейтед.
 *
 * 2. Фильтр action='start' оставлял warmup_start вне сторожа, хотя прогрев
 *    попадал ровно в ту же ловушку «старт уже запланирован», ради которой
 *    сторож и ставился. (С переездом прогрева на единый жизненный цикл задач
 *    команда warmup_start закрывается сразу и осиротеть не может, но из
 *    сторожа не выпадает — на случай команды от старого контейнера.)
 */

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: jest.fn() },
}));

jest.mock('@/lib/tgOutreach/campaignLoop', () => ({
  runCampaignLoop: jest.fn().mockResolvedValue(undefined),
  refetchEmptyDialogs: jest.fn().mockResolvedValue(undefined),
}));

import {
  reclaimOrphanedStartJobs,
  resetStuckJobs,
  resumeRunningCampaigns,
  claimJob,
  START_ACTIONS,
} from '../../../worker/tgOutreach';
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

describe('reclaimOrphanedStartJobs — сирота закрывается, а не возвращается в очередь', () => {
  it('переводит осиротевшую start-джобу в completed с причиной, а не в pending', async () => {
    const { updates } = makeDb({
      campaigns: [{ id: 'camp-1', status: 'running' }],
      jobs: [orphanStart()],
    });

    await reclaimOrphanedStartJobs();

    const upd = updates.find((u) => u.table === 'tg_outreach_jobs');
    expect(upd).toBeDefined();
    expect(upd!.data.status).toBe('completed');
    expect(String(upd!.data.error_message)).toContain('Осиротевш');
  });

  it('закрывает с защитой от гонки: только если джоба всё ещё running', async () => {
    // .finally() живого цикла помечает джобу completed параллельно с тиком
    // сторожа. Без eq('status','running') сторож мог бы воскресить закрытую.
    const { updates } = makeDb({ jobs: [orphanStart()] });

    await reclaimOrphanedStartJobs();

    const upd = updates.find((u) => u.table === 'tg_outreach_jobs');
    expect(upd!.filters.status).toBe('running');
  });

  it('подхватывает и осиротевший warmup_start — у прогрева та же ловушка', async () => {
    const { updates } = makeDb({
      jobs: [orphanStart({ id: 'job-w1', campaign_id: 'camp-w', action: 'warmup_start' })],
    });

    await reclaimOrphanedStartJobs();

    // warmup_start-сирота тоже должна закрываться — иначе resumeWarmupRuns
    // вечно видит активную джобу и делает continue.
    const upd = updates.find((u) => u.table === 'tg_outreach_jobs');
    expect(upd).toBeDefined();
    expect(upd!.data.status).toBe('completed');
  });
});

describe('сторож + авто-резюм: статус кампании решает, воскресать ли её', () => {
  it('положительный контроль: pending start-джобу воркер действительно забирает', async () => {
    // Без этого теста проверки «claimJob вернул null» ничего не доказывают:
    // null мог бы приходить из-за немощи двойника, а не из-за отсутствия джобы.
    makeDb({
      campaigns: [{ id: 'camp-1', status: 'running' }],
      jobs: [orphanStart({ status: 'pending', started_at: null })],
    });

    expect(await claimJob(START_ACTIONS)).toMatchObject({ campaign_id: 'camp-1', action: 'start' });
  });

  it('остановленная кампания НЕ воскресает: закрытую сироту некому подхватить', async () => {
    makeDb({
      campaigns: [{ id: 'camp-1', status: 'stopped' }],
      jobs: [orphanStart()],
    });

    await reclaimOrphanedStartJobs();
    // Ровно то, что происходило до фикса: сирота в pending, claimJob её
    // забирает, handleStartJob запускает цикл — кампания жива против воли
    // оператора.
    const claimed = await claimJob(START_ACTIONS);

    expect(claimed).toBeNull();
  });

  it('running-кампания восстанавливается: авто-резюм ставит новую джобу после закрытия сироты', async () => {
    const { inserts } = makeDb({
      campaigns: [{ id: 'camp-1', status: 'running', user_id: 'user-1' }],
      jobs: [orphanStart()],
    });

    await reclaimOrphanedStartJobs();
    await resumeRunningCampaigns();

    expect(inserts).toHaveLength(1);
    expect(inserts[0].data).toMatchObject({ campaign_id: 'camp-1', action: 'start', status: 'pending' });
  });

  it('на старте процесса остановленная кампания тоже не воскресает', async () => {
    // resetStuckJobs — второй путь к той же беде: он поднимал ВСЕ зависшие
    // джобы в pending, включая start остановленной кампании. Периодический
    // сторож без этого чинил только половину сценария: достаточно перезапуска
    // воркера, и кампания оживала против воли оператора.
    makeDb({
      campaigns: [{ id: 'camp-1', status: 'stopped' }],
      jobs: [orphanStart()],
    });

    await resetStuckJobs();
    await resumeRunningCampaigns();

    expect(await claimJob(START_ACTIONS)).toBeNull();
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

  it('на старте зависшая start-джоба running-кампании закрывается, и авто-резюм ставит свежую', async () => {
    const { inserts } = makeDb({
      campaigns: [{ id: 'camp-1', status: 'running', user_id: 'user-1' }],
      jobs: [orphanStart()],
    });

    await resetStuckJobs();
    await resumeRunningCampaigns();

    expect(inserts).toHaveLength(1);
    expect(inserts[0].data).toMatchObject({ campaign_id: 'camp-1', action: 'start', status: 'pending' });
  });

  // Проверка «resumeWarmupRuns ставит новую warmup_start после закрытия сироты»
  // удалена вместе с самой функцией: прогрев переехал на единый жизненный цикл
  // задач, и брошенный прогон определяется истёкшей арендой, а не отсутствием
  // активной команды. Она закрепляла снятый механизм.
});
