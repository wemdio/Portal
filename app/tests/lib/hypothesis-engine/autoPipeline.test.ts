/** @jest-environment node */

/**
 * ENG auto-pipeline Движка вертикалей — ежедневный добор лидов в уже
 * запущенные кампании us-проектов (аналог RU autoPipelineCron поверх HE).
 *
 *   tick (cron)  — enabled-конфиги только по проектам market='us'; вертикали
 *                  с launched-кампанией (he_templates.launch_info.campaign_id,
 *                  последняя по created_at) и без активной сборки (дедуп внутри
 *                  enqueueHeBaseCollect: 'existing' слот НЕ ест); не более
 *                  verticals_per_run за тик; постановка refill-сборки (he_bases
 *                  source='auto'/status='collecting', filename
 *                  «auto-refill: <vertical> · <дата>», collect_info
 *                  {limit, refill, campaign_id} + he_jobs payload.refill);
 *                  запись he_auto_pipeline_runs 'collecting'; last_run_at.
 *   refill-ветка — после IMPORT из CONSTRUCT: лиды только из строк с email и
 *                  вердиктом валидации 'ok' (catch_all/invalid исключены;
 *                  без колонки статуса — все строки с email, как на запуске);
 *                  маппинг через operator_mapping запущенного шаблона
 *                  (campaign_id из collect_info, фолбэк — последний launched
 *                  шаблон вертикали); blocklist владельца пресета; кап
 *                  daily_leads_cap с учётом уже долитого за UTC-день;
 *                  appendLeadsToClientCampaign со skipIfInCampaign=true.
 *                  База → 'analyzed' (НЕ analyzing), base_analyze/template НЕ
 *                  ставятся; runs → 'appended' + refill_result в collect_info.
 *                  Пустой harvest → runs 'no_new', база НЕ failed, джоба done.
 *                  Ошибка append → runs 'failed', база 'analyzed' с ошибкой в
 *                  refill_result, джоба НЕ падает (завтрашний тик соберёт anew).
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HeJob } from '@/lib/hypothesisEngine/types';

jest.mock('@/lib/companiesSearch/rpcSearch', () => ({
  searchRows: jest.fn(),
}));

jest.mock('@/lib/hypothesisEngine/llm', () => ({
  callLLMWithSchema: jest.fn(),
  getHeModel: jest.fn(() => 'test-bulk-model'),
}));

jest.mock('@/lib/clientLaunch/appendLeads', () => ({
  appendLeadsToClientCampaign: jest.fn(),
}));

let mockInstantlyDb: MockSupabaseClient = createMockSupabase();
jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return mockInstantlyDb;
  },
}));

import { appendLeadsToClientCampaign } from '@/lib/clientLaunch/appendLeads';
import { runHeAutoPipelineTick, HE_AUTO_REFILL_ROWS_LIMIT } from '@/lib/hypothesisEngine/autoPipeline';
import {
  HE_AUTO_COLLECT_COLUMNS,
  runBaseCollectStage,
  type HeCollectInfo,
  type HeUnifiedRow,
} from '@/lib/hypothesisEngine/stages/baseCollect';

const appendLeadsMock = appendLeadsToClientCampaign as unknown as jest.Mock;

let mockDb: MockSupabaseClient = createMockSupabase();

function ctx() {
  return { supabase: mockDb as unknown as SupabaseClient, market: 'us' as const };
}

/* ─────────────────────────── Тик (крон) ─────────────────────────── */

const CONFIG_US = {
  id: 'cfg-us',
  project_id: 'p-us',
  enabled: true,
  daily_leads_cap: 50,
  verticals_per_run: 2,
  last_run_at: null,
};
const CONFIG_RU = { ...CONFIG_US, id: 'cfg-ru', project_id: 'p-ru', verticals_per_run: 3 };
const CONFIG_DISABLED = { ...CONFIG_US, id: 'cfg-off', project_id: 'p-off', enabled: false };

const PROJECTS = [
  { id: 'p-us', market: 'us' },
  { id: 'p-ru', market: 'ru' },
  { id: 'p-off', market: 'us' },
];

function vertical(id: string, projectId: string, name: string, createdAt: string) {
  return { id, project_id: projectId, name, created_at: createdAt };
}

