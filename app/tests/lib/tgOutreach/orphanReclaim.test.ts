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
 * 2. Фильтр action='start' оставлял warmup_start вне сторожа, хотя
 *    resumeWarmupRuns при виде активной джобы делает `continue` — прогрев
 *    попадает ровно в ту же ловушку «старт уже запланирован», ради которой
 *    сторож и ставился.
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
  resumeRunningCampaigns,
  resumeWarmupRuns,
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

    const applyFilters = (list: Array<Record<string, unknown>>) =>
      list.filter((row) =>
        Object.entries(filters).every(([col, val]) =>
          Array.isArray(val) ? val.includes(row[col]) : row[col] === val,
        ),
      );

    // Update доезжает до строк только когда цепочку дождались — как в жизни.
    const finalize = () => {
      if (!pendingUpdate) return;
      for (const row of applyFilters(tableRows(table))) Object.assign(row, pendingUpdate.data);
      pendingUpdate = null;
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
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
        finalize();
        resolve({ data: applyFilters(tableRows(table)), error: null });
      },
      maybeSingle: async () => {
        finalize();
        return { data: applyFilters(tableRows(table))[0] ?? null, error: null };
      },
      single: async () => {
        finalize();
        return { data: applyFilters(tableRows(table))[0] ?? null, error: null };
      },
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

  it('прогрев восстанавливается: resumeWarmupRuns ставит новую warmup_start после закрытия сироты', async () => {
    const { inserts } = makeDb({
      campaigns: [{ id: 'camp-w', status: 'stopped', user_id: 'user-1' }],
      jobs: [orphanStart({ id: 'job-w1', campaign_id: 'camp-w', action: 'warmup_start' })],
      warmupRuns: [{ id: 'run-1', campaign_id: 'camp-w', status: 'running' }],
    });

    await reclaimOrphanedStartJobs();
    await resumeWarmupRuns();

    expect(inserts).toHaveLength(1);
    expect(inserts[0].data).toMatchObject({ campaign_id: 'camp-w', action: 'warmup_start', status: 'pending' });
  });
});
