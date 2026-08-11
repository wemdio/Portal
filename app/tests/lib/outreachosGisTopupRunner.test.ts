/** @jest-environment node */

jest.mock('server-only', () => ({}));

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { HhEmployer } from '@/lib/jobs/hhAutoParser';
import type { TwoGisCard } from '@/lib/twoGis/types';
import type { CompanyForClassify } from '@/lib/outreachos/classifyCompanies';

let mockDb: MockSupabaseClient = createMockSupabase();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

jest.mock('@/lib/jobs/hhAutoParser', () => {
  const actual = jest.requireActual('@/lib/jobs/hhAutoParser');
  return { ...actual, findNewHhEmployers: jest.fn() };
});

jest.mock('@/lib/outreachos/superjobSource', () => ({
  fetchSuperjobEmployers: jest.fn(async () => []),
}));

jest.mock('@/lib/parsers/hhArchiveSink', () => ({
  getUserIdByEmail: jest.fn(async () => null),
  ensureArchiveSinkJob: jest.fn(async () => null),
  buildHhArchiveSinkCallback: jest.fn(() => async () => {}),
}));

jest.mock('@/lib/clientLaunch/appendLeads', () => ({
  appendLeadsToClientCampaign: jest.fn(),
  fetchExistingCampaignEmails: jest.fn(async () => new Set<string>()),
}));

// LLM-отсев под контролем теста: по умолчанию шума нет.
jest.mock('@/lib/outreachos/classifyCompanies', () => ({
  llmClassifyNoise: jest.fn(),
}));

// Поток карточек 2GIS под контролем теста.
let cardBatches: TwoGisCard[][] = [];
jest.mock('@/lib/twoGis/repository', () => ({
  iterateTwoGisCards: jest.fn(() => {
    return (async function* () {
      for (const batch of cardBatches) yield batch;
    })();
  }),
  getLatestTwoGisSnapshotId: jest.fn(async () => 7),
}));

// seenEmployers НЕ мокаем: markSeen/loadRecentlySeen идут через мок-БД —
// так проверяется партиционирование HH (upsert) / GIS (delete+insert).

import { runOutreachOsDailyPipeline } from '@/lib/outreachos/pipelineRunner';
import { findNewHhEmployers } from '@/lib/jobs/hhAutoParser';
import { llmClassifyNoise } from '@/lib/outreachos/classifyCompanies';
import { appendLeadsToClientCampaign } from '@/lib/clientLaunch/appendLeads';

const hhMock = findNewHhEmployers as jest.Mock;
const llmMock = llmClassifyNoise as jest.Mock;
const appendMock = appendLeadsToClientCampaign as jest.Mock;

const USER_ID = '00000000-0000-4000-8000-000000000009';

function employer(id: string, domain: string): HhEmployer {
  return {
    id,
    name: `HH Компания ${id}`,
    siteUrl: `https://${domain}`,
    hhUrl: `https://hh.ru/employer/${id}`,
    area: 'Москва',
    industries: ['Перевозки'],
    employeeCount: 50,
  } as HhEmployer;
}

function gisCard(id: string, domain: string): TwoGisCard {
  return {
    id,
    name: `Гис Компания ${id}`,
    city_name: 'Казань',
    geometry_name: '',
    post_code: '',
    phone: '',
    email: '',
    website: `https://${domain}`,
    vkontakte: '',
    instagram: '',
    lon: '',
    lat: '',
    category: 'Транспорт / Грузоперевозки',
    subcategory: 'Грузоперевозки',
  };
}

function configRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    enabled: true,
    measure_only: false,
    client_user_id: USER_ID,
    campaign_id: 'camp-a',
    campaign_id_b: 'camp-b',
    industries: [],
    area: '113',
    window_hours: 24,
    max_employees: null,
    daily_limit: 2000,
    selected_steps: ['validate_emails', 'find_emails'],
    extra_exclude: [],
    job_poll_timeout_minutes: 180,
    superjob_enabled: false,
    gis_topup_enabled: true,
    gis_topup_target_appended: 200,
    gis_topup_rubric_groups: [{ category: 'Транспорт / Грузоперевозки' }],
    gis_topup_daily_cap: 500,
    gis_topup_measure_only: false,
    ...overrides,
  };
}

/** Финальная сетка конструктора: заголовок + строки Компания/Сайт/Город/Email. */
function finalGrid(rows: Array<{ name: string; domain: string; email: string }>): string[][] {
  return [
    ['Компания', 'Сайт', 'Город', 'Email'],
    ...rows.map((r) => [r.name, `https://${r.domain}`, 'Москва', r.email]),
  ];
}