function launchedTemplate(verticalId: string, campaignId: string, launchCreatedAt: string) {
  return {
    id: `tpl-${verticalId}`,
    vertical_id: verticalId,
    launch_info: {
      campaign_id: campaignId,
      campaign_name: `HE · ${campaignId}`,
      campaign_url: '',
      leads_count: 10,
      preset_id: 'preset-1',
      created_at: launchCreatedAt,
    },
    created_at: launchCreatedAt,
  };
}

function seedTickTables(extra: Record<string, Array<Record<string, unknown>>> = {}) {
  mockDb = createMockSupabase({
    tables: {
      he_auto_pipeline_configs: [CONFIG_US, CONFIG_RU, CONFIG_DISABLED],
      he_projects: PROJECTS,
      he_verticals: [
        vertical('v1', 'p-us', 'Staffing', '2026-08-01T00:00:00Z'),
        vertical('v2', 'p-us', 'Recruiting', '2026-07-01T00:00:00Z'),
        vertical('v3', 'p-us', 'Exec search', '2026-08-03T00:00:00Z'),
        vertical('v9', 'p-ru', 'HR-агентства', '2026-07-01T00:00:00Z'),
      ],
      he_templates: [
        launchedTemplate('v1', 'camp-1', '2026-08-02T00:00:00Z'),
        launchedTemplate('v2', 'camp-2', '2026-08-02T00:00:00Z'),
        // v3: шаблон есть, но в запуск не уходил (launch_info нет).
        { id: 'tpl-v3', vertical_id: 'v3', launch_info: null, created_at: '2026-08-02T00:00:00Z' },
        launchedTemplate('v9', 'camp-9', '2026-08-02T00:00:00Z'),
      ],
      he_bases: [],
      he_jobs: [],
      he_auto_pipeline_runs: [],
      ...extra,
    },
  });
}

const TICK_NOW = new Date('2026-08-05T03:20:00.000Z');

