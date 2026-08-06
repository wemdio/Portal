/** @jest-environment node */

/**
 * Tests for /api/client/eng/dashboard (ENG Command Center агрегат).
 *
 *   GET -> { projects, verticals, today, autoRefill, events, activeJobs }
 *     200 — один агрегированный ответ по ВСЕМ своим проектам (created_by):
 *           stage вертикали выводится из chains/bases/templates, today-суммы
 *           из he_auto_pipeline_runs за текущий UTC-день, next_run_at —
 *           ближайшие 03:20 UTC (строго в будущем), events — свежие и
 *           отсортированы по времени desc (кап 15).
 *     401 — unauthenticated.
 *
 * Все время-зависимые кейсы идут под jest fake timers: NOW фиксирован
 * (2026-08-06T02:00:00Z, до ежедневного прогона 03:20 UTC).
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';

/** Фиксированное «сейчас» для всех кейсов: четверг, до крона 03:20 UTC. */
const NOW = new Date('2026-08-06T02:00:00.000Z');
const TODAY = '2026-08-06';
const YESTERDAY = '2026-08-05';

let mockDb: MockSupabaseClient = createMockSupabase();
let mockAuthResult: unknown;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

jest.mock('@/lib/clientApiHelper', () => ({
  jsonError: (message: string, status: number) =>
    NextResponse.json({ error: message }, { status }),
  requireClientAuth: jest.fn(async () => mockAuthResult),
}));

