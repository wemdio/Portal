/** @jest-environment node */

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';

const mockActivateCampaign = jest.fn();

jest.mock('@/lib/instantly/client', () => ({
  activateCampaign: (...args: unknown[]) => mockActivateCampaign(...args),
  getCampaign: jest.fn(),
}));

import { activateApprovedLaunchCampaigns } from '@/lib/verticalEngineV2/contactDeliveryActivation';

import { activateVeLaunchPortfolioItem } from '@/lib/verticalEngineV2/launchActivation';

const STAFF_LINE_ID = '837cbcb1-9afb-49c9-965c-d83d1e7d8e9c';

function approve(project: Record<string, unknown>) {
  return activateApprovedLaunchCampaigns({
    portalDb: createMockSupabase({ tables: { ve_projects: [{ id: 've-project', ...project }] } }) as never,
    veProjectId: 've-project',
    accountId: 'workspace-a',
    campaignIds: ['campaign-1'],
  });
}

beforeEach(() => mockActivateCampaign.mockReset());

describe('approved launch activation', () => {
  it('never starts sending from a bound plan or a stale Portal activation request', async () => {
    await expect(approve({ portal_project_id: STAFF_LINE_ID, portal_period_id: null, target_contacts: 4000 }))
      .resolves.toEqual({ deferred: true });
    const staleRequest = await activateVeLaunchPortfolioItem({ portalDb: {} as never, itemId: 'old-item', actorId: 'user', body: {confirm_campaign_review:true} });
    expect(staleRequest).toMatchObject({status:409,body:{code:'VE_START_IN_INSTANTLY'}});
    expect(mockActivateCampaign).not.toHaveBeenCalled();
  });

  it('still rejects a binding without a target', async () => {
    await expect(approve({ portal_project_id: STAFF_LINE_ID, portal_period_id: null, target_contacts: null }))
      .rejects.toThrow('Привязка плана ежедневной загрузки неполна.');
    await expect(approve({ portal_project_id: null, portal_period_id: 'period-1', target_contacts: 4000 }))
      .rejects.toThrow('Привязка плана ежедневной загрузки неполна.');
    expect(mockActivateCampaign).not.toHaveBeenCalled();
  });
});
