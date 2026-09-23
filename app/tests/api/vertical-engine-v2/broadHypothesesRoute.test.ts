/** @jest-environment node */

/**
 * POST …/projects/[id]/broad-hypotheses ставит задачу воркера и ничего не
 * меняет в проекте. Повторное нажатие, пока задача идёт, вторую не ставит;
 * пока идёт исследование — отказ, и исследование не стартует поверх идущего
 * добавления широких.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextRequest } from 'next/server';
import { createMockSupabase, type MockSupabaseClient, type MockSupabaseSeed, type Row } from '@/../tests/helpers/mockSupabase';
import { enqueueVeResearchJob } from '@/lib/verticalEngineV2/researchJob';

let mockDb = createMockSupabase();
jest.mock('@/lib/supabaseAdmin', () => ({ get supabaseAdmin() { return mockDb; } }));
jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: async () => ({ auth: { userId: 'staff-1' } }),
}));
jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (_options: unknown, handler: () => Promise<unknown>) => handler(),
}));
jest.mock('@/lib/loggerServer', () => ({ logAudit: jest.fn(), logError: jest.fn() }));

import { POST } from '@/app/api/tools/vertical-engine-v2/projects/[id]/broad-hypotheses/route';

const PROJECT = '8fe92ae8-d271-484e-af6c-288d20d6edaa';

function tables(extra: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    ve_projects: [{ id: PROJECT, name: 'Велл Медиа', status: 'researched' }],
    ve_verticals: [
      { id: 'vertical-1', project_id: PROJECT, name: 'Платные клиники', rank: 1 },
      { id: 'vertical-5', project_id: PROJECT, name: 'Аптечные сети', rank: 5 },
    ],
    ve_hypotheses: [
      { id: 'h-1', project_id: PROJECT, vertical_id: 'vertical-1', title: 'Сети частных клиник', status: 'accepted', broad: false },
      { id: 'h-5', project_id: PROJECT, vertical_id: 'vertical-5', title: 'Аптечные сети', status: 'proposed', broad: false },
    ],
    ve_jobs: [{ id: 'job-collect', project_id: PROJECT, stage: 'base_collect', status: 'running', payload: { base_id: 'base-1' } }],
    ...extra,
  } as Record<string, Row[]>;
}

async function post() {
  const res = await POST({} as NextRequest, { params: Promise.resolve({ id: PROJECT }) });
  return { status: res.status, body: await res.json() as { ok?: boolean; existing?: boolean; error?: string; job?: Row } };
}

function seed(seedTables: Record<string, Row[]>, options: Omit<MockSupabaseSeed, 'tables'> = {}) {
  mockDb = createMockSupabase({ tables: seedTables, ...options });
}

const broadJobs = () => mockDb.getRows('ve_jobs').filter((j) => j.stage === 'broad_hypotheses');

const MIGRATION = readFileSync(resolve(process.cwd(), '../supabase/migrations/20260923_0003_ve_jobs_broad_hypotheses_stage.sql'), 'utf8');
const START_STAGES = ['site_profile', 'broad_hypotheses'];

/**
 * Индекс ve_jobs_one_active_research_start поверх мока: одна идущая задача
 * запуска исследования или добавления широких на проект. concurrent — чужой
 * запрос, который прошёл те же проверки и успел вставить свою задачу прямо
 * перед нашей вставкой.
 */
function withResearchStartIndex(db: MockSupabaseClient, concurrent: () => Promise<unknown>): MockSupabaseClient {
  let raced = false;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (table: string) => {
        const builder = target.from(table);
        if (table !== 've_jobs') return builder;
        const insert = builder.insert.bind(builder);
        builder.insert = ((row: Row) => ({
          select: () => ({
            single: async () => {
              if (!raced) { raced = true; await concurrent(); }
              const taken = target.getRows('ve_jobs').some((j) => j.project_id === row.project_id
                && START_STAGES.includes(String(j.stage)) && ['pending', 'running'].includes(String(j.status)));
              if (START_STAGES.includes(String(row.stage)) && taken) {
                return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "ve_jobs_one_active_research_start"' } };
              }
              return insert(row).select().single();
            },
          }),
        })) as never;
        return builder;
      };
    },
  });
}

