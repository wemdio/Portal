/** @jest-environment node */

jest.mock('server-only', () => ({}));

import { createMockSupabase, type MockSupabaseClient, type Row } from '@/../tests/helpers/mockSupabase';
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

jest.mock('@/lib/telegram/workerAlert', () => ({
  sendWorkerAlert: jest.fn(async () => {}),
}));

import { runGisSignalPipeline } from '@/lib/gisSignalOutreach/pipelineRunner';
import { pullSegmentCandidates } from '@/lib/gisSignalOutreach/segments';
import { detectOutreachSignals } from '@/lib/gisSignalOutreach/signals';
import {
  appendLeadsToClientCampaign,
  fetchExistingCampaignEmails,
} from '@/lib/clientLaunch/appendLeads';
import { sendWorkerAlert } from '@/lib/telegram/workerAlert';
import {
  createStallWatchdog,
  guardAgainstConcurrentRun,
  partitionRunningRuns,
  STALE_RUNNING_THRESHOLD_MS,
  type GisSignalAdminDb,
} from '@/lib/gisSignalOutreach/runGuards';

const pullMock = pullSegmentCandidates as jest.Mock;
const detectMock = detectOutreachSignals as jest.Mock;
const appendMock = appendLeadsToClientCampaign as jest.Mock;
const existingEmailsMock = fetchExistingCampaignEmails as jest.Mock;
const alertMock = sendWorkerAlert as jest.Mock;

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
      legalRelevance: v(false),
      crmCalltracking: v(false),
    },
    signalsCount: hit ? 1 : 0,
    note: 'Homepage checked',
    ok: true,
  };
}

