/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const ROBOT = '00000000-0000-4000-8000-0000000000aa';

const KEY = {
  id: 'k1',
  name: 'Дима',
  key_hash: 'h',
  key_last4: '1234',
  robot_user_id: ROBOT,
  allowed_tools: ['hh', 'ats', 'eng-hiring'],
  rpm_limit: 60,
  daily_jobs_limit: 50,
  daily_rows_limit: 1000,
  max_active_jobs: 3,
  revoked_at: null,
};

let mockDb: MockSupabaseClient;

jest.mock('@/lib/bench/auth', () => {
  const actual = jest.requireActual('@/lib/bench/auth');
  return {
    ...actual,
    authenticateBench: jest.fn(async () => ({ key: KEY, db: mockDb })),
  };
});
jest.mock('@/lib/bench/limits', () => ({
  checkBenchLimits: jest.fn(async () => null),
  checkActiveJobs: jest.fn(async () => null),
}));
jest.mock('@/lib/bench/journal', () => ({ logBenchRequest: jest.fn(async () => {}) }));

import { GET as listJobs } from '@/app/api/bench/v1/jobs/route';
import { GET as jobStatus } from '@/app/api/bench/v1/jobs/[id]/route';

function listRequest(tool: string): NextRequest {
  return {
    headers: { get: () => null },
    nextUrl: new URL(`https://portal.local/api/bench/v1/jobs?tool=${tool}`),
  } as unknown as NextRequest;
}

function statusRequest(id: string, tool: string): NextRequest {
  return {
    headers: { get: () => null },
    nextUrl: new URL(`https://portal.local/api/bench/v1/jobs/${id}?tool=${tool}`),
  } as unknown as NextRequest;
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const COMMON = {
  user_id: ROBOT,
  status: 'completed',
  total_found: 10,
  total_parsed: 10,
  created_at: '2026-08-31T09:00:00Z',
  completed_at: '2026-08-31T09:30:00Z',
  error_message: null,
};

beforeEach(() => {
  mockDb = createMockSupabase({
    tables: {
      parser_jobs: [
        { id: 'hh-1', parser_type: 'hh_vacancies', ...COMMON },
        { id: 'ats-1', parser_type: 'ats_companies', ...COMMON },
        { id: 'eng-1', parser_type: 'eng_hiring', ...COMMON },
      ],
    },
  });
});

/**
 * HH, ATS и англоязычный найм делят таблицу parser_jobs. Без разграничения
 * по parser_type «покажи мои задачи HH» вернуло бы все три, а запрос статуса
 * ATS-задачи под видом HH выдал бы её с чужим смыслом полей и чужой таблицей
 * результатов. Эти тесты стерегут именно ту ошибку.
 */
describe('инструменты, делящие одну таблицу задач', () => {
  it('список HH не показывает задачи ATS и найма', async () => {
    const body = await (await listJobs(listRequest('hh'))).json();
    expect(body.jobs.map((j: { id: string }) => j.id)).toEqual(['hh-1']);
  });

  it('список ATS не показывает задачи HH', async () => {
    const body = await (await listJobs(listRequest('ats'))).json();
    expect(body.jobs.map((j: { id: string }) => j.id)).toEqual(['ats-1']);
  });

  it('список найма не показывает чужие', async () => {
    const body = await (await listJobs(listRequest('eng-hiring'))).json();
    expect(body.jobs.map((j: { id: string }) => j.id)).toEqual(['eng-1']);
  });

  it('каждый список помечает задачи своим инструментом', async () => {
    const body = await (await listJobs(listRequest('ats'))).json();
    expect(body.jobs[0].tool).toBe('ats');
  });

  it('ATS-задачу нельзя прочитать под видом HH', async () => {
    const res = await jobStatus(statusRequest('ats-1', 'hh'), ctx('ats-1'));
    expect(res.status).toBe(404);
  });

  it('свою задачу инструмент читает нормально', async () => {
    const body = await (await jobStatus(statusRequest('ats-1', 'ats'), ctx('ats-1'))).json();
    expect(body.id).toBe('ats-1');
    expect(body.tool).toBe('ats');
  });
});
