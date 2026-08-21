/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const ADMIN_ID = '00000000-0000-4000-8000-000000000203';
const PROJECT_ID = '00000000-0000-4000-8000-000000000221';

let mockDb: MockSupabaseClient = createMockSupabase();
let mockRole: 'admin' | 'specialist' = 'admin';
const mockLogAudit = jest.fn(async (..._args: unknown[]) => {});

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: jest.fn(async () => ({
    auth: { supabase: mockDb, userId: ADMIN_ID, role: mockRole },
  })),
}));

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (
    _options: unknown,
    handler: (trace: { end: () => Promise<void>; fail: () => Promise<void> }) => Promise<unknown>,
  ) => handler({ end: async () => {}, fail: async () => {} }),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
  logError: jest.fn(async () => {}),
}));

import { GET as GET_CANDIDATES } from '@/app/api/tools/vertical-engine-v2/legacy/candidates/route';
import { POST as POST_LINK } from '@/app/api/tools/vertical-engine-v2/legacy/links/route';
import { DELETE as DELETE_LINK } from '@/app/api/tools/vertical-engine-v2/legacy/links/[id]/route';

function request(path: string, method = 'GET', body?: unknown): NextRequest {
  return new Request(`http://x/api/tools/vertical-engine-v2/legacy${path}`, {
    method,
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  mockRole = 'admin';
  mockLogAudit.mockClear();
  mockDb = createMockSupabase({
    tables: {
      he_projects: [
        {
          id: PROJECT_ID,
          created_by: ADMIN_ID,
          name: 'Legacy internal candidate',
          website_url: 'https://legacy.example/',
          status: 'researched',
        },
      ],
      ve_legacy_project_links: [],
    },
  });
});

it('lets an admin review candidates and records linked state', async () => {
  const response = await GET_CANDIDATES(request('/candidates'));
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    candidates: Array<{ id: string; linked: boolean }>;
  };
  expect(body.candidates).toEqual([
    expect.objectContaining({ id: PROJECT_ID, linked: false }),
  ]);
});

it('forbids non-admin users from approving legacy links', async () => {
  mockRole = 'specialist';
  const response = await POST_LINK(
    request('/links', 'POST', {
      legacy_he_project_id: PROJECT_ID,
      review_notes: 'Looks internal',
      backfill_batch_id: 'manual-1',
    }),
  );
  expect(response.status).toBe(403);
  expect(mockDb.mutations).toHaveLength(0);
});

it('creates an audited, reversible link without mutating he_projects', async () => {
  const response = await POST_LINK(
    request('/links', 'POST', {
      legacy_he_project_id: PROJECT_ID,
      review_notes: 'Confirmed internal project',
      backfill_batch_id: 'manual-1',
    }),
  );
  expect(response.status).toBe(201);
  expect(mockDb.getRows('ve_legacy_project_links')).toEqual([
    expect.objectContaining({
      legacy_he_project_id: PROJECT_ID,
      verified_by: ADMIN_ID,
      review_notes: 'Confirmed internal project',
      backfill_batch_id: 'manual-1',
    }),
  ]);
  expect(mockDb.mutations.map((call) => call.table)).toEqual([
    've_legacy_project_links',
  ]);
  expect(mockLogAudit).toHaveBeenCalled();

  const deleteResponse = await DELETE_LINK(request(`/links/${PROJECT_ID}`, 'DELETE'), {
    params: Promise.resolve({ id: PROJECT_ID }),
  });
  expect(deleteResponse.status).toBe(200);
  expect(mockDb.getRows('ve_legacy_project_links')).toHaveLength(0);
  expect(mockDb.getRows('he_projects')).toHaveLength(1);
  expect(mockLogAudit).toHaveBeenCalledTimes(2);
});
