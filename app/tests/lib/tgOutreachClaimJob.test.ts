jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: jest.fn() },
}));

jest.mock('@/lib/tgOutreach/campaignLoop', () => ({
  runCampaignLoop: jest.fn().mockResolvedValue(undefined),
  refetchEmptyDialogs: jest.fn().mockResolvedValue(undefined),
}));

import { claimJob, CONTROL_ACTIONS, START_ACTIONS } from '../../worker/tgOutreach';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

type JobRow = { id: string; campaign_id: string; action: string; status: string };

function makeDb(jobRows: JobRow[]) {
  const updates: Array<{ table: string; data: Record<string, unknown>; filters: Record<string, unknown> }> = [];

  const from = jest.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    let mode: 'select' | 'update' = 'select';
    let updateData: Record<string, unknown> = {};

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, val: unknown) => { filters[col] = val; return builder; },
      in: (col: string, val: unknown) => { filters[col] = val; return builder; },
      order: () => builder,
      limit: () => builder,
      update: (data: Record<string, unknown>) => {
        mode = 'update';
        updateData = data;
        return builder;
      },
      maybeSingle: async () => {
        if (mode === 'update') {
          // Claim update: mutate matching row in place, return updated.
          const idx = jobRows.findIndex(
            r => r.id === filters.id && r.status === filters.status,
          );
          if (idx === -1) return { data: null, error: null };
          jobRows[idx] = { ...jobRows[idx], ...(updateData as Partial<JobRow>) } as JobRow;
          updates.push({ table, data: updateData, filters: { ...filters } });
          return { data: { id: jobRows[idx].id, campaign_id: jobRows[idx].campaign_id, action: jobRows[idx].action }, error: null };
        }
        // Select maybeSingle: return first pending row matching filters.
        const inActions = Array.isArray(filters.action) ? (filters.action as string[]) : null;
        const match = jobRows.find(r => {
          if (r.status !== filters.status) return false;
          if (inActions && !inActions.includes(r.action)) return false;
          return true;
        });
        return { data: match ?? null, error: null };
      },
    };
    return builder;
  });

  (supabaseAdmin!.from as jest.Mock).mockImplementation(from);
  return { from, updates };
}

describe('worker tgOutreach claimJob priority', () => {
  it('claims a control job (stop) even when a start job was queued earlier', async () => {
    // Регрессия: инцидент 29.07.2026 — 5 running-кампаний, оператор жмёт «Стоп»,
    // но при concurrency=5/5 старый pollOnce вообще не заглядывал в очередь.
    // Теперь control-джобы подбираются отдельным claim, независимо от лимита.
    const { updates } = makeDb([
      { id: 'start-old', campaign_id: 'c1', action: 'start', status: 'pending' },
      { id: 'stop-fresh', campaign_id: 'c2', action: 'stop', status: 'pending' },
    ]);

    const control = await claimJob(CONTROL_ACTIONS);

    expect(control?.id).toBe('stop-fresh');
    expect(control?.action).toBe('stop');
    // Убедились, что update пометил именно stop-джоб как running.
    expect(updates).toHaveLength(1);
    expect(updates[0].filters.id).toBe('stop-fresh');
  });

  it('returns null from control-claim when only start jobs are pending', async () => {
    makeDb([
      { id: 'start-1', campaign_id: 'c1', action: 'start', status: 'pending' },
    ]);

    const control = await claimJob(CONTROL_ACTIONS);
    expect(control).toBeNull();
  });

  it('claims start jobs when explicitly requested via START_ACTIONS filter', async () => {
    makeDb([
      { id: 'start-1', campaign_id: 'c1', action: 'start', status: 'pending' },
    ]);

    const startJob = await claimJob(START_ACTIONS);
    expect(startJob?.id).toBe('start-1');
    expect(startJob?.action).toBe('start');
  });

  it('does not claim stop when START_ACTIONS filter is applied', async () => {
    makeDb([
      { id: 'stop-1', campaign_id: 'c1', action: 'stop', status: 'pending' },
    ]);

    const startJob = await claimJob(START_ACTIONS);
    expect(startJob).toBeNull();
  });

  it('returns null when queue is empty', async () => {
    makeDb([]);

    const control = await claimJob(CONTROL_ACTIONS);
    const startJob = await claimJob(START_ACTIONS);
    expect(control).toBeNull();
    expect(startJob).toBeNull();
  });
});