describe('he auto-pipeline tick', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('обрабатывает только enabled-конфиги us-проектов; ru и disabled пропускаются', async () => {
    seedTickTables();
    const summary = await runHeAutoPipelineTick(mockDb as unknown as SupabaseClient, { now: TICK_NOW });

    expect(summary.configs).toBe(1);
    expect(summary.failed).toBe(0);

    // Базы поставлены только под вертикали p-us (v2 раньше по created_at → первый слот).
    const baseInserts = mockDb.inserts.filter((i) => i.table === 'he_bases');
    expect(baseInserts.map((i) => i.rows[0].vertical_id)).toEqual(['v2', 'v1']);
    // RU-конфиг не тронут: ни баз, ни last_run_at.
    const cfgUpdates = mockDb.updates.filter((u) => u.table === 'he_auto_pipeline_configs');
    expect(cfgUpdates).toHaveLength(1);
    expect(cfgUpdates[0].filters).toEqual([{ column: 'id', op: 'eq', value: 'cfg-us' }]);
  });

  it('verticals_per_run: не больше лимита за тик, порядок — по created_at вертикали', async () => {
    seedTickTables({
      he_templates: [
        launchedTemplate('v1', 'camp-1', '2026-08-02T00:00:00Z'),
        launchedTemplate('v2', 'camp-2', '2026-08-02T00:00:00Z'),
        launchedTemplate('v3', 'camp-3', '2026-08-04T00:00:00Z'),
      ],
    });
    const summary = await runHeAutoPipelineTick(mockDb as unknown as SupabaseClient, { now: TICK_NOW });

    expect(summary.enqueued).toBe(2);
    const baseInserts = mockDb.inserts.filter((i) => i.table === 'he_bases');
    // v3 (самая поздняя) не влезла в лимит 2.
    expect(baseInserts.map((i) => i.rows[0].vertical_id)).toEqual(['v2', 'v1']);
  });

  it('вертикаль без launched-кампании пропускается (no_campaign), слот не тратится', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_auto_pipeline_configs: [{ ...CONFIG_US, verticals_per_run: 1 }],
        he_projects: PROJECTS,
        he_verticals: [
          vertical('v-old', 'p-us', 'Old', '2026-07-01T00:00:00Z'),
          vertical('v-new', 'p-us', 'New', '2026-08-01T00:00:00Z'),
        ],
        he_templates: [
          { id: 'tpl-old', vertical_id: 'v-old', launch_info: null, created_at: '2026-08-02T00:00:00Z' },
          launchedTemplate('v-new', 'camp-new', '2026-08-02T00:00:00Z'),
        ],
        he_bases: [],
        he_jobs: [],
        he_auto_pipeline_runs: [],
      },
    });

    const summary = await runHeAutoPipelineTick(mockDb as unknown as SupabaseClient, { now: TICK_NOW });

    expect(summary.noCampaign).toBe(1);
    expect(summary.enqueued).toBe(1);
    const baseInserts = mockDb.inserts.filter((i) => i.table === 'he_bases');
    expect(baseInserts.map((i) => i.rows[0].vertical_id)).toEqual(['v-new']);
  });

  it('активная сборка вертикали → existing (дедуп), слот не тратится', async () => {
    seedTickTables({
      he_bases: [
        {
          id: 'b-live',
          project_id: 'p-us',
          vertical_id: 'v2',
          source: 'auto',
          status: 'collecting',
          collect_info: { limit: 200, refill: true, campaign_id: 'camp-2' },
        },
      ],
    });
    const summary = await runHeAutoPipelineTick(mockDb as unknown as SupabaseClient, { now: TICK_NOW });

    expect(summary.existing).toBe(1);
    expect(summary.enqueued).toBe(1);
    const baseInserts = mockDb.inserts.filter((i) => i.table === 'he_bases');
    // v2 уже собирается — новую базу под неё НЕ ставим; слот ушёл v1.
    expect(baseInserts.map((i) => i.rows[0].vertical_id)).toEqual(['v1']);
  });

  it('постановка refill: filename/collect_info/payload с campaign_id и лимитом 200, run collecting', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_auto_pipeline_configs: [{ ...CONFIG_US, verticals_per_run: 1 }],
        he_projects: PROJECTS,
        he_verticals: [vertical('v1', 'p-us', 'Staffing', '2026-08-01T00:00:00Z')],
        he_templates: [launchedTemplate('v1', 'camp-1', '2026-08-02T00:00:00Z')],
        he_bases: [],
        he_jobs: [],
        he_auto_pipeline_runs: [],
      },
    });

    await runHeAutoPipelineTick(mockDb as unknown as SupabaseClient, { now: TICK_NOW });

    const baseRow = mockDb.inserts.find((i) => i.table === 'he_bases')?.rows[0];
    expect(baseRow).toMatchObject({
      project_id: 'p-us',
      vertical_id: 'v1',
      source: 'auto',
      status: 'collecting',
      filename: 'auto-refill: Staffing · 2026-08-05',
      collect_info: { limit: HE_AUTO_REFILL_ROWS_LIMIT, refill: true, campaign_id: 'camp-1' },
    });
    expect(HE_AUTO_REFILL_ROWS_LIMIT).toBe(200);

    const jobRow = mockDb.inserts.find((i) => i.table === 'he_jobs')?.rows[0];
    expect(jobRow).toMatchObject({
      project_id: 'p-us',
      stage: 'base_collect',
      status: 'pending',
      payload: { base_id: baseRow?.id, limit: 200, refill: true },
    });

    const runRow = mockDb.inserts.find((i) => i.table === 'he_auto_pipeline_runs')?.rows[0];
    expect(runRow).toMatchObject({
      config_id: 'cfg-us',
      project_id: 'p-us',
      vertical_id: 'v1',
      base_id: baseRow?.id,
      status: 'collecting',
    });

    // last_run_at проставлен.
    const cfgUpdate = mockDb.updates.find((u) => u.table === 'he_auto_pipeline_configs');
    expect(cfgUpdate?.patch.last_run_at).toBe(TICK_NOW.toISOString());
  });

  it('last_run_at обновляется, даже когда ставить нечего (вертикали без кампаний)', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_auto_pipeline_configs: [CONFIG_US],
        he_projects: PROJECTS,
        he_verticals: [vertical('v1', 'p-us', 'Staffing', '2026-08-01T00:00:00Z')],
        he_templates: [],
        he_bases: [],
        he_jobs: [],
        he_auto_pipeline_runs: [],
      },
    });

    const summary = await runHeAutoPipelineTick(mockDb as unknown as SupabaseClient, { now: TICK_NOW });

    expect(summary.enqueued).toBe(0);
    const cfgUpdate = mockDb.updates.find((u) => u.table === 'he_auto_pipeline_configs');
    expect(cfgUpdate?.patch.last_run_at).toBe(TICK_NOW.toISOString());
  });

  it('ошибка постановки одной вертикали → run failed, остальные продолжаются', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_auto_pipeline_configs: [{ ...CONFIG_US, verticals_per_run: 1 }],
        he_projects: PROJECTS,
        he_verticals: [vertical('v1', 'p-us', 'Staffing', '2026-08-01T00:00:00Z')],
        he_templates: [launchedTemplate('v1', 'camp-1', '2026-08-02T00:00:00Z')],
        he_bases: [],
        he_jobs: [],
        he_auto_pipeline_runs: [],
      },
      errorInserts: { he_bases: { code: '500', message: 'db down' } },
    });

    const summary = await runHeAutoPipelineTick(mockDb as unknown as SupabaseClient, { now: TICK_NOW });

    expect(summary.enqueued).toBe(0);
    expect(summary.failed).toBe(1);
    const runRow = mockDb.inserts.find((i) => i.table === 'he_auto_pipeline_runs')?.rows[0];
    expect(runRow).toMatchObject({ status: 'failed', base_id: null });
    expect(String(runRow?.error)).toContain('db down');
  });

  it('нет enabled-конфигов → нулевой summary без единой записи', async () => {
    mockDb = createMockSupabase({
      tables: { he_auto_pipeline_configs: [{ ...CONFIG_US, enabled: false }] },
    });

    const summary = await runHeAutoPipelineTick(mockDb as unknown as SupabaseClient, { now: TICK_NOW });

    expect(summary).toMatchObject({ configs: 0, enqueued: 0, existing: 0, noCampaign: 0, failed: 0 });
    expect(mockDb.inserts).toHaveLength(0);
    expect(mockDb.updates).toHaveLength(0);
  });
});

