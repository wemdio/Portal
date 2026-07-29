jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: jest.fn() },
}));

jest.mock('@/lib/ai-caller/campaignLoop', () => ({
  resetStuckContacts: jest.fn().mockResolvedValue(undefined),
  runCampaignLoop: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/tgOutreach/campaignLoop', () => ({
  runCampaignLoop: jest.fn().mockResolvedValue(undefined),
  refetchEmptyDialogs: jest.fn().mockResolvedValue(undefined),
}));

import { resumeRunningCampaigns as resumeAiCampaigns } from '../../worker/aiCaller';
import { resumeRunningCampaigns as resumeTgCampaigns } from '../../worker/tgOutreach';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

type JobRow = { id: string; campaign_id: string; action: string; status: string; user_id?: string };
type CampaignRow = { id: string; user_id?: string };

function makeDb(campaignRows: CampaignRow[], jobRows: JobRow[]) {
  const inserts: Array<{ table: string; data: unknown }> = [];
  const updates: Array<{ table: string; data: Record<string, unknown> }> = [];

  const from = jest.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    let rowLimit: number | undefined;
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return builder;
      },
      in: (col: string, val: unknown) => {
        filters[col] = val;
        return builder;
      },
      limit: (val: number) => {
        rowLimit = val;
        return builder;
      },
      update: (data: Record<string, unknown>) => {
        updates.push({ table, data });
        return builder;
      },
      insert: (data: unknown) => {
        inserts.push({ table, data });
        return builder;
      },
      then: (resolve: (value: unknown) => void) => {
        if (table === 'ai_campaigns' || table === 'tg_outreach_campaigns') {
          resolve({ data: campaignRows, error: null });
          return;
        }
        resolve({ data: jobRows, error: null });
      },
      maybeSingle: async () => {
        let matching = jobRows.filter((row) => {
          if (row.campaign_id !== filters.campaign_id) return false;
          if (filters.action && row.action !== filters.action) return false;
          const statusFilter = filters.status as string[] | undefined;
          if (statusFilter && !statusFilter.includes(row.status)) return false;
          return true;
        });
        if (rowLimit !== undefined) matching = matching.slice(0, rowLimit);
        if (matching.length > 1) {
          return {
            data: null,
            error: { code: 'PGRST116', message: 'JSON object requested, multiple rows returned' },
          };
        }
        return { data: matching[0] ?? null, error: null };
      },
      single: async () => ({ data: null, error: null }),
    };
    return builder;
  });

  (supabaseAdmin!.from as jest.Mock).mockImplementation(from);

  return { from, inserts, updates };
}

describe('worker resumeRunningCampaigns', () => {
  it('AI Caller auto-resumes even if only non-start jobs exist', async () => {
    const { from, inserts } = makeDb(
      [{ id: 'camp-1', user_id: 'user-1' }],
      [{ id: 'job-1', campaign_id: 'camp-1', action: 'stop', status: 'pending' }],
    );

    await resumeAiCampaigns();

    expect(from).toHaveBeenCalledWith('ai_campaigns');
    expect(from).toHaveBeenCalledWith('ai_caller_jobs');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toEqual(
      expect.objectContaining({
        table: 'ai_caller_jobs',
        data: expect.objectContaining({ campaign_id: 'camp-1', action: 'start', status: 'pending' }),
      }),
    );
  });

  it('TG Outreach auto-resumes even if only non-start jobs exist', async () => {
    const { from, inserts } = makeDb(
      [{ id: 'camp-1', user_id: 'user-1' }],
      [{ id: 'job-1', campaign_id: 'camp-1', action: 'restart', status: 'pending' }],
    );

    await resumeTgCampaigns();

    expect(from).toHaveBeenCalledWith('tg_outreach_campaigns');
    expect(from).toHaveBeenCalledWith('tg_outreach_jobs');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toEqual(
      expect.objectContaining({
        table: 'tg_outreach_jobs',
        data: expect.objectContaining({ campaign_id: 'camp-1', action: 'start', status: 'pending' }),
      }),
    );
  });

  it('does not queue duplicate AI Caller start jobs when one already exists', async () => {
    const { inserts } = makeDb(
      [{ id: 'camp-1', user_id: 'user-1' }],
      [{ id: 'job-1', campaign_id: 'camp-1', action: 'start', status: 'pending' }],
    );

    await resumeAiCampaigns();

    expect(inserts).toHaveLength(0);
  });

  it('does not queue another TG Outreach start job when duplicates already exist', async () => {
    const { inserts } = makeDb(
      [{ id: 'camp-1', user_id: 'user-1' }],
      [
        { id: 'job-1', campaign_id: 'camp-1', action: 'start', status: 'running' },
        { id: 'job-2', campaign_id: 'camp-1', action: 'start', status: 'pending' },
      ],
    );

    await resumeTgCampaigns();

    expect(inserts).toHaveLength(0);
  });
});
