/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const USER_ID = '00000000-0000-4000-8000-000000000283';
const PROJECT_ID = 'project-cancel-v2';

let mockDb: MockSupabaseClient = createMockSupabase();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: jest.fn(async () => ({
    auth: { supabase: mockDb, userId: USER_ID, role: 'specialist' },
  })),
}));

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (
    _options: unknown,
    handler: (trace: { end: () => Promise<void>; fail: () => Promise<void> }) => Promise<unknown>,
  ) => handler({ end: async () => {}, fail: async () => {} }),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

import { POST } from '@/app/api/tools/vertical-engine-v2/projects/[id]/cancel/route';

function request(): NextRequest {
  return new Request(
    `http://x/api/tools/vertical-engine-v2/projects/${PROJECT_ID}/cancel`,
    { method: 'POST', headers: { authorization: 'Bearer test-token' } },
  ) as unknown as NextRequest;
}

beforeEach(() => {
  mockDb = createMockSupabase({
    rpcHandlers: {
      ve_cancel_segmentation_audits: async (params, db) => {
        const activeJobs = db
          .getRows('ve_jobs')
          .filter(
            (job) =>
              job.project_id === params.p_project_id &&
              job.stage === 'segmentation_audit' &&
              (job.status === 'pending' || job.status === 'running'),
          );
        const auditIds = new Set(
          activeJobs
            .map((job) => (job.payload as { audit_id?: unknown } | undefined)?.audit_id)
            .filter((value): value is string => typeof value === 'string'),
        );
        await db
          .from('ve_jobs')
          .update({
            status: 'cancelled',
            error: params.p_error,
            finished_at: params.p_now,
            updated_at: params.p_now,
          })
          .eq('project_id', params.p_project_id)
          .eq('stage', 'segmentation_audit')
          .in('status', ['pending', 'running']);
        let audits = 0;
        for (const audit of db.getRows('ve_segmentation_audits')) {
          if (
            audit.project_id === params.p_project_id &&
            ((audit.status === 'pending' || audit.status === 'running') ||
              auditIds.has(String(audit.id)) ||
              audit.launch_status === 'running' ||
              audit.launch_status === 'uncertain')
          ) {
            audits += 1;
            await db
              .from('ve_segmentation_audits')
              .update({
                status: 'cancelled',
                error: params.p_error,
                completed_at: params.p_now,
                launch_status:
                  audit.launch_status === 'running' ? 'uncertain' : audit.launch_status,
                launch_error:
                  audit.launch_status === 'running'
                    ? 'Проект отменён во время запуска. Проверьте кампании в Instantly.'
                    : audit.launch_error,
                launch_completed_at:
                  audit.launch_status === 'running' ? params.p_now : audit.launch_completed_at,
                updated_at: params.p_now,
              })
              .eq('id', audit.id);
          }
        }
        return { data: { jobs: activeJobs.length, audits } };
      },
    },
    tables: {
      ve_projects: [{ id: PROJECT_ID, status: 'researching', error: null }],
      ve_jobs: [
        {
          id: 'seg-job',
          project_id: PROJECT_ID,
          stage: 'segmentation_audit',
          status: 'running',
          payload: { audit_id: 'audit-ready-race' },
        },
        { id: 'research-job', project_id: PROJECT_ID, stage: 'evidence', status: 'pending' },
        {
          id: 'seg-job-done',
          project_id: PROJECT_ID,
          stage: 'segmentation_audit',
          status: 'done',
          payload: { audit_id: 'audit-active-launch' },
        },
        { id: 'done-job', project_id: PROJECT_ID, stage: 'template', status: 'done' },
      ],
      // The worker already saved ready, but has not moved seg-job to done yet.
      ve_segmentation_audits: [
        {
          id: 'audit-ready-race',
          project_id: PROJECT_ID,
          status: 'ready',
          error: null,
          launch_status: 'idle',
        },
        {
          id: 'audit-active-launch',
          project_id: PROJECT_ID,
          status: 'ready',
          error: null,
          launch_status: 'running',
          launch_reservation_id: 'launch-reservation-1',
        },
      ],
      ve_bases: [],
    },
  });
});

it('cancels a segmentation audit and job atomically, including the ready-save race', async () => {
  const response = await POST(request(), { params: Promise.resolve({ id: PROJECT_ID }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, cancelled: 2, cancelled_audits: 2 });
  expect(mockDb.rpcCalls).toEqual([
    expect.objectContaining({ fn: 've_cancel_segmentation_audits' }),
  ]);

  const jobs = Object.fromEntries(mockDb.getRows('ve_jobs').map((job) => [job.id, job]));
  expect(jobs['seg-job'].status).toBe('cancelled');
  expect(jobs['research-job'].status).toBe('cancelled');
  expect(jobs['seg-job-done'].status).toBe('done');
  expect(jobs['done-job'].status).toBe('done');
  const audits = Object.fromEntries(
    mockDb.getRows('ve_segmentation_audits').map((audit) => [audit.id, audit]),
  );
  expect(audits['audit-ready-race']).toEqual(
    expect.objectContaining({ status: 'cancelled', error: 'Отменено пользователем' }),
  );
  expect(audits['audit-active-launch']).toEqual(
    expect.objectContaining({
      status: 'cancelled',
      launch_status: 'uncertain',
      launch_reservation_id: 'launch-reservation-1',
    }),
  );
  expect(mockDb.getRows('ve_projects')[0].status).toBe('draft');
});