/* ─────────────────────────── Refill-ветка стадии ─────────────────────────── */

const PROJECT_US = { id: 'p1', name: 'P', created_by: 'user-1', market: 'us' };
const VERTICAL = {
  id: 'v1',
  project_id: 'p1',
  name: 'Staffing agencies',
  summary: 'Recruitment and staffing',
  synonyms: [],
  potential_pct: 50,
  rank: 1,
};

const EN_HEADERS = ['Company', 'Site', 'Email', 'Phone', 'Vacancy', 'Address', 'Category', 'Employees', 'Revenue', 'INN', 'Source'];

function makeBase(collectInfo: HeCollectInfo | null): Record<string, unknown> {
  return {
    id: 'b1',
    project_id: 'p1',
    vertical_id: 'v1',
    filename: 'auto-refill: Staffing agencies · 2026-08-05',
    row_count: 0,
    columns: [],
    sample_rows: [],
    data: [],
    status: 'collecting',
    source: 'auto',
    collect_info: collectInfo,
  };
}

function makeRefillJob(): HeJob {
  return {
    id: 'job-1',
    project_id: 'p1',
    stage: 'base_collect',
    status: 'running',
    payload: { base_id: 'b1', limit: 200, refill: true },
    result: null,
    attempts: 1,
    error: null,
    started_at: '2026-08-05T00:00:00Z',
    tokens_used: 0,
    cost_usd: 0,
    created_at: '2026-08-05T00:00:00Z',
    updated_at: '2026-08-05T00:00:00Z',
  };
}

function row(partial: Partial<HeUnifiedRow>): HeUnifiedRow {
  const full = {} as HeUnifiedRow;
  for (const col of HE_AUTO_COLLECT_COLUMNS) full[col] = partial[col] ?? '';
  return full;
}

/** collect_info refill-сборки: задачи done, CONSTRUCT ждёт BC-джобу. */
function refillInfo(harvest: HeUnifiedRow[], construct?: HeCollectInfo['construct']): HeCollectInfo {
  return {
    limit: 200,
    refill: true,
    campaign_id: 'camp-1',
    plan: { tasks: [] },
    tasks: [
      {
        source: 'pdl',
        status: 'done',
        child_job_id: null,
        rows: harvest.length,
        task: { source: 'pdl', rationale: 'r', pdl_filters: { industries: ['software'] } },
        harvest,
      },
    ],
    ...(construct ? { construct } : {}),
  };
}

