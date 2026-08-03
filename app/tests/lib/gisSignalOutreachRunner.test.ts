/** @jest-environment node */

jest.mock('server-only', () => ({}));

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { SegmentCandidate } from '@/lib/gisSignalOutreach/segments';
import type { OutreachSignalsResult } from '@/lib/gisSignalOutreach/signals';
import { SIGNAL_COLUMNS } from '@/lib/gisSignalOutreach/signals';
import { GRID_HEADER } from '@/lib/gisSignalOutreach/gridMapping';

let mockDb: MockSupabaseClient = createMockSupabase();
let mockInstantlyDb: MockSupabaseClient = createMockSupabase();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return mockInstantlyDb;
  },
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

jest.mock('@/lib/gisSignalOutreach/segments', () => ({
  getLatestTwoGisSnapshotId: jest.fn(async () => 42),
  pullSegmentCandidates: jest.fn(),
}));

jest.mock('@/lib/gisSignalOutreach/signals', () => {
  const actual = jest.requireActual('@/lib/gisSignalOutreach/signals');
  return { ...actual, detectOutreachSignals: jest.fn() };
});

jest.mock('@/lib/clientLaunch/appendLeads', () => ({
  appendLeadsToClientCampaign: jest.fn(),
  fetchExistingCampaignEmails: jest.fn(async () => new Set<string>()),
}));

import { runGisSignalPipeline } from '@/lib/gisSignalOutreach/pipelineRunner';
import { pullSegmentCandidates } from '@/lib/gisSignalOutreach/segments';
import { detectOutreachSignals } from '@/lib/gisSignalOutreach/signals';
import {
  appendLeadsToClientCampaign,
  fetchExistingCampaignEmails,
} from '@/lib/clientLaunch/appendLeads';

const pullMock = pullSegmentCandidates as jest.Mock;
const detectMock = detectOutreachSignals as jest.Mock;
const appendMock = appendLeadsToClientCampaign as jest.Mock;
const existingEmailsMock = fetchExistingCampaignEmails as jest.Mock;

const USER_ID = '00000000-0000-4000-8000-000000000009';

function configRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    enabled: true,
    measure_only: false,
    client_user_id: USER_ID,
    monthly_target_companies: 3000,
    daily_limit: 100,
    signal_min_count: 1,
    selected_steps: ['validate_emails', 'find_emails'],
    step_config: {},
    job_poll_timeout_minutes: 180,
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function segmentRows() {
  return [
    {
      key: 'seg-a', label: 'Сегмент A', instantly_campaign_id: 'camp-a',
      rubric_groups: [{ category: 'Медицина' }], priority: 10, enabled: true,
    },
    {
      key: 'seg-b', label: 'Сегмент B (без кампании)', instantly_campaign_id: null,
      rubric_groups: [{ category: 'Образование' }], priority: 20, enabled: true,
    },
  ];
}

function cand(id: string, segmentKey: string): SegmentCandidate {
  return {
    twogisId: id,
    segmentKey,
    name: `Компания ${id}`,
    site: `https://${id}.ru`,
    phone: '+7 495 000-00-00',
    email: '',
    cityName: 'Москва',
    category: 'Медицина',
    subcategory: 'Стоматологии',
  };
}

function signalResult(hit: boolean): OutreachSignalsResult {
  const v = (h: boolean) => ({ hit: h, evidence: h ? 'какое-то evidence' : '' });
  return {
    signals: {
      generalPhone: v(hit),
      contactForm: v(false),
      salesDept: v(false),
      targetVacancy: v(false),
      highVolume: v(false),
      multiOffice: v(false),
    },
    signalsCount: hit ? 1 : 0,
    note: 'Homepage checked',
    ok: true,
  };
}

/** Финальная сетка конструктора: заголовок + 'Email Статус', строки по spec. */
function finalGrid(rows: Array<{ id: string; segment?: string; name: string; email: string }>): string[][] {
  const header = [...GRID_HEADER, 'Email Статус'];
  const signalCells = SIGNAL_COLUMNS.flatMap((_, i) =>
    i === 0 ? ['Да', 'какое-то evidence'] : ['Нет', 'Not found on checked pages'],
  );
  return [
    header,
    ...rows.map((r) => [
      r.id, r.name, 'Москва', '+7 495 000-00-00', r.email, `https://${r.id}.ru`,
      'Медицина', 'Стоматологии', ...signalCells, 'Homepage checked', 'ok',
    ]),
  ];
}

