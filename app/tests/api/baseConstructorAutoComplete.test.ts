/** @jest-environment node */

import { NextRequest } from 'next/server';

const JOB_ID = 'job-stuck-final';
const OWNER = 'owner-1';
const marker = '__portal_enrich_attempted_v1';
const mockGetUser = jest.fn();
const mockJobSelect = jest.fn();
const mockJobUpdate = jest.fn();
const mockBlockDemo = jest.fn();

jest.mock('@/lib/supabaseAdmin', () => {
  const selectBuilder = {
    eq: () => selectBuilder,
    single: () => mockJobSelect(),
  };
  const updateBuilder = {
    eq: () => updateBuilder,
    then: (resolve: (value: { error: null }) => unknown, reject?: (error: unknown) => unknown) =>
      Promise.resolve({ error: null as null }).then(resolve, reject),
  };
  return {
    supabaseAdmin: {
      auth: { getUser: (...args: unknown[]) => mockGetUser(...args) },
      from: () => ({
        select: () => selectBuilder,
        update: (payload: unknown) => {
          mockJobUpdate(payload);
          return updateBuilder;
        },
      }),
    },
  };
});

jest.mock('@/lib/tools/baseConstructorWorker', () => ({
  runBaseConstructorJob: jest.fn(),
}));

jest.mock('@/lib/supabaseRouteClient', () => ({
  createAuthedSupabaseClient: jest.fn(() => ({})),
}));

jest.mock('@/lib/auth/blockDemo', () => ({
  blockDemo: (...args: unknown[]) => mockBlockDemo(...args),
}));

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (_meta: unknown, run: () => Promise<Response>) => run(),
}));

it('strips checkpoint metadata before auto-completing a stale final step', async () => {
  mockGetUser.mockResolvedValue({ data: { user: { id: OWNER } } });
  mockBlockDemo.mockResolvedValue(null);
  mockJobSelect.mockResolvedValueOnce({
    data: {
      id: JOB_ID,
      user_id: OWNER,
      status: 'processing',
      current_step: 1,
      total_steps: 1,
      current_step_progress: 100,
      started_at: new Date(Date.now() - 3 * 60_000).toISOString(),
      data: [
        ['Компания', 'Сайт', marker],
        ['Alpha', 'alpha.example', '1'],
      ],
    },
    error: null,
  }).mockResolvedValueOnce({
    data: { id: JOB_ID, user_id: OWNER, status: 'completed' },
    error: null,
  });

  const { GET } = await import('@/app/api/tools/base-constructor/[id]/route');
  const response = await GET(
    new NextRequest(`http://localhost/api/tools/base-constructor/${JOB_ID}`, {
      headers: { authorization: 'Bearer token' },
    }),
    { params: Promise.resolve({ id: JOB_ID }) },
  );

  expect(response.status).toBe(200);
  expect(mockJobUpdate).toHaveBeenCalledWith(expect.objectContaining({
    status: 'completed',
    data: [
      ['Компания', 'Сайт'],
      ['Alpha', 'alpha.example'],
    ],
    result_stats: expect.objectContaining({ columns: 2, total_rows: 1 }),
  }));
});