/** Шаблон с launch_info и operator_mapping (company → companyName). */
function launchedHeTemplate(campaignId = 'camp-1', launchCreatedAt = '2026-08-01T00:00:00Z') {
  return {
    id: `tpl-${campaignId}`,
    base_id: 'b-old',
    vertical_id: 'v1',
    launch_info: {
      campaign_id: campaignId,
      campaign_name: `HE · ${campaignId}`,
      campaign_url: '',
      leads_count: 15,
      preset_id: 'preset-1',
      created_at: launchCreatedAt,
    },
    personalization_plan: {
      letters: [],
      additions: [],
      operator_mapping: [
        { operator: 'companyName', column: 'company', matched: true },
        { operator: 'unmatchedOp', column: null, matched: false },
      ],
    },
    created_at: launchCreatedAt,
  };
}

const REFILL_CONFIG = {
  id: 'cfg1',
  project_id: 'p1',
  enabled: true,
  daily_leads_cap: 50,
  verticals_per_run: 3,
};

const COLLECTING_RUN = {
  id: 'run-1',
  config_id: 'cfg1',
  project_id: 'p1',
  vertical_id: 'v1',
  base_id: 'b1',
  status: 'collecting',
  stats: {},
};

/** BC-джоба completed: 4 строки с разными вердиктами валидации. */
const BC_GRID = [
  [...EN_HEADERS, 'Description', 'Email Статус'],
  ['Acme Inc', 'acme.com', 'found@acme.com', '', 'AE', 'austin, tx, united states', 'software', '51-200', '', '', 'pdl', 'Acme desc', 'ok'],
  ['Globex', 'globex.com', 'bad@globex.com', '', '', '', 'staffing and recruiting', '', '', '', 'pdl', 'Globex desc', 'invalid'],
  ['Initech', 'initech.com', 'catch@initech.com', '', '', '', 'software', '', '', '', 'pdl', 'Initech desc', 'catch_all'],
  ['Umbrella', 'umbrella.com', 'hi@umbrella.com', '', '', '', 'software', '', '', '', 'pdl', 'Umbrella desc', 'ok'],
];

function seedRefillTables(
  info: HeCollectInfo,
  extraTables: Record<string, Array<Record<string, unknown>>> = {},
  extraInstantly: Record<string, Array<Record<string, unknown>>> = {},
) {
  mockDb = createMockSupabase({
    tables: {
      he_bases: [makeBase(info)],
      he_verticals: [VERTICAL],
      he_projects: [PROJECT_US],
      he_jobs: [makeRefillJob() as unknown as Record<string, unknown>],
      he_templates: [launchedHeTemplate()],
      he_auto_pipeline_configs: [REFILL_CONFIG],
      he_auto_pipeline_runs: [COLLECTING_RUN],
      ...extraTables,
    },
  });
  mockInstantlyDb = createMockSupabase({
    tables: {
      client_campaign_presets: [{ id: 'preset-1', client_user_id: 'owner-1' }],
      client_blocked_contacts: [],
      ...extraInstantly,
    },
  });
}

/** collect_info с CONSTRUCT, ожидающим completed BC-джобу с сеткой выше. */
function infoWaitingConstruct(harvest: HeUnifiedRow[]): HeCollectInfo {
  return refillInfo(harvest, {
    bc_job_id: 'bc1',
    status: 'dispatched',
    dispatched_at: new Date().toISOString(),
  });
}

const HARVEST_ROWS = [
  row({ company: 'Acme Inc', website: 'acme.com', category: 'software', source_detail: 'pdl' }),
  row({ company: 'Globex', website: 'globex.com', category: 'staffing and recruiting', source_detail: 'pdl' }),
  row({ company: 'Initech', website: 'initech.com', source_detail: 'pdl' }),
  row({ company: 'Umbrella', website: 'umbrella.com', source_detail: 'pdl' }),
];

function seedRefillWithConstruct(
  extra: Record<string, Array<Record<string, unknown>>> = {},
  extraInstantly: Record<string, Array<Record<string, unknown>>> = {},
) {
  seedRefillTables(infoWaitingConstruct(HARVEST_ROWS), {
    base_constructor_jobs: [
      { id: 'bc1', status: 'completed', error_message: null, data: BC_GRID, result_stats: { emails_found: 4 } },
    ],
    ...extra,
  }, extraInstantly);
}

function lastBasePatch() {
  return mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
}

function lastRunPatch() {
  return mockDb.updates.filter((u) => u.table === 'he_auto_pipeline_runs').at(-1)?.patch;
}

