/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

let mockDb: MockSupabaseClient;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

import { closeStaleAutoPipelineRuns } from '@/lib/jobs/autoPipelineRunner';

const CLIENT_ID = 'client-1';
const NOW = new Date('2026-08-12T09:00:00.000Z');

describe('auto-pipeline stale run recovery', () => {
  it('closes only stale runs for the selected client and is idempotent', async () => {
    mockDb = createMockSupabase({
      tables: {
        client_auto_pipeline_runs: [
          {
            id: 'stale-heartbeat', client_user_id: CLIENT_ID, status: 'running',
            started_at: '2026-08-12T08:00:00.000Z', heartbeat_at: '2026-08-12T08:51:00.000Z',
          },
          {
            id: 'fresh-heartbeat', client_user_id: CLIENT_ID, status: 'running',
            started_at: '2026-08-12T08:00:00.000Z', heartbeat_at: '2026-08-12T08:55:00.000Z',
          },
          {
            id: 'stale-without-heartbeat', client_user_id: CLIENT_ID, status: 'running',
            started_at: '2026-08-12T04:59:00.000Z', heartbeat_at: null,
          },
          {
            id: 'fresh-without-heartbeat', client_user_id: CLIENT_ID, status: 'running',
            started_at: '2026-08-12T05:01:00.000Z', heartbeat_at: null,
          },
          {
            id: 'other-client', client_user_id: 'client-2', status: 'running',
            started_at: '2026-08-12T01:00:00.000Z', heartbeat_at: null,
          },
          {
            id: 'completed', client_user_id: CLIENT_ID, status: 'completed',
            started_at: '2026-08-12T01:00:00.000Z', heartbeat_at: null,
          },
        ],
      },
    });

    await closeStaleAutoPipelineRuns(CLIENT_ID, { now: NOW, staleMinutes: 8 });
    await closeStaleAutoPipelineRuns(CLIENT_ID, { now: NOW, staleMinutes: 8 });

    const byId = new Map(
      mockDb.getRows('client_auto_pipeline_runs').map((row) => [row.id, row]),
    );
    expect(byId.get('stale-heartbeat')).toMatchObject({
      status: 'failed', finished_at: NOW.toISOString(),
    });
    expect(byId.get('stale-without-heartbeat')).toMatchObject({
      status: 'failed', finished_at: NOW.toISOString(),
    });
    expect(String(byId.get('stale-heartbeat')?.error_message)).toContain('stale');
    expect(byId.get('fresh-heartbeat')?.status).toBe('running');
    expect(byId.get('fresh-without-heartbeat')?.status).toBe('running');
    expect(byId.get('other-client')?.status).toBe('running');
    expect(byId.get('completed')?.status).toBe('completed');
  });

  it('fails closed when stale-state persistence is unavailable', async () => {
    mockDb = createMockSupabase({
      tables: { client_auto_pipeline_runs: [] },
      errorTables: { client_auto_pipeline_runs: 'run state unavailable' },
    });

    await expect(
      closeStaleAutoPipelineRuns(CLIENT_ID, { now: NOW, staleMinutes: 8 }),
    ).rejects.toThrow('run state unavailable');
  });
});