/** Флипает N-й base_constructor_job в completed с финальной сеткой (как worker). */
async function completeNextBaseJob(data: string[][], minJobs: number): Promise<void> {
  for (let i = 0; i < 5000; i++) {
    const jobs = mockDb.getRows('base_constructor_jobs');
    if (jobs.length >= minJobs) {
      await mockDb
        .from('base_constructor_jobs')
        .update({ status: 'completed', data })
        .eq('id', jobs[minJobs - 1].id as string);
      return;
    }
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`base_constructor_job #${minJobs} не появился в мок-БД`);
}

function seedBase(configOverrides: Record<string, unknown> = {}) {
  mockDb = createMockSupabase({
    tables: {
      outreachos_pipeline_config: [configRow(configOverrides)],
      outreachos_pipeline_runs: [],
      outreachos_suppression: [],
      outreachos_seen_employers: [
        {
          hh_employer_id: '9999',
          hh_employer_name: 'Старая',
          domain: 'outreachos-seen.ru',
          site_url: 'https://outreachos-seen.ru',
          status: 'appended',
          first_seen_at: new Date().toISOString(),
          last_status_at: new Date().toISOString(),
        },
      ],
      gis_signal_seen_companies: [
        {
          twogis_id: 'other-seg',
          domain: 'gis-signal-seen.ru',
          company_name: 'Из edu-сегмента',
          segment_key: 'edu',
        },
      ],
      base_constructor_jobs: [],
    },
  });

  hhMock.mockResolvedValue([employer('1001', 'hh1.ru'), employer('1002', 'hh2.ru')]);
  llmMock.mockImplementation(async (companies: CompanyForClassify[]) => ({
    noise: new Set<number>(),
    classified: companies.length,
    failedBatches: 0,
    refuted: 0,
    guardTripped: false,
  }));
  appendMock.mockImplementation(async ({ leads }: { leads: unknown[] }) => ({
    accepted: leads.length,
    skipped: 0,
  }));
  cardBatches = [[
    gisCard('g1', 'g1-trans.ru'),
    gisCard('g3', 'gis-signal-seen.ru'), // отсеивается: домен в gis_signal_seen_companies
    gisCard('g4', 'hh1.ru'),             // отсеивается: домен сегодняшнего HH-батча
    gisCard('g5', 'outreachos-seen.ru'), // отсеивается: seen-журнал OutreachOS (45д)
    gisCard('g2', 'g2-trans.ru'),
  ]];
}

