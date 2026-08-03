/** @jest-environment node */

/**
 * resolveClientInstantlyRequestOptions — единая точка резолва Instantly-аккаунта
 * клиента из client_campaign_presets (та же строка, что читает
 * appendLeadsToClientCampaign). Пресета/аккаунта нет → дефолтный 'main'.
 */

jest.mock('server-only', () => ({}));

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

let mockInstantlyDb: MockSupabaseClient = createMockSupabase();

jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return mockInstantlyDb;
  },
}));

import { resolveClientInstantlyRequestOptions } from '@/lib/instantly/clientAccountOptions';

const USER_ID = 'user-1';

beforeEach(() => {
  mockInstantlyDb = createMockSupabase({ tables: {} });
});

it('preset с instantly_account_id → accountId из пресета (нормализованный)', async () => {
  mockInstantlyDb = createMockSupabase({
    tables: {
      client_campaign_presets: [
        { client_user_id: USER_ID, instantly_account_id: 'Sales Acc 2' },
      ],
    },
  });
  const opts = await resolveClientInstantlyRequestOptions(USER_ID);
  expect(opts.accountId).toBe('sales-acc-2');
});

it('preset другого клиента не подхватывается → дефолтный main', async () => {
  mockInstantlyDb = createMockSupabase({
    tables: {
      client_campaign_presets: [
        { client_user_id: 'someone-else', instantly_account_id: 'foreign-acc' },
      ],
    },
  });
  const opts = await resolveClientInstantlyRequestOptions(USER_ID);
  expect(opts.accountId).toBe('main');
});

it('нет пресета → дефолтный main', async () => {
  const opts = await resolveClientInstantlyRequestOptions(USER_ID);
  expect(opts.accountId).toBe('main');
});

it('preset без instantly_account_id (null) → дефолтный main', async () => {
  mockInstantlyDb = createMockSupabase({
    tables: {
      client_campaign_presets: [{ client_user_id: USER_ID, instantly_account_id: null }],
    },
  });
  const opts = await resolveClientInstantlyRequestOptions(USER_ID);
  expect(opts.accountId).toBe('main');
});
