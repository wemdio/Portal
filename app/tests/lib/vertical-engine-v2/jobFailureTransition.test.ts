/** @jest-environment node */

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import { transitionVeJobFailure } from '@/lib/verticalEngineV2/jobFailureTransition';

const FAILURE = {
  jobId: 'job-1',
  status: 'failed' as const,
  attempts: 3,
  error: 'classification failed',
  finishedAt: '2026-08-28T10:20:00.000Z',
  runAfter: '2026-08-28T10:20:00.000Z',
  updatedAt: '2026-08-28T10:20:00.000Z',
};

it('commits a failure only while the job is still running', async () => {
  const db = createMockSupabase({
    tables: { ve_jobs: [{ id: 'job-1', status: 'running', attempts: 2 }] },
  });

  const result = await transitionVeJobFailure(db as never, FAILURE);

  expect(result).toEqual({ transitioned: true, error: null });
  expect(db.getRows('ve_jobs')).toEqual([
    expect.objectContaining({ id: 'job-1', status: 'failed', attempts: 3 }),
  ]);
});

it('does not overwrite cancellation that wins immediately before the failure update', async () => {
  const db = createMockSupabase({
    tables: { ve_jobs: [{ id: 'job-1', status: 'running', attempts: 2 }] },
    beforeFirstUpdates: {
      ve_jobs: (rows) => rows.map((row) => ({ ...row, status: 'cancelled' })),
    },
  });

  const result = await transitionVeJobFailure(db as never, FAILURE);

  expect(result).toEqual({ transitioned: false, error: null });
  expect(db.getRows('ve_jobs')).toEqual([
    expect.objectContaining({ id: 'job-1', status: 'cancelled', attempts: 2 }),
  ]);
});
