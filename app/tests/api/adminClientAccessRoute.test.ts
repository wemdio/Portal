/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const ADMIN_USER_ID = '00000000-0000-4000-8000-000000000001';
const TARGET_USER_ID = '00000000-0000-4000-8000-000000000002';
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000003';

let mockMainDb: MockSupabaseClient = createMockSupabase();
let mockInstantlyDb: MockSupabaseClient = createMockSupabase();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockMainDb;
  },
}));

jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return mockInstantlyDb;
  },
}));

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: () => 'test-token',
  createAuthedSupabaseClient: () => ({
    auth: {
      getUser: jest.fn(async () => ({ data: { user: { id: ADMIN_USER_ID } } })),
    },
  }),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

function accessRow(overrides: Record<string, unknown>) {
  return {
    id: 'access-default',
    client_user_id: TARGET_USER_ID,
    resource_type: 'campaign',
    resource_id: 'campaign-a',
    instantly_account_id: 'account-2',
    created_by: 'original-admin',
    created_at: '2026-06-01T00:00:00.000Z',
    leads_synced_at: '2026-07-20T10:00:00.000Z',
    ...overrides,
  };
}

function seedDatabases() {
  mockMainDb = createMockSupabase({
    tables: {
      profiles: [{ id: ADMIN_USER_ID, role: 'admin' }],
    },
  });
  mockInstantlyDb = createMockSupabase({
    tables: {
      client_instantly_access: [
        accessRow({ id: 'access-a', resource_id: 'campaign-a', instantly_account_id: 'account-2' }),
        accessRow({
          id: 'access-b',
          resource_id: 'campaign-b',
          instantly_account_id: 'main',
          leads_synced_at: '2026-07-19T10:00:00.000Z',
        }),
        accessRow({
          id: 'lead-list-access',
          resource_type: 'lead_list',
          resource_id: 'lead-list-1',
          instantly_account_id: 'account-2',
        }),
        accessRow({
          id: 'other-client-access',
          client_user_id: OTHER_USER_ID,
          resource_id: 'campaign-other',
          instantly_account_id: 'account-2',
        }),
      ],
      instantly_campaign_catalog: [
        { id: 'campaign-a', name: 'A', instantly_account_id: 'account-2' },
        { id: 'campaign-b', name: 'B', instantly_account_id: 'main' },
        { id: 'campaign-c', name: 'C', instantly_account_id: 'account-2' },
      ],
    },
  });
}

function makePutRequest(campaigns: unknown, baselineCampaigns: unknown): NextRequest {
  return new Request(`http://x/api/admin/users/${TARGET_USER_ID}/client-access`, {
    method: 'PUT',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ campaigns, baselineCampaigns }),
  }) as unknown as NextRequest;
}

async function put(campaigns: unknown, baselineCampaigns: unknown = ['campaign-a', 'campaign-b']) {
  const { PUT } = await import('@/app/api/admin/users/[id]/client-access/route');
  const response = await PUT(makePutRequest(campaigns, baselineCampaigns), {
    params: Promise.resolve({ id: TARGET_USER_ID }),
  });
  if (!response) throw new Error('client-access PUT returned no response');
  return response;
}

function sortedAccessRows() {
  return mockInstantlyDb
    .getRows('client_instantly_access')
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

beforeEach(() => {
  jest.resetModules();
  seedDatabases();
});

describe('PUT /api/admin/users/[id]/client-access', () => {
  it('is a no-op for unchanged campaigns and preserves workspace plus sync metadata', async () => {
    const before = sortedAccessRows();

    const response = await put(['campaign-a', 'campaign-b']);

    expect(response.status).toBe(200);
    expect(sortedAccessRows()).toEqual(before);
    expect(mockInstantlyDb.inserts).toHaveLength(0);
  });

  it('applies only the campaign delta, preserving non-campaign and other-client access', async () => {
    const response = await put([' campaign-a ', 'campaign-c', 'campaign-c']);

    expect(response.status).toBe(200);
    const rows = sortedAccessRows();
    expect(rows).toHaveLength(4);
    expect(
      rows
        .filter((row) => row.client_user_id === TARGET_USER_ID && row.resource_type === 'campaign')
        .map((row) => row.resource_id)
        .sort(),
    ).toEqual(['campaign-a', 'campaign-c']);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'access-a',
          client_user_id: TARGET_USER_ID,
          resource_type: 'campaign',
          resource_id: 'campaign-a',
          instantly_account_id: 'account-2',
          leads_synced_at: '2026-07-20T10:00:00.000Z',
        }),
        expect.objectContaining({
          client_user_id: TARGET_USER_ID,
          resource_type: 'campaign',
          resource_id: 'campaign-c',
          instantly_account_id: 'account-2',
          created_by: ADMIN_USER_ID,
        }),
        expect.objectContaining({
          id: 'lead-list-access',
          client_user_id: TARGET_USER_ID,
          resource_type: 'lead_list',
          resource_id: 'lead-list-1',
          instantly_account_id: 'account-2',
        }),
        expect.objectContaining({
          id: 'other-client-access',
          client_user_id: OTHER_USER_ID,
          resource_id: 'campaign-other',
        }),
      ]),
    );
    expect(rows).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ resource_id: 'campaign-b' })]),
    );
  });

  it('rejects a new campaign missing from the catalog before changing any access', async () => {
    const before = sortedAccessRows();

    const response = await put(['campaign-a', 'campaign-unknown']);

    expect(response.status).toBe(400);
    expect(sortedAccessRows()).toEqual(before);
    expect(mockInstantlyDb.inserts).toHaveLength(0);
  });

  it('rejects a stale baseline before changing access', async () => {
    const before = sortedAccessRows();

    const response = await put(['campaign-a'], ['campaign-a']);

    expect(response.status).toBe(409);
    expect(sortedAccessRows()).toEqual(before);
    expect(mockInstantlyDb.inserts).toHaveLength(0);
  });

  it('rejects malformed campaign input before changing access', async () => {
    const before = sortedAccessRows();

    const response = await put(null);

    expect(response.status).toBe(400);
    expect(sortedAccessRows()).toEqual(before);
    expect(mockInstantlyDb.inserts).toHaveLength(0);
  });
});