const HH_GRID = finalGrid([
  { name: 'HH Компания 1001', domain: 'hh1.ru', email: 'info@hh1.ru' },
  { name: 'HH Компания 1002', domain: 'hh2.ru', email: 'info@hh2.ru' },
]);
const GIS_GRID = finalGrid([
  { name: 'Гис Компания g1', domain: 'g1-trans.ru', email: 'info@g1-trans.ru' },
  { name: 'Гис Компания g2', domain: 'g2-trans.ru', email: 'info@g2-trans.ru' },
]);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runOutreachOsDailyPipeline + 2GIS top-up', () => {
  it('live: GIS-лиды объединяются, seen пишется в оба журнала, счётчики — в run', async () => {
    seedBase();
    const job1 = completeNextBaseJob(HH_GRID, 1);
    const job2 = completeNextBaseJob(GIS_GRID, 2);

    const res = await runOutreachOsDailyPipeline(() => {}, { pollIntervalMs: 1 });
    await Promise.all([job1, job2]);

    expect(res.status).toBe('completed');
    expect(res.appended).toBe(4); // 2 HH + 2 GIS в общих кампаниях A/B
    expect(res.gisTopup).toEqual({
      pulled: 5,
      afterDedup: 2,
      validContacts: 2,
      llmKept: 2,
      appended: 2,
    });

    // Два конструктор-джоба: основной + gis-topup.
    const jobs = mockDb.getRows('base_constructor_jobs');
    expect(jobs).toHaveLength(2);
    expect(String(jobs[1].file_name)).toMatch(/outreachos-\d{4}-\d{2}-\d{2}-gis-topup/);

    // LLM вызван дважды: HH-компании и отдельно GIS-компании.
    expect(llmMock).toHaveBeenCalledTimes(2);
    const gisCompanies = llmMock.mock.calls[1][0] as CompanyForClassify[];
    expect(gisCompanies).toHaveLength(2);
    expect(gisCompanies[0].industries).toEqual(['Транспорт / Грузоперевозки', 'Грузоперевозки']);
    expect(gisCompanies[0].description).toBeUndefined();
    expect(gisCompanies[0].vacancyTitle).toBeUndefined();

    // outreachos_seen_employers: HH-строки upsert'ом, GIS-строки — insert с
    // hh_employer_id=null и статусом appended.
    const seenRows = mockDb.getRows('outreachos_seen_employers');
    const hhSeen = seenRows.filter((r) => r.hh_employer_id === '1001' || r.hh_employer_id === '1002');
    expect(hhSeen).toHaveLength(2);
    const gisSeen = seenRows.filter((r) => r.hh_employer_id === null);
    expect(gisSeen.map((r) => r.domain).sort()).toEqual(['g1-trans.ru', 'g2-trans.ru']);
    expect(gisSeen.every((r) => r.status === 'appended')).toBe(true);

    // gis_signal_seen_companies: только реально залитые GIS-компании, segment_key=null.
    const gisSignalUpserts = mockDb.upserts.filter((u) => u.table === 'gis_signal_seen_companies');
    expect(gisSignalUpserts).toHaveLength(1);
    expect(gisSignalUpserts[0].rows.map((r) => r.twogis_id).sort()).toEqual(['g1', 'g2']);
    expect(gisSignalUpserts[0].rows.every((r) => r.segment_key === null)).toBe(true);

    // Run-строка: счётчики top-up'а записаны.
    const runUpdate = mockDb.updates.find(
      (u) => u.table === 'outreachos_pipeline_runs' && u.patch.status === 'completed',
    );
    expect(runUpdate).toBeDefined();
    expect(runUpdate!.patch.gis_pulled).toBe(5);
    expect(runUpdate!.patch.gis_after_dedup).toBe(2);
    expect(runUpdate!.patch.gis_valid_contacts).toBe(2);
    expect(runUpdate!.patch.gis_llm_kept).toBe(2);
    expect(runUpdate!.patch.gis_appended).toBe(2);
  });

  it('gis_topup_measure_only=true: воронка меряется, заливки и seen по GIS нет', async () => {
    seedBase({ gis_topup_measure_only: true });
    const job1 = completeNextBaseJob(HH_GRID, 1);
    const job2 = completeNextBaseJob(GIS_GRID, 2);

    const res = await runOutreachOsDailyPipeline(() => {}, { pollIntervalMs: 1 });
    await Promise.all([job1, job2]);

    expect(res.status).toBe('completed');
    expect(res.appended).toBe(2); // только HH-лиды ушли в кампании
    expect(res.gisTopup).toEqual({
      pulled: 5,
      afterDedup: 2,
      validContacts: 2,
      llmKept: 2,
      appended: 0,
    });

    // Append-вызовы получили ТОЛЬКО HH-лиды.
    const appendedEmails = appendMock.mock.calls.flatMap(
      ([arg]) => (arg as { leads: { email: string }[] }).leads.map((l) => l.email),
    );
    expect(appendedEmails.sort()).toEqual(['info@hh1.ru', 'info@hh2.ru']);

    // GIS-компаний в seen-журналах нет.
    const seenRows = mockDb.getRows('outreachos_seen_employers');
    expect(seenRows.filter((r) => r.hh_employer_id === null)).toHaveLength(0);
    expect(mockDb.upserts.filter((u) => u.table === 'gis_signal_seen_companies')).toHaveLength(0);

    // Счётчики тем не менее записаны (замер).
    const runUpdate = mockDb.updates.find(
      (u) => u.table === 'outreachos_pipeline_runs' && u.patch.status === 'completed',
    );
    expect(runUpdate!.patch.gis_pulled).toBe(5);
    expect(runUpdate!.patch.gis_llm_kept).toBe(2);
    expect(runUpdate!.patch.gis_appended).toBe(0);
  });

  it('gis_topup_enabled=false: топ-ап не запускается (один джоб, без gis-счётчиков)', async () => {
    seedBase({ gis_topup_enabled: false });
    const job1 = completeNextBaseJob(HH_GRID, 1);
    const { iterateTwoGisCards } = jest.requireMock('@/lib/twoGis/repository') as {
      iterateTwoGisCards: jest.Mock;
    };

    const res = await runOutreachOsDailyPipeline(() => {}, { pollIntervalMs: 1 });
    await job1;

    expect(res.status).toBe('completed');
    expect(res.appended).toBe(2);
    expect(res.gisTopup).toBeUndefined();
    expect(mockDb.getRows('base_constructor_jobs')).toHaveLength(1);
    expect(iterateTwoGisCards).not.toHaveBeenCalled();

    const runUpdate = mockDb.updates.find(
      (u) => u.table === 'outreachos_pipeline_runs' && u.patch.status === 'completed',
    );
    expect(runUpdate).toBeDefined();
    expect(runUpdate!.patch).not.toHaveProperty('gis_pulled');
  });

  it('дефицита нет (kept >= target): топ-ап пропускается', async () => {
    seedBase({ gis_topup_target_appended: 2 });
    const job1 = completeNextBaseJob(HH_GRID, 1);
    const { iterateTwoGisCards } = jest.requireMock('@/lib/twoGis/repository') as {
      iterateTwoGisCards: jest.Mock;
    };

    const res = await runOutreachOsDailyPipeline(() => {}, { pollIntervalMs: 1 });
    await job1;

    expect(res.status).toBe('completed');
    expect(res.gisTopup).toBeUndefined();
    expect(iterateTwoGisCards).not.toHaveBeenCalled();
  });
});
