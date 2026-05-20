/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '../helpers/mockSupabase';

let mockInstantlyDb: MockSupabaseClient | null;
let mockMainDb: MockSupabaseClient | null;

jest.mock('server-only', () => ({}), { virtual: true });

jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return mockInstantlyDb;
  },
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockMainDb;
  },
}));

jest.mock('@/lib/instantly/client', () => ({
  getCampaignAnalytics: jest.fn(),
}));

jest.mock('@/lib/tools/autoReportBuilder', () => ({
  iterateInstantlyCampaignPages: jest.fn(),
}));

describe('upsertInstantlyCatalogFromCampaign', () => {
  beforeEach(() => {
    jest.resetModules();
    mockInstantlyDb = createMockSupabase({ tables: { instantly_campaign_catalog: [] } });
    mockMainDb = createMockSupabase();
  });

  it('stores portal-created campaigns under the main Instantly account by default', async () => {
    const { upsertInstantlyCatalogFromCampaign } = await import('@/lib/tools/instantlyCampaignCatalog');

    await upsertInstantlyCatalogFromCampaign({ id: 'cmp-main', name: 'Main campaign', status: 1 });

    expect(mockInstantlyDb!.upserts).toContainEqual(
      expect.objectContaining({
        table: 'instantly_campaign_catalog',
        onConflict: 'id',
        rows: [
          expect.objectContaining({
            id: 'cmp-main',
            instantly_account_id: 'main',
          }),
        ],
      }),
    );
  });

  it('stores portal-created campaigns under the selected Instantly account', async () => {
    const { upsertInstantlyCatalogFromCampaign } = await import('@/lib/tools/instantlyCampaignCatalog');

    await upsertInstantlyCatalogFromCampaign(
      { id: 'cmp-client-b', name: 'Client B campaign', status: 1 },
      'client-b',
    );

    expect(mockInstantlyDb!.upserts).toContainEqual(
      expect.objectContaining({
        table: 'instantly_campaign_catalog',
        onConflict: 'id',
        rows: [
          expect.objectContaining({
            id: 'cmp-client-b',
            instantly_account_id: 'client-b',
          }),
        ],
      }),
    );
  });
});