jest.mock('@/lib/clientDemo/demoResponse', () => ({
  serveClientDemo: jest.fn(async () => NextResponse.json({ demo: true })),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

import { GET } from '@/app/api/client/eng/dashboard/route';

function makeReq(): NextRequest {
  return new Request('http://x/api/client/eng/dashboard', {
    method: 'GET',
    headers: { authorization: 'Bearer test-token' },
  }) as unknown as NextRequest;
}

interface DashVertical {
  id: string;
  project_id: string;
  name: string;
  stage: string;
  stageDetail: string;
  dots: boolean[];
  stats: {
    companies: number;
    emails_found: number;
    valid_count: number;
    appended_today: number;
    leads_launched: number;
  };
  launch: { campaign_url: string; campaign_name: string } | null;
  forecast: { pct: number } | null;
  actual: { reply_pct: number; sent: number; measured_at: string } | null;
}

interface DashBody {
  projects: Array<{ id: string; name: string; status: string }>;
  verticals: DashVertical[];
  today: { appended: number; valid: number; collected: number };
  autoRefill: { enabled: boolean; next_run_at: string; daily_cap: number };
  events: Array<{ type: string; text: string; at: string }>;
  activeJobs: Array<{
    id: string;
    project_id: string;
    stage: string;
    status: string;
    vertical_id: string | null;
    progress: { done?: number; total?: number; label?: string } | null;
  }>;
  error?: string;
}

function chain(verticalId: string, status = 'ready') {
  return { id: `ch-${verticalId}`, vertical_id: verticalId, status, language: 'en', created_at: `${YESTERDAY}T10:00:00.000Z` };
}

function base(
  verticalId: string,
  status: string,
  opts: Record<string, unknown> = {},
) {
  return {
    id: `b-${verticalId}-${status}`,
    project_id: 'p1',
    vertical_id: verticalId,
    status,
    source: 'auto',
    row_count: 0,
    collect_info: null,
    created_at: `${YESTERDAY}T11:00:00.000Z`,
    updated_at: `${YESTERDAY}T12:00:00.000Z`,
    ...opts,
  };
}

function template(
  verticalId: string,
  opts: Record<string, unknown> = {},
) {
  return {
    id: `t-${verticalId}`,
    vertical_id: verticalId,
    base_id: `b-${verticalId}-analyzed`,
    status: 'ready',
    launch_info: null,
    created_at: `${YESTERDAY}T13:00:00.000Z`,
    ...opts,
  };
}

function run(
  verticalId: string,
  status: string,
  createdAt: string,
  stats: Record<string, number> = {},
  completedAt: string | null = null,
) {
  return {
    id: `r-${verticalId}-${createdAt}`,
    project_id: 'p1',
    vertical_id: verticalId,
    base_id: null,
    status,
    stats,
    created_at: createdAt,
    completed_at: completedAt,
  };
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  mockAuthResult = { auth: { userId: USER_ID, accessRows: [], isDemo: false } };
  mockDb = createMockSupabase({
    tables: {
      he_projects: [],
      he_verticals: [],
      he_chains: [],
      he_bases: [],
      he_templates: [],
      he_jobs: [],
      he_auto_pipeline_configs: [],
      he_auto_pipeline_runs: [],
    },
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('GET /api/client/eng/dashboard — auth & scope', () => {
  it('returns 401 when unauthenticated', async () => {
    mockAuthResult = { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it('returns an empty aggregate when the client has no projects', async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as DashBody;
    expect(body.projects).toEqual([]);
    expect(body.verticals).toEqual([]);
    expect(body.today).toEqual({ appended: 0, valid: 0, collected: 0 });
    expect(body.autoRefill.enabled).toBe(false);
    expect(body.autoRefill.next_run_at).toBe('2026-08-06T03:20:00.000Z');
    expect(body.events).toEqual([]);
    expect(body.activeJobs).toEqual([]);
  });

  it('scopes everything to the caller — foreign projects leak nowhere', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [
          { id: 'p1', created_by: USER_ID, name: 'Mine', status: 'researched', created_at: `${YESTERDAY}T09:00:00.000Z` },
          { id: 'pX', created_by: OTHER_USER_ID, name: 'Theirs', status: 'researched', created_at: `${YESTERDAY}T09:00:00.000Z` },
        ],
        he_verticals: [
          { id: 'v1', project_id: 'p1', name: 'Banks', created_at: `${YESTERDAY}T10:00:00.000Z` },
          { id: 'vX', project_id: 'pX', name: 'Foreign vertical', created_at: `${YESTERDAY}T10:00:00.000Z` },
        ],
        he_chains: [chain('v1'), chain('vX')],
        he_bases: [
          base('v1', 'analyzed', { row_count: 147 }),
          base('vX', 'analyzed', { project_id: 'pX', row_count: 999 }),
        ],
        he_templates: [
          template('v1', {
            launch_info: {
              campaign_id: 'cmp-1',
              campaign_name: 'Mine campaign',
              campaign_url: 'https://app.instantly.ai/app/campaign/cmp-1',
              leads_count: 100,
              preset_id: 'pr-1',
              created_at: `${YESTERDAY}T15:00:00.000Z`,
            },
          }),
          template('vX', {
            launch_info: {
              campaign_id: 'cmp-X',
              campaign_name: 'Foreign campaign',
              campaign_url: 'https://app.instantly.ai/app/campaign/cmp-X',
              leads_count: 999,
              preset_id: 'pr-X',
              created_at: `${YESTERDAY}T15:00:00.000Z`,
            },
          }),
        ],
        he_jobs: [
          { id: 'j1', project_id: 'p1', stage: 'base_collect', status: 'running', payload: { base_id: 'b-v1-analyzed' }, progress: { done: 1, total: 2, label: 'harvest' }, created_at: `${TODAY}T01:00:00.000Z`, updated_at: `${TODAY}T01:30:00.000Z` },
          { id: 'jX', project_id: 'pX', stage: 'chain', status: 'running', payload: { vertical_id: 'vX' }, progress: null, created_at: `${TODAY}T01:00:00.000Z`, updated_at: `${TODAY}T01:00:00.000Z` },
        ],
        he_auto_pipeline_configs: [
          { project_id: 'p1', enabled: true, daily_leads_cap: 50, verticals_per_run: 3, last_run_at: null },
          { project_id: 'pX', enabled: true, daily_leads_cap: 500, verticals_per_run: 3, last_run_at: null },
        ],
        he_auto_pipeline_runs: [
          run('v1', 'appended', `${TODAY}T00:30:00.000Z`, { collected: 50, valid: 40, appended: 38 }, `${TODAY}T00:40:00.000Z`),
          { ...run('vX', 'appended', `${TODAY}T00:30:00.000Z`, { collected: 900, valid: 800, appended: 700 }, `${TODAY}T00:40:00.000Z`), project_id: 'pX' },
        ],
      },
    });

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as DashBody;

    expect(body.projects.map((p) => p.id)).toEqual(['p1']);
    expect(body.verticals.map((v) => v.id)).toEqual(['v1']);
    // today-суммы — только свой прогон (v1), чужой (vX) не доливается.
    expect(body.today).toEqual({ appended: 38, valid: 40, collected: 50 });
    expect(body.verticals[0].stats.appended_today).toBe(38);
    expect(body.verticals[0].launch?.campaign_name).toBe('Mine campaign');
    expect(body.autoRefill.daily_cap).toBe(50);
    expect(body.activeJobs.map((j) => j.id)).toEqual(['j1']);
    // В ленте событий не должно быть чужих имён.
    const allText = body.events.map((e) => e.text).join(' ');
    expect(allText).not.toContain('Foreign');
  });
});

describe('GET /api/client/eng/dashboard — stage derivation', () => {
  async function stageOf(verticals: Record<string, unknown>[], extra: Record<string, unknown[]> = {}) {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [{ id: 'p1', created_by: USER_ID, name: 'Mine', status: 'researched', created_at: `${YESTERDAY}T09:00:00.000Z` }],
        he_verticals: verticals,
        he_chains: [],
        he_bases: [],
        he_templates: [],
        he_jobs: [],
        he_auto_pipeline_configs: [],
        he_auto_pipeline_runs: [],
        ...extra,
      },
    });
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as DashBody;
    return Object.fromEntries(body.verticals.map((v) => [v.id, v]));
  }

  it('maps entity sets to stages (research → … → launched)', async () => {
    const byId = await stageOf(
      [
        { id: 'v-research', project_id: 'p1', name: 'R', created_at: `${YESTERDAY}T10:00:00.000Z` },
        { id: 'v-letters-pending', project_id: 'p1', name: 'LP', created_at: `${YESTERDAY}T10:01:00.000Z` },
        { id: 'v-letters', project_id: 'p1', name: 'L', created_at: `${YESTERDAY}T10:02:00.000Z` },
        { id: 'v-collecting', project_id: 'p1', name: 'C', created_at: `${YESTERDAY}T10:03:00.000Z` },
        { id: 'v-construct', project_id: 'p1', name: 'CC', created_at: `${YESTERDAY}T10:04:00.000Z` },
        { id: 'v-analyzing', project_id: 'p1', name: 'A', created_at: `${YESTERDAY}T10:05:00.000Z` },
        { id: 'v-analyzed', project_id: 'p1', name: 'AN', created_at: `${YESTERDAY}T10:06:00.000Z` },
        { id: 'v-template', project_id: 'p1', name: 'T', created_at: `${YESTERDAY}T10:07:00.000Z` },
        { id: 'v-launched', project_id: 'p1', name: 'LA', created_at: `${YESTERDAY}T10:08:00.000Z` },
      ],
      {
        // v-research: без chains — но проект researched, поэтому отдельный
        // кейс 'researching' ниже; здесь она уйдёт в letters-pending.
        he_chains: [
          chain('v-letters'),
          chain('v-collecting'),
          chain('v-construct'),
          chain('v-analyzing'),
          chain('v-analyzed'),
          chain('v-template'),
          chain('v-launched'),
        ],
        he_bases: [
          base('v-collecting', 'collecting', {
            collect_info: { limit: 2000, stats: { tasks_done: 1, tasks_total: 2, rows_total: 640 } },
          }),
          base('v-construct', 'collecting', {
            collect_info: {
              limit: 2000,
              construct: { status: 'dispatched', emails_found: 147, valid_count: 87, bc_job_id: 'bc-1', dispatched_at: `${TODAY}T01:00:00.000Z` },
            },
          }),
          base('v-analyzing', 'analyzing'),
          base('v-analyzed', 'analyzed', {
            row_count: 147,
            collect_info: { construct: { status: 'done', emails_found: 200, valid_count: 120 } },
          }),
          base('v-template', 'analyzed', { row_count: 80 }),
          base('v-launched', 'analyzed', {
            row_count: 300,
            collect_info: { construct: { status: 'done', emails_found: 250, valid_count: 210 } },
          }),
        ],
        he_templates: [
          template('v-template'),
          template('v-launched', {
            launch_info: {
              campaign_id: 'cmp-9',
              campaign_name: 'Banks US · Aug 6',
              campaign_url: 'https://app.instantly.ai/app/campaign/cmp-9',
              leads_count: 210,
              preset_id: 'pr-1',
              created_at: `${YESTERDAY}T16:00:00.000Z`,
            },
          }),
        ],
      },
    );

    expect(byId['v-letters-pending'].stage).toBe('letters');
    expect(byId['v-letters-pending'].dots).toEqual([true, false, false, false, false]);

    expect(byId['v-letters'].stage).toBe('letters');
    expect(byId['v-letters'].dots).toEqual([true, true, false, false, false]);

    expect(byId['v-collecting'].stage).toBe('collecting');
    expect(byId['v-collecting'].stageDetail).toContain('1/2');

    expect(byId['v-construct'].stage).toBe('construct');
    expect(byId['v-construct'].stageDetail).toContain('87/147');

    expect(byId['v-analyzing'].stage).toBe('analyzing');

    expect(byId['v-analyzed'].stage).toBe('analyzed');
    expect(byId['v-analyzed'].stats.companies).toBe(147);
    expect(byId['v-analyzed'].stats.emails_found).toBe(200);
    expect(byId['v-analyzed'].stats.valid_count).toBe(120);

    expect(byId['v-template'].stage).toBe('template');
    expect(byId['v-template'].launch).toBeNull();

    expect(byId['v-launched'].stage).toBe('launched');
    expect(byId['v-launched'].dots).toEqual([true, true, true, true, true]);
    expect(byId['v-launched'].launch).toEqual({
      campaign_url: 'https://app.instantly.ai/app/campaign/cmp-9',
      campaign_name: 'Banks US · Aug 6',
    });
    expect(byId['v-launched'].stats.leads_launched).toBe(210);
    // Статистика launched-вертикали — с базы, из которой собран шаблон.
    expect(byId['v-launched'].stats.companies).toBe(300);
    expect(byId['v-launched'].stats.valid_count).toBe(210);
  });

  it('marks verticals of a still-researching project as research', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [{ id: 'p1', created_by: USER_ID, name: 'Mine', status: 'researching', created_at: `${TODAY}T00:00:00.000Z` }],
        he_verticals: [{ id: 'v1', project_id: 'p1', name: 'Early', created_at: `${TODAY}T00:10:00.000Z` }],
        he_chains: [],
        he_bases: [],
        he_templates: [],
        he_jobs: [],
        he_auto_pipeline_configs: [],
        he_auto_pipeline_runs: [],
      },
    });
    const res = await GET(makeReq());
    const body = (await res.json()) as DashBody;
    expect(body.verticals[0].stage).toBe('research');
    expect(body.verticals[0].dots).toEqual([false, false, false, false, false]);
  });

  it('passes forecast (potential_pct) and actual (reply_pct/sent) through, null when unset', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [{ id: 'p1', created_by: USER_ID, name: 'Mine', status: 'researched', created_at: `${YESTERDAY}T09:00:00.000Z` }],
        he_verticals: [
          {
            id: 'v1', project_id: 'p1', name: 'Measured', created_at: `${YESTERDAY}T10:00:00.000Z`,
            potential_pct: 42, actual_reply_pct: 3.1, actual_sent: 1200, actual_measured_at: `${TODAY}T01:00:00.000Z`,
          },
          { id: 'v2', project_id: 'p1', name: 'Unmeasured', created_at: `${YESTERDAY}T10:01:00.000Z` },
        ],
        he_chains: [],
        he_bases: [],
        he_templates: [],
        he_jobs: [],
        he_auto_pipeline_configs: [],
        he_auto_pipeline_runs: [],
      },
    });
    const res = await GET(makeReq());
    const body = (await res.json()) as DashBody;
    const byId = Object.fromEntries(body.verticals.map((v) => [v.name, v]));
    expect(byId['Measured'].forecast).toEqual({ pct: 42 });
    expect(byId['Measured'].actual).toEqual({ reply_pct: 3.1, sent: 1200, measured_at: `${TODAY}T01:00:00.000Z` });
    expect(byId['Unmeasured'].forecast).toBeNull();
    expect(byId['Unmeasured'].actual).toBeNull();
  });
});