/**
 * Ждёт появления N-й (minJobs) job-строки в мок-БД и флипает её в completed с
 * финальной сеткой — эмулирует worker-baseconstructor. Раннер поллит раз в
 * pollIntervalMs=1. minJobs нужен тестам с несколькими прогонами подряд:
 * старые completed-job'ы остаются в таблице, целимся в N-ю по счёту.
 */
async function completeNextBaseJob(data: string[][], minJobs = 1): Promise<void> {
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
  throw new Error('base job was not created');
}

function seed(config: Record<string, unknown> = {}, blockedEmails: string[] = []) {
  mockDb = createMockSupabase({
    tables: {
      gis_signal_pipeline_config: [configRow(config)],
      gis_signal_segments: segmentRows(),
    },
  });
  mockInstantlyDb = createMockSupabase({
    tables: {
      client_blocked_contacts: blockedEmails.map((email) => ({
        client_user_id: USER_ID,
        email,
      })),
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  existingEmailsMock.mockResolvedValue(new Set<string>());
  // По умолчанию: сайт содержит 'a1' или 'b1' → 1 сигнал; иначе 0.
  detectMock.mockImplementation(async ({ siteUrl }: { siteUrl: string }) =>
    signalResult(/a1|b1/.test(siteUrl)),
  );
  appendMock.mockImplementation(async ({ leads }: { leads: unknown[] }) => ({
    accepted: leads.length,
    skipped: 0,
  }));
});

describe('runGisSignalPipeline — live режим', () => {
  it('полная воронка: append в кампании сегментов, seen только после append, funnel в run-строке', async () => {
    seed();
    pullMock.mockResolvedValue([cand('a1', 'seg-a'), cand('a2', 'seg-a'), cand('b1', 'seg-b')]);
    // a2 не проходит сигналы. У a1 две почты после split_emails; sales@ уже в
    // кампании → отфильтруется нашим дедупом.
    existingEmailsMock.mockResolvedValue(new Set(['sales@a1.ru']));

    const grid = finalGrid([
      { id: 'a1', name: 'Компания a1', email: 'info@a1.ru' },
      { id: 'a1', name: 'Компания a1', email: 'sales@a1.ru' },
      { id: 'b1', name: 'Компания b1', email: 'info@b1.ru' },
    ]);
    const runPromise = runGisSignalPipeline(() => {}, { pollIntervalMs: 1 });
    await completeNextBaseJob(grid);
    const result = await runPromise;

    expect(result.status).toBe('completed');
    expect(result.pulled).toBe(3);
    expect(result.signalsOk).toBe(2);

    // BC job: один, shape как у outreachos.
    const jobInsert = mockDb.inserts.find((c) => c.table === 'base_constructor_jobs');
    expect(jobInsert).toBeDefined();
    const jobRow = jobInsert!.rows[0];
    expect(jobRow.user_id).toBe(USER_ID);
    expect(String(jobRow.file_name)).toMatch(/^gis-signals-\d{4}-\d{2}-\d{2}$/);
    expect(jobRow.selected_steps).toEqual(['find_emails', 'validate_emails']); // отсортированы
    expect(jobRow.step_config).toEqual({ find_emails_target: 'same' });
    expect(jobRow.initial_row_count).toBe(2); // a1 + b1 (a2 отсеян сигналами)

    // Append: только seg-a (у seg-b нет кампании). Дедуп убрал sales@a1.ru.
    expect(appendMock).toHaveBeenCalledTimes(1);
    const appendArgs = appendMock.mock.calls[0][0];
    expect(appendArgs.userId).toBe(USER_ID);
    expect(appendArgs.campaignId).toBe('camp-a');
    expect(appendArgs.contextLabel).toBe('gis-signals');
    expect(appendArgs.skipIfInCampaign).toBe(false);
    expect(appendArgs.leads.map((l: { email: string }) => l.email)).toEqual(['info@a1.ru']);
    expect(appendArgs.leads[0].custom_variables.segment).toBe('seg-a');

    // seen: ТОЛЬКО a1 (залит ≥1 email). b1 НЕ помечен — его сегмент без кампании.
    const seenUpserts = mockDb.upserts.filter((c) => c.table === 'gis_signal_seen_companies');
    expect(seenUpserts).toHaveLength(1);
    expect(seenUpserts[0].rows).toEqual([
      { twogis_id: 'a1', domain: 'a1.ru', company_name: 'Компания a1', segment_key: 'seg-a' },
    ]);

    // Архив сигналов: все 3 проверенные компании (и pass, и fail) — upsert'ом
    // по twogis_id (повторная проверка карточки не должна падать на UNIQUE).
    const archiveUpserts = mockDb.upserts.filter((c) => c.table === 'gis_signal_company_signals');
    expect(archiveUpserts).toHaveLength(1);
    expect(archiveUpserts[0].onConflict).toBe('twogis_id');
    expect(archiveUpserts[0].rows).toHaveLength(3);
    const a2row = archiveUpserts[0].rows.find((r) => r.twogis_id === 'a2');
    expect(a2row).toMatchObject({ signals_count: 0, signal_general_phone: false, segment_key: 'seg-a' });

    // Run-строка: status completed (CHECK constraint миграции) + funnel jsonb.
    const runRow = mockDb.getRows('gis_signal_runs')[0];
    expect(runRow.status).toBe('completed');
    expect(runRow.finished_at).toBeTruthy();
    const funnel = runRow.funnel as {
      perSegment: Record<string, Record<string, number>>;
      total: Record<string, number>;
    };
    expect(funnel.perSegment['seg-a']).toEqual({
      pulled: 2, signalsOk: 1, bcIn: 1, validContacts: 2, appended: 1,
    });
    expect(funnel.perSegment['seg-b']).toEqual({
      pulled: 1, signalsOk: 1, bcIn: 1, validContacts: 1, appended: 0,
    });
    expect(funnel.total).toEqual({
      pulled: 3, signalsOk: 2, bcIn: 2, validContacts: 3, appended: 1,
    });
    expect(result.validContacts).toBe(3);
    expect(result.appended).toBe(1);
  });

  it('сбой append → seen НЕ пишется, run завершается со status=failed', async () => {
    seed();
    pullMock.mockResolvedValue([cand('a1', 'seg-a')]);
    appendMock.mockRejectedValue(new Error('Instantly 500'));

    const grid = finalGrid([{ id: 'a1', name: 'Компания a1', email: 'info@a1.ru' }]);
    const runPromise = runGisSignalPipeline(() => {}, { pollIntervalMs: 1 });
    await completeNextBaseJob(grid);
    const result = await runPromise;

    expect(result.status).toBe('failed');
    expect(result.error).toContain('seg-a');
    expect(mockDb.upserts.filter((c) => c.table === 'gis_signal_seen_companies')).toHaveLength(0);
    const runRow = mockDb.getRows('gis_signal_runs')[0];
    expect(runRow.status).toBe('failed');
    expect(String(runRow.error)).toContain('Instantly 500');
  });

  it('accepted=0 (все лиды ушли в skipped) → markSeen НЕ вызывается', async () => {
    seed();
    pullMock.mockResolvedValue([cand('a1', 'seg-a')]);
    appendMock.mockResolvedValue({ accepted: 0, skipped: 1 });

    const grid = finalGrid([{ id: 'a1', name: 'Компания a1', email: 'info@a1.ru' }]);
    const runPromise = runGisSignalPipeline(() => {}, { pollIntervalMs: 1 });
    await completeNextBaseJob(grid);
    const result = await runPromise;

    expect(result.status).toBe('completed');
    expect(result.appended).toBe(0);
    expect(mockDb.upserts.filter((c) => c.table === 'gis_signal_seen_companies')).toHaveLength(0);
    const runRow = mockDb.getRows('gis_signal_runs')[0];
    expect((runRow.funnel as { total: Record<string, number> }).total.appended).toBe(0);
  });

  it('accepted < sent → seen только компании первых accepted лидов (append режет префикс)', async () => {
    seed();
    pullMock.mockResolvedValue([cand('a1', 'seg-a'), cand('a3', 'seg-a')]);
    detectMock.mockImplementation(async () => signalResult(true));
    // append имитирует тарифный срез: из 2 лидов залит только ПЕРВЫЙ.
    appendMock.mockResolvedValue({ accepted: 1, skipped: 1 });

    const grid = finalGrid([
      { id: 'a1', name: 'Компания a1', email: 'info@a1.ru' },
      { id: 'a3', name: 'Компания a3', email: 'info@a3.ru' },
    ]);
    const runPromise = runGisSignalPipeline(() => {}, { pollIntervalMs: 1 });
    await completeNextBaseJob(grid);
    const result = await runPromise;

    expect(result.status).toBe('completed');
    const seenUpserts = mockDb.upserts.filter((c) => c.table === 'gis_signal_seen_companies');
    expect(seenUpserts).toHaveLength(1);
    // a3 НЕ сожжена: её лид не дошёл до Instantly, ретрай на следующем прогоне.
    expect(seenUpserts[0].rows.map((r) => r.twogis_id)).toEqual(['a1']);
  });

  it('блок-лист клиента: заблокированный email вырезается ДО append и не сжигает seen', async () => {
    seed({}, ['info@a3.ru']);
    pullMock.mockResolvedValue([cand('a1', 'seg-a'), cand('a3', 'seg-a')]);
    detectMock.mockImplementation(async () => signalResult(true));

    const grid = finalGrid([
      { id: 'a1', name: 'Компания a1', email: 'info@a1.ru' },
      { id: 'a3', name: 'Компания a3', email: 'info@a3.ru' },
    ]);
    const runPromise = runGisSignalPipeline(() => {}, { pollIntervalMs: 1 });
    await completeNextBaseJob(grid);
    const result = await runPromise;

    expect(result.status).toBe('completed');
    // Append получает только незаблокированных (тот же фильтр, что внутри appendLeads).
    const appendArgs = appendMock.mock.calls[0][0];
    expect(appendArgs.leads.map((l: { email: string }) => l.email)).toEqual(['info@a1.ru']);
    // accepted=1 (default mock) → seen только a1.
    const seenUpserts = mockDb.upserts.filter((c) => c.table === 'gis_signal_seen_companies');
    expect(seenUpserts.flatMap((c) => c.rows).map((r) => r.twogis_id)).toEqual(['a1']);
  });

  it('все лиды сегмента в блок-листе → append не вызывается, seen не пишется', async () => {
    seed({}, ['info@a1.ru']);
    pullMock.mockResolvedValue([cand('a1', 'seg-a')]);

    const grid = finalGrid([{ id: 'a1', name: 'Компания a1', email: 'info@a1.ru' }]);
    const runPromise = runGisSignalPipeline(() => {}, { pollIntervalMs: 1 });
    await completeNextBaseJob(grid);
    const result = await runPromise;

    expect(result.status).toBe('completed');
    expect(appendMock).not.toHaveBeenCalled();
    expect(mockDb.upserts.filter((c) => c.table === 'gis_signal_seen_companies')).toHaveLength(0);
  });
});

describe('runGisSignalPipeline — measure_only', () => {
  it('полная воронка без записей в Instantly и без seen', async () => {
    seed({ measure_only: true });
    pullMock.mockResolvedValue([cand('a1', 'seg-a'), cand('a2', 'seg-a'), cand('b1', 'seg-b')]);

    const grid = finalGrid([
      { id: 'a1', name: 'Компания a1', email: 'info@a1.ru' },
      { id: 'b1', name: 'Компания b1', email: 'info@b1.ru' },
    ]);
    const runPromise = runGisSignalPipeline(() => {}, { pollIntervalMs: 1 });
    await completeNextBaseJob(grid);
    const result = await runPromise;

    expect(result.status).toBe('completed');
    // Полная воронка замерена: кандидаты → сигналы → конструктор → valid.
    expect(mockDb.inserts.find((c) => c.table === 'base_constructor_jobs')).toBeDefined();
    expect(result.validContacts).toBe(2);
    // НО: никаких Instantly-записей и никакого seen.
    expect(appendMock).not.toHaveBeenCalled();
    expect(mockDb.upserts.filter((c) => c.table === 'gis_signal_seen_companies')).toHaveLength(0);
    // Архив сигналов при этом пишется — это и есть аналитический срез замера.
    const archiveUpserts = mockDb.upserts.filter((c) => c.table === 'gis_signal_company_signals');
    expect(archiveUpserts.flatMap((c) => c.rows)).toHaveLength(3);
    const runRow = mockDb.getRows('gis_signal_runs')[0];
    expect(runRow.status).toBe('completed');
    expect((runRow.funnel as { total: Record<string, number> }).total).toMatchObject({
      pulled: 3, signalsOk: 2, validContacts: 2, appended: 0,
    });
  });

  it('повторный замер той же карточки: архив обновляется апсертом, прогон не падает', async () => {
    seed({ measure_only: true });
    pullMock.mockResolvedValue([cand('a1', 'seg-a')]);
    detectMock.mockImplementation(async () => signalResult(true));

    const grid = finalGrid([{ id: 'a1', name: 'Компания a1', email: 'info@a1.ru' }]);
    let runPromise = runGisSignalPipeline(() => {}, { pollIntervalMs: 1 });
    await completeNextBaseJob(grid, 1);
    const first = await runPromise;
    expect(first.status).toBe('completed');

    // Второй замер той же карточки: generalPhone пропал, зато появилась форма
    // (сайт поменялся). Компания всё ещё qualified (1 сигнал) → BC job есть.
    detectMock.mockImplementation(async () => {
      const r = signalResult(false);
      r.signals.contactForm = { hit: true, evidence: 'форма заявки' };
      r.signalsCount = 1;
      return r;
    });
    runPromise = runGisSignalPipeline(() => {}, { pollIntervalMs: 1 });
    await completeNextBaseJob(grid, 2);
    const second = await runPromise;
    expect(second.status).toBe('completed');

    // Один twogis_id — одна строка, значения от ПОСЛЕДНЕЙ проверки.
    const rows = mockDb.getRows('gis_signal_company_signals').filter((r) => r.twogis_id === 'a1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      signal_general_phone: false,
      signal_contact_form: true,
      signals_count: 1,
      site: 'https://a1.ru',
      segment_key: 'seg-a',
    });
    expect(rows[0].checked_at).toBeTruthy();
    const archiveUpserts = mockDb.upserts.filter((c) => c.table === 'gis_signal_company_signals');
    expect(archiveUpserts).toHaveLength(2);
    for (const call of archiveUpserts) expect(call.onConflict).toBe('twogis_id');
  });
});

describe('runGisSignalPipeline — гарды', () => {
  it('enabled=false → skipped без run-строки и без записей', async () => {
    seed({ enabled: false });
    const result = await runGisSignalPipeline(() => {}, { pollIntervalMs: 1 });
    expect(result.status).toBe('skipped');
    expect(mockDb.getRows('gis_signal_runs')).toHaveLength(0);
    expect(pullMock).not.toHaveBeenCalled();
  });

  it('нет конфига → skipped no_config', async () => {
    mockDb = createMockSupabase({ tables: {} });
    const result = await runGisSignalPipeline(() => {}, { pollIntervalMs: 1 });
    expect(result.status).toBe('skipped');
    expect(result.error).toBe('no_config');
  });

  it('сбой детектора сигналов по компании не роняет прогон (fail-строка в архиве)', async () => {
    seed();
    pullMock.mockResolvedValue([cand('a1', 'seg-a'), cand('boom', 'seg-a')]);
    detectMock.mockImplementation(async ({ siteUrl }: { siteUrl: string }) => {
      if (siteUrl.includes('boom')) throw new Error('fetch exploded');
      return signalResult(true);
    });

    const grid = finalGrid([{ id: 'a1', name: 'Компания a1', email: 'info@a1.ru' }]);
    const runPromise = runGisSignalPipeline(() => {}, { pollIntervalMs: 1 });
    await completeNextBaseJob(grid);
    const result = await runPromise;

    expect(result.status).toBe('completed');
    const archiveRows = mockDb.upserts
      .filter((c) => c.table === 'gis_signal_company_signals')
      .flatMap((c) => c.rows);
    const boomRow = archiveRows.find((r) => r.twogis_id === 'boom');
    expect(boomRow).toMatchObject({ signals_count: 0 });
    expect(String(boomRow!.note)).toContain('Signal check failed');
    expect(result.signalsOk).toBe(1);
  });
});