/** Финальная сетка конструктора: заголовок + 'Email Статус', строки по spec. */
function finalGrid(
  rows: Array<{ id: string; segment?: string; name: string; email: string; score?: string; grade?: string }>,
): string[][] {
  const header = [...GRID_HEADER, 'Email Статус'];
  const signalCells = SIGNAL_COLUMNS.flatMap((_, i) =>
    i === 0 ? ['Да', 'какое-то evidence'] : ['Нет', 'Not found on checked pages'],
  );
  return [
    header,
    ...rows.map((r) => [
      r.id, r.name, 'Москва', '+7 495 000-00-00', r.email, `https://${r.id}.ru`,
      'Медицина', 'Стоматологии', ...signalCells, r.score ?? '', r.grade ?? '', 'Homepage checked', 'ok',
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

function seed(
  config: Record<string, unknown> = {},
  blockedEmails: string[] = [],
  segments: Array<Record<string, unknown>> = segmentRows(),
) {
  mockDb = createMockSupabase({
    tables: {
      gis_signal_pipeline_config: [configRow(config)],
      gis_signal_segments: segments,
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
    // Сегменты без require_online → onlineOk === signalsOk.
    expect(funnel.perSegment['seg-a']).toEqual({
      pulled: 2, signalsOk: 1, onlineOk: 1, bcIn: 1, validContacts: 2, appended: 1,
    });
    expect(funnel.perSegment['seg-b']).toEqual({
      pulled: 1, signalsOk: 1, onlineOk: 1, bcIn: 1, validContacts: 1, appended: 0,
    });
    expect(funnel.total).toEqual({
      pulled: 3, signalsOk: 2, onlineOk: 2, bcIn: 2, validContacts: 3, appended: 1,
    });
    expect(result.onlineOk).toBe(2);
    expect(result.validContacts).toBe(3);
    expect(result.appended).toBe(1);
    // Без require_online детектор зовётся без online-чека (лишних regex'ов нет).
    expect(detectMock.mock.calls[0][0].checkOnlineFormat).toBe(false);
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

describe('runGisSignalPipeline — require_online (edu)', () => {
  function eduSegmentRows() {
    return [
      {
        key: 'edu', label: 'Онлайн-школы', instantly_campaign_id: 'camp-edu',
        rubric_groups: [{ category: 'Дополнительное образование' }],
        priority: 10, enabled: true, require_online: true,
      },
    ];
  }

  it('офлайн-only компания архивируется (evidence.online_format), но в конструктор НЕ идёт; onlineOk в воронке', async () => {
    seed({}, [], eduSegmentRows());
    pullMock.mockResolvedValue([cand('on1', 'edu'), cand('off1', 'edu'), cand('ns1', 'edu')]);
    // on1: сигнал + онлайн; off1: сигнал, но офлайн; ns1: вообще без сигналов.
    detectMock.mockImplementation(async ({ siteUrl }: { siteUrl: string }) => {
      const r = signalResult(!siteUrl.includes('ns1'));
      r.onlineFormat = siteUrl.includes('on1')
        ? { hit: true, evidence: 'Онлайн-школа программирования' }
        : { hit: false, evidence: '' };
      return r;
    });

    const grid = finalGrid([{ id: 'on1', name: 'Компания on1', email: 'info@on1.ru' }]);
    const runPromise = runGisSignalPipeline(() => {}, { pollIntervalMs: 1 });
    await completeNextBaseJob(grid);
    const result = await runPromise;

    expect(result.status).toBe('completed');
    // Детектор вызван с checkOnlineFormat=true для всех кандидатов сегмента.
    for (const call of detectMock.mock.calls) {
      expect(call[0].checkOnlineFormat).toBe(true);
    }

    // В конструкторе — ТОЛЬКО on1 (off1 отсеяна online-гейтом, ns1 — сигналами).
    const jobInsert = mockDb.inserts.find((c) => c.table === 'base_constructor_jobs');
    const jobData = jobInsert!.rows[0].data as string[][];
    expect(jobData).toHaveLength(2); // header + on1
    expect(jobData[1][0]).toBe('on1');

    // Архив: все 3 проверенные; у off1/ns1 вердикт online_format=false.
    const archiveRows = mockDb.upserts
      .filter((c) => c.table === 'gis_signal_company_signals')
      .flatMap((c) => c.rows);
    expect(archiveRows).toHaveLength(3);
    const offRow = archiveRows.find((r) => r.twogis_id === 'off1');
    expect(offRow).toMatchObject({ signals_count: 1 }); // сигнал есть, онлайна нет
    expect((offRow!.evidence as Record<string, unknown>).online_format).toEqual({
      hit: false, evidence: '',
    });
    const onRow = archiveRows.find((r) => r.twogis_id === 'on1');
    expect((onRow!.evidence as Record<string, unknown>).online_format).toEqual({
      hit: true, evidence: 'Онлайн-школа программирования',
    });

    // Воронка: pulled 3 → signalsOk 2 → onlineOk 1 → bcIn 1 → valid 1 → appended 1.
    const runRow = mockDb.getRows('gis_signal_runs')[0];
    const funnel = runRow.funnel as {
      perSegment: Record<string, Record<string, number>>;
      total: Record<string, number>;
    };
    expect(funnel.perSegment['edu']).toEqual({
      pulled: 3, signalsOk: 2, onlineOk: 1, bcIn: 1, validContacts: 1, appended: 1,
    });
    expect(funnel.total).toEqual({
      pulled: 3, signalsOk: 2, onlineOk: 1, bcIn: 1, validContacts: 1, appended: 1,
    });
    expect(result.onlineOk).toBe(1);

    // seen — только on1 (единственная залитая).
    const seenUpserts = mockDb.upserts.filter((c) => c.table === 'gis_signal_seen_companies');
    expect(seenUpserts.flatMap((c) => c.rows).map((r) => r.twogis_id)).toEqual(['on1']);
  });

  it('require_online, но ни одна компания не онлайн → конструктор не создаётся, прогон completed', async () => {
    seed({}, [], eduSegmentRows());
    pullMock.mockResolvedValue([cand('off1', 'edu'), cand('off2', 'edu')]);
    detectMock.mockImplementation(async () => {
      const r = signalResult(true);
      r.onlineFormat = { hit: false, evidence: '' };
      return r;
    });

    const result = await runGisSignalPipeline(() => {}, { pollIntervalMs: 1 });

    expect(result.status).toBe('completed');
    expect(result.signalsOk).toBe(2);
    expect(result.onlineOk).toBe(0);
    expect(mockDb.inserts.filter((c) => c.table === 'base_constructor_jobs')).toHaveLength(0);
    expect(appendMock).not.toHaveBeenCalled();
    // Архив всё равно написан (аналитический срез).
    const archiveRows = mockDb.upserts
      .filter((c) => c.table === 'gis_signal_company_signals')
      .flatMap((c) => c.rows);
    expect(archiveRows).toHaveLength(2);
    const runRow = mockDb.getRows('gis_signal_runs')[0];
    expect(runRow.status).toBe('completed');
    expect((runRow.funnel as { total: Record<string, number> }).total).toMatchObject({
      pulled: 2, signalsOk: 2, onlineOk: 0, bcIn: 0, appended: 0,
    });
  });
});

describe('runGisSignalPipeline — legal-скоринг (сегмент со скоринг-профилем)', () => {
  function legalSegmentRows() {
    return [
      {
        key: 'legal', label: 'Юридические услуги', instantly_campaign_id: 'camp-legal',
        rubric_groups: [{ category: 'Юридические / финансовые / бизнес-услуги' }],
        priority: 10, enabled: true, require_online: false,
      },
    ];
  }

  /** Сигнальный результат с заданным набором сработавших сигналов. */
  function scoredResult(hits: Array<keyof OutreachSignalsResult['signals']>): OutreachSignalsResult {
    const v = (key: keyof OutreachSignalsResult['signals']) => ({
      hit: hits.includes(key),
      evidence: hits.includes(key) ? 'какое-то evidence' : '',
    });
    const signals = {
      generalPhone: v('generalPhone'),
      contactForm: v('contactForm'),
      salesDept: v('salesDept'),
      targetVacancy: v('targetVacancy'),
      highVolume: v('highVolume'),
      multiOffice: v('multiOffice'),
      legalRelevance: v('legalRelevance'),
      crmCalltracking: v('crmCalltracking'),
    };
    return {
      signals,
      signalsCount: ['generalPhone', 'contactForm', 'salesDept', 'targetVacancy', 'highVolume', 'multiOffice']
        .filter((k) => hits.includes(k as keyof OutreachSignalsResult['signals'])).length,
      note: 'Homepage checked',
      ok: true,
    };
  }

  it('фильтр по скору: >=35 проходит (грейды A/B/C), <35 отсев; скор в архиве, сетке и лидах', async () => {
    seed({}, [], legalSegmentRows());
    pullMock.mockResolvedValue([cand('leg-hi', 'legal'), cand('leg-mid', 'legal'), cand('leg-lo', 'legal')]);
    detectMock.mockImplementation(async ({ siteUrl }: { siteUrl: string }) => {
      // leg-hi: 25+20+15+10+5 = 75 → A; leg-mid: 25+20+10 = 55 → B; leg-lo: 25+5 = 30 → отсев.
      if (siteUrl.includes('leg-hi')) {
        return scoredResult(['legalRelevance', 'salesDept', 'targetVacancy', 'generalPhone', 'crmCalltracking']);
      }
      if (siteUrl.includes('leg-mid')) return scoredResult(['legalRelevance', 'salesDept', 'generalPhone']);
      return scoredResult(['legalRelevance', 'multiOffice']);
    });

    const grid = finalGrid([
      { id: 'leg-hi', name: 'Юристы Хай', email: 'info@leg-hi.ru', score: '75', grade: 'A' },
      { id: 'leg-mid', name: 'Юристы Мид', email: 'info@leg-mid.ru', score: '55', grade: 'B' },
    ]);
    const runPromise = runGisSignalPipeline(() => {}, { pollIntervalMs: 1 });
    await completeNextBaseJob(grid);
    const result = await runPromise;

    expect(result.status).toBe('completed');
    expect(result.pulled).toBe(3);
    expect(result.signalsOk).toBe(2); // leg-lo отсеян скором <35

    // В конструкторе — только прошедшие порог.
    const jobInsert = mockDb.inserts.find((c) => c.table === 'base_constructor_jobs');
    const jobData = jobInsert!.rows[0].data as string[][];
    expect(jobData).toHaveLength(3); // header + leg-hi + leg-mid
    const scoreIdx = jobData[0].findIndex((h) => h === 'score');
    const gradeIdx = jobData[0].findIndex((h) => h === 'grade');
    expect(scoreIdx).toBeGreaterThan(0);
    expect(jobData[1][scoreIdx]).toBe('75');
    expect(jobData[1][gradeIdx]).toBe('A');
    expect(jobData[2][scoreIdx]).toBe('55');
    expect(jobData[2][gradeIdx]).toBe('B');

    // Архив: все 3 проверенные; скор/грейд у всех (сегмент scored), у leg-lo grade null.
    const archiveRows = mockDb.upserts
      .filter((c) => c.table === 'gis_signal_company_signals')
      .flatMap((c) => c.rows);
    expect(archiveRows).toHaveLength(3);
    expect(archiveRows.find((r) => r.twogis_id === 'leg-hi')).toMatchObject({
      score: 75, grade: 'A', signal_legal_relevance: true, signal_crm_calltracking: true,
    });
    expect(archiveRows.find((r) => r.twogis_id === 'leg-mid')).toMatchObject({ score: 55, grade: 'B' });
    expect(archiveRows.find((r) => r.twogis_id === 'leg-lo')).toMatchObject({ score: 30, grade: null });

    // Лиды несут score/grade в custom_variables.
    const appendArgs = appendMock.mock.calls[0][0];
    expect(appendArgs.campaignId).toBe('camp-legal');
    const byEmail = Object.fromEntries(
      appendArgs.leads.map((l: { email: string; custom_variables?: Record<string, string> }) =>
        [l.email, l.custom_variables]),
    ) as Record<string, Record<string, string>>;
    expect(byEmail['info@leg-hi.ru']).toMatchObject({ segment: 'legal', score: '75', grade: 'A' });
    expect(byEmail['info@leg-mid.ru']).toMatchObject({ segment: 'legal', score: '55', grade: 'B' });
  });

  it('сегмент без профиля (seg-a): скор/грейд не считаются, архив пишет null', async () => {
    seed();
    pullMock.mockResolvedValue([cand('a1', 'seg-a')]);

    const grid = finalGrid([{ id: 'a1', name: 'Компания a1', email: 'info@a1.ru' }]);
    const runPromise = runGisSignalPipeline(() => {}, { pollIntervalMs: 1 });
    await completeNextBaseJob(grid);
    const result = await runPromise;

    expect(result.status).toBe('completed');
    const archiveRows = mockDb.upserts
      .filter((c) => c.table === 'gis_signal_company_signals')
      .flatMap((c) => c.rows);
    expect(archiveRows[0]).toMatchObject({ twogis_id: 'a1', score: null, grade: null });
    // Новые булевы колонки при этом пишутся всегда (здесь — false от фикстуры).
    expect(archiveRows[0]).toMatchObject({ signal_legal_relevance: false, signal_crm_calltracking: false });
    // В лидах score/grade отсутствуют.
    const appendArgs = appendMock.mock.calls[0][0];
    expect(appendArgs.leads[0].custom_variables).not.toHaveProperty('score');
    expect(appendArgs.leads[0].custom_variables).not.toHaveProperty('grade');
  });
});

// ── Hardening (инцидент 12.08.2026): таймауты, watchdog, overlap, алерты ─────

describe('runGisSignalPipeline — per-candidate hard timeout', () => {
  it('зависший detectOutreachSignals → fail-row «Signal check timeout», прогон продолжается', async () => {
    seed();
    pullMock.mockResolvedValue([cand('a1', 'seg-a'), cand('hang', 'seg-a')]);
    detectMock.mockImplementation(async ({ siteUrl }: { siteUrl: string }) => {
      // Мёртвое ожидание promise — ровно сценарий инцидента 12.08.
      if (siteUrl.includes('hang')) return new Promise(() => {});
      return signalResult(true);
    });

    const grid = finalGrid([{ id: 'a1', name: 'Компания a1', email: 'info@a1.ru' }]);
    const runPromise = runGisSignalPipeline(() => {}, {
      pollIntervalMs: 1,
      signalCheckHardTimeoutMs: 1100,
    });
    await completeNextBaseJob(grid);
    const result = await runPromise;

    expect(result.status).toBe('completed');
    expect(result.pulled).toBe(2);
    expect(result.signalsOk).toBe(1); // hang отсеялся таймаутом, a1 прошла

    const archiveRows = mockDb.upserts
      .filter((c) => c.table === 'gis_signal_company_signals')
      .flatMap((c) => c.rows);
    expect(archiveRows).toHaveLength(2);
    const hangRow = archiveRows.find((r) => r.twogis_id === 'hang');
    expect(hangRow).toMatchObject({ signals_count: 0, signal_general_phone: false });
    expect(String(hangRow!.note)).toContain('Signal check timeout');
    // Здоровая компания не пострадала.
    expect(archiveRows.find((r) => r.twogis_id === 'a1')).toMatchObject({ signals_count: 1 });

    // seen/append отработали как обычно — прогон не просто «не упал», а дошёл до конца.
    expect(appendMock).toHaveBeenCalledTimes(1);
    const seenUpserts = mockDb.upserts.filter((c) => c.table === 'gis_signal_seen_companies');
    expect(seenUpserts.flatMap((c) => c.rows).map((r) => r.twogis_id)).toEqual(['a1']);
  });
});

describe('runGisSignalPipeline — archive upsert timeout', () => {
  /**
   * Патчим мок-БД: upsert в gis_signal_company_signals на заданных попытках
   * возвращает builder, чей await никогда не резолвится (мёртвый upsert 12.08).
   */
  function hangArchiveUpsert(attemptsToHang: number[]): { upsertCalls: () => number } {
    let calls = 0;
    const realFrom = mockDb.from.bind(mockDb);
    mockDb.from = ((table: string) => {
      const builder = realFrom(table);
      if (table !== 'gis_signal_company_signals') return builder;
      const realUpsert = builder.upsert.bind(builder);
      builder.upsert = ((rows: Row | Row[], opts?: { onConflict?: string }) => {
        calls += 1;
        const inner = realUpsert(rows, opts);
        if (attemptsToHang.includes(calls)) {
          (inner as { then: unknown }).then = () => new Promise(() => {});
        }
        return inner;
      }) as typeof builder.upsert;
      return builder;
    }) as typeof mockDb.from;
    return { upsertCalls: () => calls };
  }

  it('таймаут → ОДИН ретрай → повторный таймаут → run failed + TG-алерт', async () => {
    seed();
    pullMock.mockResolvedValue([cand('a1', 'seg-a')]);
    const hang = hangArchiveUpsert([1, 2]); // молчат обе попытки

    const result = await runGisSignalPipeline(() => {}, {
      pollIntervalMs: 1,
      archiveUpsertTimeoutMs: 100,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('archive upsert timeout');
    expect(hang.upsertCalls()).toBe(2); // исходная попытка + ровно один ретрай
    const runRow = mockDb.getRows('gis_signal_runs')[0];
    expect(runRow.status).toBe('failed');
    expect(String(runRow.error)).toContain('archive upsert timeout');
    // До конструктора/append не дошли.
    expect(mockDb.inserts.filter((c) => c.table === 'base_constructor_jobs')).toHaveLength(0);
    expect(appendMock).not.toHaveBeenCalled();
    // TG-алерт с этапом и воронкой.
    expect(alertMock).toHaveBeenCalledTimes(1);
    const alert = alertMock.mock.calls[0][0];
    expect(alert.workerId).toBe('gis-signal-cron');
    expect(String(alert.subject)).toContain('archive');
    expect(alert.context).toMatchObject({ stage: 'archive', pulled: 1, signals_ok: 0 });
  });

  it('таймаут → ретрай успешен → прогон завершается штатно', async () => {
    seed();
    pullMock.mockResolvedValue([cand('a1', 'seg-a')]);
    const hang = hangArchiveUpsert([1]); // молчит только первая попытка

    const grid = finalGrid([{ id: 'a1', name: 'Компания a1', email: 'info@a1.ru' }]);
    const runPromise = runGisSignalPipeline(() => {}, {
      pollIntervalMs: 1,
      archiveUpsertTimeoutMs: 100,
    });
    await completeNextBaseJob(grid);
    const result = await runPromise;

    expect(result.status).toBe('completed');
    expect(hang.upsertCalls()).toBe(2);
    // Ретрай реально записал архив (upsert идемпотентен по twogis_id).
    const rows = mockDb.getRows('gis_signal_company_signals');
    expect(rows).toHaveLength(1);
    expect(rows[0].twogis_id).toBe('a1');
  });

  it('не-timeout ошибка upsert → БЕЗ ретрая, сразу failed', async () => {
    mockDb = createMockSupabase({
      tables: {
        gis_signal_pipeline_config: [configRow()],
        gis_signal_segments: segmentRows(),
      },
      errorTables: { gis_signal_company_signals: 'db read-only' },
    });
    pullMock.mockResolvedValue([cand('a1', 'seg-a')]);
    const hang = hangArchiveUpsert([]); // считаем попытки, ничего не вешаем

    const result = await runGisSignalPipeline(() => {}, {
      pollIntervalMs: 1,
      archiveUpsertTimeoutMs: 100,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('signal archive upsert failed');
    expect(hang.upsertCalls()).toBe(1); // ретрай только для таймаута
  });
});

describe('runGisSignalPipeline — stall watchdog', () => {
  it('мёртвое ожидание на этапе pull → onStall вызван с stage=pull', async () => {
    seed();
    pullMock.mockImplementation(() => new Promise(() => {})); // никогда не отвечает
    const onStall = jest.fn();

    // Прогон намеренно НЕ await'им: он остаётся висеть (имитация инцидента);
    // dangling promise без таймеров/хендлов jest-процесс не держит.
    void runGisSignalPipeline(() => {}, { pollIntervalMs: 1, stallTimeoutMs: 150, onStall });

    for (let i = 0; i < 200 && onStall.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall.mock.calls[0][0]).toBe('pull');
  });
});

describe('runGisSignalPipeline — TG-алерты', () => {
  it('падение прогона → sendWorkerAlert с этапом и цифрами воронки', async () => {
    mockDb = createMockSupabase({
      tables: {
        gis_signal_pipeline_config: [configRow()],
        gis_signal_segments: segmentRows(),
      },
      errorTables: { gis_signal_company_signals: 'db read-only' },
    });
    pullMock.mockResolvedValue([cand('a1', 'seg-a')]);

    const result = await runGisSignalPipeline(() => {}, { pollIntervalMs: 1 });

    expect(result.status).toBe('failed');
    expect(alertMock).toHaveBeenCalledTimes(1);
    const alert = alertMock.mock.calls[0][0];
    expect(alert.workerId).toBe('gis-signal-cron');
    expect(String(alert.subject)).toContain('run failed at stage archive');
    expect(String(alert.error)).toContain('signal archive upsert failed');
    expect(alert.context).toMatchObject({
      stage: 'archive',
      pulled: 1,
      signals_ok: 0,
      appended: 0,
    });
    expect(String(alert.context.date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('measure_only: падение НЕ шлёт TG-алерт', async () => {
    mockDb = createMockSupabase({
      tables: {
        gis_signal_pipeline_config: [configRow({ measure_only: true })],
        gis_signal_segments: segmentRows(),
      },
      errorTables: { gis_signal_company_signals: 'db read-only' },
    });
    pullMock.mockResolvedValue([cand('a1', 'seg-a')]);

    const result = await runGisSignalPipeline(() => {}, { pollIntervalMs: 1 });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('signal archive upsert failed');
    expect(alertMock).not.toHaveBeenCalled();
  });
});

// ── runGuards: overlap-защита + stale-reaper (cron-обёртка) ─────────────────

describe('guardAgainstConcurrentRun (overlap + stale reaper)', () => {
  const NOW = new Date('2026-08-13T06:07:00.000Z'); // время дневного крона

  function runsDb(rows: Array<Record<string, unknown>>, errorMessage?: string) {
    return createMockSupabase({
      tables: { gis_signal_runs: rows },
      ...(errorMessage ? { errorTables: { gis_signal_runs: errorMessage } } : {}),
    });
  }

  it('свежий running (<5ч) → пропуск запуска, строку не трогаем', async () => {
    const db = runsDb([{ id: 'r-fresh', started_at: '2026-08-13T05:07:00.000Z', status: 'running' }]);
    const logs: string[] = [];
    const res = await guardAgainstConcurrentRun(
      db as unknown as GisSignalAdminDb, (m) => logs.push(m), { now: NOW },
    );
    expect(res).toEqual({ proceed: false, reapedStale: 0 });
    expect(logs.join('\n')).toContain('overlap-check');
    const row = db.getRows('gis_signal_runs')[0];
    expect(row.status).toBe('running'); // активный прогон не задет
    expect(db.updates).toHaveLength(0);
  });

  it('stale running (>5ч) → помечаем failed и продолжаем', async () => {
    const db = runsDb([{ id: 'r-stale', started_at: '2026-08-13T00:30:00.000Z', status: 'running' }]);
    const logs: string[] = [];
    const res = await guardAgainstConcurrentRun(
      db as unknown as GisSignalAdminDb, (m) => logs.push(m), { now: NOW },
    );
    expect(res).toEqual({ proceed: true, reapedStale: 1 });
    expect(logs.join('\n')).toContain('stale-reaper');
    const row = db.getRows('gis_signal_runs')[0];
    expect(row.status).toBe('failed');
    expect(row.error).toBe('stale reaped at cron start');
    expect(row.finished_at).toBe(NOW.toISOString());
  });

  it('fresh + stale одновременно → пропуск, stale НЕ реапим (живой прогон важнее)', async () => {
    const db = runsDb([
      { id: 'r-stale', started_at: '2026-08-13T00:30:00.000Z', status: 'running' },
      { id: 'r-fresh', started_at: '2026-08-13T05:07:00.000Z', status: 'running' },
    ]);
    const res = await guardAgainstConcurrentRun(
      db as unknown as GisSignalAdminDb, () => {}, { now: NOW },
    );
    expect(res.proceed).toBe(false);
    const rows = db.getRows('gis_signal_runs');
    expect(rows.find((r) => r.id === 'r-stale')!.status).toBe('running'); // не тронули
    expect(db.updates).toHaveLength(0);
  });

  it('нет running-строк → proceed, ничего не происходит', async () => {
    const db = runsDb([{ id: 'r-done', started_at: '2026-08-12T06:07:00.000Z', status: 'completed' }]);
    const res = await guardAgainstConcurrentRun(
      db as unknown as GisSignalAdminDb, () => {}, { now: NOW },
    );
    expect(res).toEqual({ proceed: true, reapedStale: 0 });
    expect(db.updates).toHaveLength(0);
  });

  it('ошибка чтения → fail-open proceed=true (прогон не блокируем)', async () => {
    const db = runsDb([], 'db unreachable');
    const logs: string[] = [];
    const res = await guardAgainstConcurrentRun(
      db as unknown as GisSignalAdminDb, (m) => logs.push(m), { now: NOW },
    );
    expect(res).toEqual({ proceed: true, reapedStale: 0 });
    expect(logs.join('\n')).toContain('db unreachable');
  });

  it('partitionRunningRuns: граница ровно 5ч → stale; битый started_at → fresh', () => {
    const rows = [
      { id: 'exact', started_at: '2026-08-13T01:07:00.000Z' }, // age ровно 5ч
      { id: 'younger', started_at: '2026-08-13T01:07:00.001Z' },
      { id: 'broken', started_at: 'not-a-date' },
    ];
    const { fresh, stale } = partitionRunningRuns(rows, NOW.getTime(), STALE_RUNNING_THRESHOLD_MS);
    expect(stale.map((r) => r.id)).toEqual(['exact']);
    expect(fresh.map((r) => r.id)).toEqual(['younger', 'broken']);
  });
});

// ── runGuards: stall watchdog — чистая таймер-логика на fake timers ─────────

describe('createStallWatchdog', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('тишина дольше таймаута → onStall ровно один раз', () => {
    const onStall = jest.fn();
    createStallWatchdog(1000, onStall);
    jest.advanceTimersByTime(999);
    expect(onStall).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onStall).toHaveBeenCalledTimes(1);
    // One-shot: дальше таймер не перевзводится сам.
    jest.advanceTimersByTime(10_000);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('touch сбрасывает отсчёт (heartbeat продлевает жизнь)', () => {
    const onStall = jest.fn();
    const w = createStallWatchdog(1000, onStall);
    jest.advanceTimersByTime(900);
    w.touch();
    jest.advanceTimersByTime(900);
    expect(onStall).not.toHaveBeenCalled();
    jest.advanceTimersByTime(100);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('stop гасит таймер — нормальное завершение без stall', () => {
    const onStall = jest.fn();
    const w = createStallWatchdog(1000, onStall);
    jest.advanceTimersByTime(500);
    w.stop();
    jest.advanceTimersByTime(10_000);
    expect(onStall).not.toHaveBeenCalled();
  });
});