describe('GET /api/client/eng/dashboard — today sums & refill', () => {
  it('sums only runs created in the current UTC day', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [{ id: 'p1', created_by: USER_ID, name: 'Mine', status: 'researched', created_at: `${YESTERDAY}T09:00:00.000Z` }],
        he_verticals: [
          { id: 'v1', project_id: 'p1', name: 'Banks', created_at: `${YESTERDAY}T10:00:00.000Z` },
          { id: 'v2', project_id: 'p1', name: 'Fintech', created_at: `${YESTERDAY}T10:01:00.000Z` },
        ],
        he_chains: [chain('v1'), chain('v2')],
        he_bases: [],
        he_templates: [],
        he_jobs: [],
        he_auto_pipeline_configs: [],
        he_auto_pipeline_runs: [
          // Сегодня (UTC): v1 appended + v2 appended.
          run('v1', 'appended', `${TODAY}T00:30:00.000Z`, { collected: 50, valid: 40, appended: 38 }, `${TODAY}T00:40:00.000Z`),
          run('v2', 'appended', `${TODAY}T01:30:00.000Z`, { collected: 10, valid: 9, appended: 7 }, `${TODAY}T01:40:00.000Z`),
          // Вчера 23:xx UTC — НЕ сегодня, суммы не должны её включать.
          run('v1', 'appended', `${YESTERDAY}T23:30:00.000Z`, { collected: 500, valid: 400, appended: 300 }, `${YESTERDAY}T23:50:00.000Z`),
        ],
      },
    });

    const res = await GET(makeReq());
    const body = (await res.json()) as DashBody;
    expect(body.today).toEqual({ appended: 45, valid: 49, collected: 60 });
    const v1 = body.verticals.find((v) => v.id === 'v1');
    const v2 = body.verticals.find((v) => v.id === 'v2');
    expect(v1?.stats.appended_today).toBe(38);
    expect(v2?.stats.appended_today).toBe(7);
  });

  it('computes next_run_at as the nearest upcoming 03:20 UTC', async () => {
    // NOW = 02:00 — прогон сегодня ещё впереди.
    const res = await GET(makeReq());
    const body = (await res.json()) as DashBody;
    expect(body.autoRefill.next_run_at).toBe('2026-08-06T03:20:00.000Z');
  });

  it('rolls next_run_at to tomorrow at/after 03:20 UTC', async () => {
    // Ровно 03:20 — крон стартует, следующий слот уже завтра.
    jest.setSystemTime(new Date('2026-08-06T03:20:00.000Z'));
    let res = await GET(makeReq());
    let body = (await res.json()) as DashBody;
    expect(body.autoRefill.next_run_at).toBe('2026-08-07T03:20:00.000Z');

    // За секунду до — ещё сегодня.
    jest.setSystemTime(new Date('2026-08-06T03:19:59.000Z'));
    res = await GET(makeReq());
    body = (await res.json()) as DashBody;
    expect(body.autoRefill.next_run_at).toBe('2026-08-06T03:20:00.000Z');

    // После прогона — завтра.
    jest.setSystemTime(new Date('2026-08-06T04:00:00.000Z'));
    res = await GET(makeReq());
    body = (await res.json()) as DashBody;
    expect(body.autoRefill.next_run_at).toBe('2026-08-07T03:20:00.000Z');
  });

  it('reports autoRefill from the client configs', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [{ id: 'p1', created_by: USER_ID, name: 'Mine', status: 'researched', created_at: `${YESTERDAY}T09:00:00.000Z` }],
        he_verticals: [],
        he_chains: [],
        he_bases: [],
        he_templates: [],
        he_jobs: [],
        he_auto_pipeline_configs: [
          { project_id: 'p1', enabled: true, daily_leads_cap: 50, verticals_per_run: 3, last_run_at: `${YESTERDAY}T03:25:00.000Z` },
        ],
        he_auto_pipeline_runs: [],
      },
    });
    let res = await GET(makeReq());
    let body = (await res.json()) as DashBody;
    expect(body.autoRefill).toEqual({
      enabled: true,
      next_run_at: '2026-08-06T03:20:00.000Z',
      daily_cap: 50,
    });

    // Выключенный конфиг → enabled=false, но расписание всё равно считается.
    mockDb = createMockSupabase({
      tables: {
        he_projects: [{ id: 'p1', created_by: USER_ID, name: 'Mine', status: 'researched', created_at: `${YESTERDAY}T09:00:00.000Z` }],
        he_verticals: [],
        he_chains: [],
        he_bases: [],
        he_templates: [],
        he_jobs: [],
        he_auto_pipeline_configs: [
          { project_id: 'p1', enabled: false, daily_leads_cap: 50, verticals_per_run: 3, last_run_at: null },
        ],
        he_auto_pipeline_runs: [],
      },
    });
    res = await GET(makeReq());
    body = (await res.json()) as DashBody;
    expect(body.autoRefill.enabled).toBe(false);
    expect(body.autoRefill.next_run_at).toBe('2026-08-06T03:20:00.000Z');
  });
});

