/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

let mockDb: MockSupabaseClient;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

import {
  loadSeenDomains,
  loadSeenEmployerIds,
  upsertSeenEmployers,
} from '@/lib/jobs/autoPipelineRunner';

describe('auto pipeline durable seen-state persistence', () => {
  it('fails closed when employer-id dedup state cannot be loaded', async () => {
    mockDb = createMockSupabase({
      tables: { client_auto_pipeline_seen_employers: [] },
      errorTables: { client_auto_pipeline_seen_employers: 'seen read unavailable' },
    });

    await expect(loadSeenEmployerIds('client-1')).rejects.toThrow('seen read unavailable');
    await expect(loadSeenDomains('client-1')).rejects.toThrow('seen read unavailable');
  });

  it('fails closed when the final seen-state upsert is rejected', async () => {
    mockDb = createMockSupabase({
      tables: { client_auto_pipeline_seen_employers: [] },
      errorTables: { client_auto_pipeline_seen_employers: 'seen write unavailable' },
    });

    await expect(upsertSeenEmployers([{
      client_user_id: 'client-1', hh_employer_id: 'hh-1', status: 'skipped',
    }] as never)).rejects.toThrow('seen write unavailable');
  });
});