describe('base_collect refill-ветка', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    appendLeadsMock.mockResolvedValue({ accepted: 1, skipped: 0 });
  });

  it('happy path: valid-only лиды, operator_mapping, blocklist, база analyzed, run appended', async () => {
    seedRefillWithConstruct({}, {
      client_blocked_contacts: [{ client_user_id: 'owner-1', email: 'found@acme.com' }],
    });

    const res = await runBaseCollectStage(makeRefillJob(), ctx());
    const result = res.result as { refill: { status: string } };
    expect(result.refill.status).toBe('appended');

    // Append: только Umbrella (Acme — в blocklist; Globex invalid; Initech catch_all).
    expect(appendLeadsMock).toHaveBeenCalledTimes(1);
    const appendInput = appendLeadsMock.mock.calls[0][0];
    expect(appendInput.userId).toBe('owner-1');
    expect(appendInput.campaignId).toBe('camp-1');
    expect(appendInput.skipIfInCampaign).toBe(true);
    expect(appendInput.leads).toHaveLength(1);
    expect(appendInput.leads[0].email).toBe('hi@umbrella.com');
    // operator_mapping: company ушла в custom_variables под именем оператора.
    expect(appendInput.leads[0].custom_variables).toMatchObject({ companyName: 'Umbrella' });
    expect(appendInput.leads[0].custom_variables.company).toBeUndefined();

    // База — терминальный 'analyzed' (НЕ analyzing), base_analyze НЕ ставится.
    const patch = lastBasePatch();
    expect(patch?.status).toBe('analyzed');
    expect(mockDb.inserts.find((i) => i.table === 'he_jobs' && (i.rows[0] as { stage?: string }).stage === 'base_analyze')).toBeUndefined();

    // Run обновлён: appended + полная статистика воронки.
    const runPatch = lastRunPatch();
    expect(runPatch?.status).toBe('appended');
    expect(runPatch?.completed_at).toBeTruthy();
    expect(runPatch?.stats).toMatchObject({
      collected: 4,
      with_email: 4,
      valid: 2,
      appended: 1,
      skipped_blocklist: 1,
    });

    // refill_result — в collect_info базы.
    const info = patch?.collect_info as HeCollectInfo;
    expect(info.refill_result).toMatchObject({ status: 'appended', campaign_id: 'camp-1' });
  });

  it('без колонки «Email Статус» (валидация не дошла) — берём все строки с email', async () => {
    // Частичный импорт: BC-джоба failed после find_emails, колонки статуса нет.
    seedRefillTables(infoWaitingConstruct(HARVEST_ROWS), {
      base_constructor_jobs: [
        {
          id: 'bc1',
          status: 'failed',
          error_message: 'smtp proxy down',
          data: [
            EN_HEADERS,
            ['Acme Inc', 'acme.com', 'found@acme.com', '', 'AE', 'austin', 'software', '51-200', '', '', 'pdl'],
            ['Globex', 'globex.com', '', '', '', '', 'staffing and recruiting', '', '', '', 'pdl'],
          ],
          result_stats: null,
        },
      ],
    });
    appendLeadsMock.mockResolvedValue({ accepted: 1, skipped: 0 });

    const res = await runBaseCollectStage(makeRefillJob(), ctx());
    expect((res.result as { refill: { status: string } }).refill.status).toBe('appended');

    const appendInput = appendLeadsMock.mock.calls[0][0];
    expect(appendInput.leads.map((l: { email: string }) => l.email)).toEqual(['found@acme.com']);
  });

  it('email-rich harvest → CONSTRUCT всё равно идёт (валидация обязательна), без find_emails', async () => {
    const richHarvest = [
      row({ company: 'Acme', website: 'acme.com', email: 'a@acme.com' }),
      row({ company: 'Globex', website: 'globex.com', email: 'g@globex.com' }),
    ];
    seedRefillTables(refillInfo(richHarvest));

    const res = await runBaseCollectStage(makeRefillJob(), ctx());
    expect((res.result as { waiting: boolean }).waiting).toBe(true);

    // Конструктор вызван даже на богатой базе: validate_emails обязателен,
    // find_emails пропущен. Долив произойдёт после завершения конструктора.
    const bcInsert = mockDb.inserts.find((i) => i.table === 'base_constructor_jobs');
    expect(bcInsert).toBeDefined();
    expect(bcInsert?.rows[0].selected_steps).toEqual([
      'dedup_email',
      'validate_emails',
      'cap_emails_per_company',
      'enrich_descriptions',
    ]);
    expect(appendLeadsMock).not.toHaveBeenCalled();
  });

  it('campaign_id из collect_info отсутствует → фолбэк на последний launched шаблон вертикали', async () => {
    const info = infoWaitingConstruct(HARVEST_ROWS);
    delete info.campaign_id;
    seedRefillTables(info, {
      base_constructor_jobs: [
        { id: 'bc1', status: 'completed', error_message: null, data: BC_GRID, result_stats: { emails_found: 4 } },
      ],
      he_templates: [
        launchedHeTemplate('camp-old', '2026-07-20T00:00:00Z'),
        launchedHeTemplate('camp-new', '2026-08-01T00:00:00Z'),
      ],
    });

    await runBaseCollectStage(makeRefillJob(), ctx());
    expect(appendLeadsMock.mock.calls[0][0].campaignId).toBe('camp-new');
  });

  it('пустой harvest → run no_new, база analyzed (НЕ failed), джоба завершается без append', async () => {
    seedRefillTables(refillInfo([]));

    const res = await runBaseCollectStage(makeRefillJob(), ctx());
    const result = res.result as { rows: number; refill: { status: string } };
    expect(result.rows).toBe(0);
    expect(result.refill.status).toBe('no_new');

    const patch = lastBasePatch();
    expect(patch?.status).toBe('analyzed');
    expect(String(patch?.error ?? '')).not.toContain('Авто-сборка');

    expect(lastRunPatch()?.status).toBe('no_new');
    expect(appendLeadsMock).not.toHaveBeenCalled();
    expect(mockDb.inserts.find((i) => i.table === 'he_jobs' && (i.rows[0] as { stage?: string }).stage === 'base_analyze')).toBeUndefined();
  });

  it('дневной кап: уже долитое за UTC-день вычитается из daily_leads_cap', async () => {
    seedRefillWithConstruct({
      he_auto_pipeline_configs: [{ ...REFILL_CONFIG, daily_leads_cap: 1 }],
      he_auto_pipeline_runs: [
        COLLECTING_RUN,
        {
          id: 'run-0',
          config_id: 'cfg1',
          project_id: 'p1',
          vertical_id: 'v2',
          base_id: 'b-other',
          status: 'appended',
          stats: { appended: 1 },
          completed_at: new Date().toISOString(),
        },
      ],
    });

    const res = await runBaseCollectStage(makeRefillJob(), ctx());
    const result = res.result as { refill: { status: string } };
    // Бюджет исчерпан (1 из 1 уже долит сегодня) — append не вызываем.
    expect(result.refill.status).toBe('appended');
    expect(appendLeadsMock).not.toHaveBeenCalled();
    expect(lastRunPatch()?.stats).toMatchObject({ valid: 2, appended: 0, capped: 2 });
  });

  it('ошибка append → run failed + refill_result.error, база analyzed, джоба НЕ падает', async () => {
    seedRefillWithConstruct();
    appendLeadsMock.mockRejectedValue(new Error('Instantly down'));

    const res = await runBaseCollectStage(makeRefillJob(), ctx());
    const result = res.result as { refill: { status: string } };
    expect(result.refill.status).toBe('failed');

    const patch = lastBasePatch();
    expect(patch?.status).toBe('analyzed');
    const info = patch?.collect_info as HeCollectInfo;
    expect(info.refill_result?.status).toBe('failed');
    expect(String(info.refill_result?.error)).toContain('Instantly down');

    const runPatch = lastRunPatch();
    expect(runPatch?.status).toBe('failed');
    expect(String(runPatch?.error)).toContain('Instantly down');
  });

  it('нет launched-шаблона у вертикали → refill failed с понятной ошибкой, append не вызывается', async () => {
    seedRefillWithConstruct({ he_templates: [] });

    const res = await runBaseCollectStage(makeRefillJob(), ctx());
    expect((res.result as { refill: { status: string } }).refill.status).toBe('failed');
    expect(appendLeadsMock).not.toHaveBeenCalled();
    expect(lastRunPatch()?.status).toBe('failed');
    expect(String(lastRunPatch()?.error)).toMatch(/кампан/i);
  });
});