describe('GET /api/client/eng/dashboard — events & active jobs', () => {
  it('builds a time-sorted event feed from jobs, launches and runs', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [{ id: 'p1', created_by: USER_ID, name: 'Mine', status: 'researched', created_at: `${YESTERDAY}T09:00:00.000Z` }],
        he_verticals: [{ id: 'v1', project_id: 'p1', name: 'Banks', created_at: `${YESTERDAY}T10:00:00.000Z` }],
        he_chains: [chain('v1')],
        he_bases: [base('v1', 'analyzed', { row_count: 147 })],
        he_templates: [
          template('v1', {
            launch_info: {
              campaign_id: 'cmp-1',
              campaign_name: 'Banks US · Aug 6',
              campaign_url: 'https://app.instantly.ai/app/campaign/cmp-1',
              leads_count: 147,
              preset_id: 'pr-1',
              created_at: `${TODAY}T01:30:00.000Z`,
            },
          }),
        ],
        he_jobs: [
          // Финишированные джобы — источник событий; updated_at ≈ время финиша.
          { id: 'j-an', project_id: 'p1', stage: 'base_analyze', status: 'done', payload: { base_id: 'b-v1-analyzed' }, progress: null, created_at: `${TODAY}T01:40:00.000Z`, updated_at: `${TODAY}T01:50:00.000Z` },
          { id: 'j-t', project_id: 'p1', stage: 'template', status: 'done', payload: { base_id: 'b-v1-analyzed' }, progress: null, created_at: `${TODAY}T01:35:00.000Z`, updated_at: `${TODAY}T01:40:00.000Z` },
          { id: 'j-run', project_id: 'p1', stage: 'chain', status: 'running', payload: { vertical_id: 'v1' }, progress: { done: 14, total: 33, label: 'writing letter 2' }, created_at: `${TODAY}T01:55:00.000Z`, updated_at: `${TODAY}T01:55:00.000Z` },
        ],
        he_auto_pipeline_configs: [],
        he_auto_pipeline_runs: [
          run('v1', 'appended', `${TODAY}T00:30:00.000Z`, { collected: 50, valid: 40, appended: 38 }, `${TODAY}T00:40:00.000Z`),
        ],
      },
    });

    const res = await GET(makeReq());
    const body = (await res.json()) as DashBody;

    // Сортировка по времени desc.
    const ats = body.events.map((e) => e.at);
    expect(ats).toEqual([...ats].sort().reverse());
    // Свежие первыми: base analyzed (01:50) → template ready (01:40) →
    // launched (01:30) → refill (00:40).
    expect(body.events.map((e) => e.type)).toEqual([
      'base_analyzed',
      'template_ready',
      'launched',
      'refill_appended',
    ]);
    expect(body.events[0].text).toContain('147');
    expect(body.events[0].text).toContain('Banks');
    expect(body.events[2].text).toContain('Banks US · Aug 6');
    expect(body.events[3].text).toContain('+38');

    // Активные джобы: только running/pending, с прогрессом и вертикалью.
    expect(body.activeJobs).toHaveLength(1);
    expect(body.activeJobs[0]).toEqual(
      expect.objectContaining({
        id: 'j-run',
        stage: 'chain',
        status: 'running',
        vertical_id: 'v1',
        progress: { done: 14, total: 33, label: 'writing letter 2' },
      }),
    );
  });

  it('caps the feed at 15 events', async () => {
    const runs = Array.from({ length: 20 }, (_, i) =>
      run('v1', 'appended', `${TODAY}T00:${String(i).padStart(2, '0')}:00.000Z`, { appended: i }, `${TODAY}T00:${String(i).padStart(2, '0')}:30.000Z`),
    );
    mockDb = createMockSupabase({
      tables: {
        he_projects: [{ id: 'p1', created_by: USER_ID, name: 'Mine', status: 'researched', created_at: `${YESTERDAY}T09:00:00.000Z` }],
        he_verticals: [{ id: 'v1', project_id: 'p1', name: 'Banks', created_at: `${YESTERDAY}T10:00:00.000Z` }],
        he_chains: [chain('v1')],
        he_bases: [],
        he_templates: [],
        he_jobs: [],
        he_auto_pipeline_configs: [],
        he_auto_pipeline_runs: runs,
      },
    });
    const res = await GET(makeReq());
    const body = (await res.json()) as DashBody;
    expect(body.events).toHaveLength(15);
    // Самое свежее — последний прогон (minute 19).
    expect(body.events[0].at).toBe(`${TODAY}T00:19:30.000Z`);
  });
});