describe('POST broad-hypotheses', () => {
  it('queues one worker task and does not touch the project, its hypotheses or verticals', async () => {
    seed(tables());
    const first = await post();
    expect(first).toMatchObject({ status: 200, body: { ok: true, existing: false } });
    expect(broadJobs()).toEqual([expect.objectContaining({ project_id: PROJECT, status: 'pending', payload: {} })]);
    expect(mockDb.getRows('ve_projects')[0].status).toBe('researched');
    expect(mockDb.mutations.filter((m) => m.table !== 've_jobs')).toEqual([]);

    // Повторное нажатие, пока задача идёт: та же задача, второй нет.
    const again = await post();
    expect(again).toMatchObject({ status: 200, body: { ok: true, existing: true, job: { id: first.body.job?.id } } });
    expect(broadJobs()).toHaveLength(1);

    // Пока идёт добавление широких, исследование не стартует поверх него.
    expect(await enqueueVeResearchJob(mockDb as never, PROJECT)).toEqual({ ok: false, reason: 'conflict' });
    expect(mockDb.getRows('ve_jobs').some((j) => j.stage === 'site_profile')).toBe(false);

    // После завершения можно снова: дубли секторов отсекает сама задача.
    await mockDb.from('ve_jobs').update({ status: 'done' }).eq('id', first.body.job?.id);
    expect(await post()).toMatchObject({ status: 200, body: { ok: true, existing: false } });
    expect(broadJobs()).toHaveLength(2);
  });

  it('returns the concurrent task when the unique index wins the race', async () => {
    seed(tables(), { errorInserts: { ve_jobs: { code: '23505', message: 'duplicate key value violates unique constraint', commitRow: true } } });
    const res = await post();
    expect(res).toMatchObject({ status: 200, body: { ok: true, existing: true } });
    expect(broadJobs()).toHaveLength(1);
  });

  it('refuses with plain messages while research runs, before research and at the limit', async () => {
    seed(tables({ ve_jobs: [{ id: 'job-evidence', project_id: PROJECT, stage: 'evidence', status: 'pending', payload: {} }] }));
    expect(await post()).toEqual({ status: 409, body: { error: 'Идёт исследование проекта — широкие гипотезы можно добавить после него' } });

    seed(tables({ ve_verticals: [], ve_hypotheses: [], ve_jobs: [] }));
    expect(await post()).toMatchObject({ status: 409, body: { error: expect.stringContaining('Сначала проведите исследование проекта') } });

    const broad = (n: number, status = 'proposed') => ({ id: `b-${n}`, project_id: PROJECT, vertical_id: `vb-${n}`, title: `Сектор ${n}`, status, broad: true });
    seed(tables({ ve_hypotheses: [broad(1), broad(2), broad(3), broad(4), broad(5)] }));
    expect(await post()).toEqual({ status: 409, body: { error: 'В проекте уже 5 широких гипотез — это предел' } });
    seed(tables({ ve_hypotheses: [broad(1), broad(2), broad(3), broad(4), broad(5, 'rejected')] }));
    expect((await post()).status).toBe(200);

    seed(tables({ ve_projects: [] }));
    expect(await post()).toEqual({ status: 404, body: { error: 'Проект не найден' } });
  });

  it('keeps one research start or broad task per project in the database', () => {
    expect(MIGRATION).toMatch(/create unique index if not exists ve_jobs_one_active_research_start\s+on public\.ve_jobs \(project_id\)\s+where stage in \('site_profile', 'broad_hypotheses'\) and status in \('pending', 'running'\);/);
  });

  it('answers «busy» when research is started at the same moment and wins the race', async () => {
    const plain = createMockSupabase({ tables: tables() });
    mockDb = withResearchStartIndex(plain, () => enqueueVeResearchJob(plain as never, PROJECT));
    expect(await post()).toEqual({ status: 409, body: { error: 'Идёт исследование проекта — широкие гипотезы можно добавить после него' } });
    expect(plain.getRows('ve_jobs').filter((j) => START_STAGES.includes(String(j.stage))).map((j) => [j.stage, j.status]))
      .toEqual([['site_profile', 'pending']]);
  });

  it('does not start research when adding broad hypotheses wins the race', async () => {
    const plain = createMockSupabase({ tables: tables() });
    mockDb = plain;
    const indexed = withResearchStartIndex(plain, () => post());
    expect(await enqueueVeResearchJob(indexed as never, PROJECT)).toEqual({ ok: false, reason: 'conflict' });
    expect(plain.getRows('ve_jobs').filter((j) => START_STAGES.includes(String(j.stage))).map((j) => [j.stage, j.status]))
      .toEqual([['broad_hypotheses', 'pending']]);
    expect(plain.getRows('ve_projects')[0].status).toBe('researched');
  });

  it('explains a missing database update instead of a raw constraint error', async () => {
    seed(tables(), { errorInserts: { ve_jobs: { code: '23514', message: 'new row for relation "ve_jobs" violates check constraint "ve_jobs_stage_check"' } } });
    expect(await post()).toEqual({ status: 500, body: { error: 'Действие пока недоступно: не применено обновление базы данных' } });
  });
});
