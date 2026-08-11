/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

const ALINA_ID = '33dec504-e6e0-4b0a-bc59-dcf570c6ecc9';
const SERGEY_ID = '66873c8c-ae56-4ab2-afa5-5e77dcda391d';
const LEAD_ID = '00000000-0000-4000-8000-000000000001';
const DIRECTOR_ID = '00000000-0000-4000-8000-000000000002';
const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000010';
const REQUEST_ID = '00000000-0000-4000-8000-000000000030';
const REVIEW_ID = '00000000-0000-4000-8000-000000000040';
const UPDATED_AT = '2026-08-11T08:00:00.000Z';

const routePath = path.resolve(
  __dirname,
  '../../src/app/api/team/review-requests/[id]/convert/route.ts',
);
const PRIVATE_USERS = new Set([ALINA_ID, SERGEY_ID]);

type RpcError = { message: string; code?: string; details?: string };
type RpcResult = { data: unknown; error: RpcError | null };

let mockMainDb: MockSupabaseClient = createMockSupabase();
let mockCurrentUser: { id: string } | null = { id: ALINA_ID };
let conversionError: RpcError | null = null;
const mockGetUser = jest.fn(async () => ({ data: { user: mockCurrentUser }, error: null }));
const mockRpc = jest.fn(
  async (functionName: string, args?: Record<string, unknown>): Promise<RpcResult> => {
    if (functionName === 'can_access_team') {
      return {
        data: Boolean(mockCurrentUser && PRIVATE_USERS.has(mockCurrentUser.id)),
        error: null,
      };
    }
    if (functionName !== 'convert_team_review_request') {
      return { data: null, error: { message: `unexpected RPC ${functionName}` } };
    }
    if (conversionError) return { data: null, error: conversionError };

    const requestId = String(args?.p_request_id ?? '');
    const existing = mockMainDb.getRows('team_review_requests')
      .find((row) => row.id === requestId);
    if (!existing) return { data: null, error: { code: 'P0002', message: 'not found' } };

    await mockMainDb.from('employee_reviews').insert({
      id: REVIEW_ID,
      review_date: args?.p_review_date,
      employee_user_id: existing.employee_user_id,
      candidate_name: null,
      reviewer_user_id: mockCurrentUser?.id ?? null,
      status: 'scheduled',
      reason: args?.p_review_reason ?? null,
      outcomes: null,
      problems: null,
      recommendations: null,
      created_at: '2026-08-11T09:00:00.000Z',
      updated_at: '2026-08-11T09:00:00.000Z',
    });
    await mockMainDb
      .from('team_review_requests')
      .update({
        state: 'converted',
        linked_review_id: REVIEW_ID,
        resolved_by: mockCurrentUser?.id ?? null,
        resolved_at: '2026-08-11T09:00:00.000Z',
        updated_by: mockCurrentUser?.id ?? null,
        updated_at: '2026-08-11T09:00:00.000Z',
      })
      .eq('id', requestId);

    return {
      data: { request_id: requestId, review_id: REVIEW_ID },
      error: null,
    };
  },
);
const mockLogAudit = jest.fn(async (..._args: unknown[]) => {});
const mockLogError = jest.fn(async (..._args: unknown[]) => {});

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockMainDb;
  },
}));

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: (header: string | null) => header?.replace(/^Bearer\s+/i, '') || null,
  createAuthedSupabaseClient: () => ({
    auth: { getUser: () => mockGetUser() },
    rpc: (functionName: string, args?: Record<string, unknown>) => mockRpc(functionName, args),
  }),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
  logError: (...args: unknown[]) => mockLogError(...args),
}));

function seedDatabase() {
  mockMainDb = createMockSupabase({
    tables: {
      profiles: [
        {
          id: EMPLOYEE_ID,
          role: 'technician',
          full_name: 'Анна Ким',
          email: 'anna@example.com',
          avatar_url: null,
          is_demo: false,
        },
        {
          id: ALINA_ID,
          role: 'admin',
          full_name: 'Алина',
          email: 'alina@example.com',
          avatar_url: null,
          is_demo: false,
        },
      ],
      team_review_requests: [
        {
          id: REQUEST_ID,
          employee_user_id: EMPLOYEE_ID,
          requested_by_user_id: LEAD_ID,
          project_id: null,
          problem: 'Нужна помощь с приоритизацией',
          examples: null,
          desired_outcome: 'Зафиксировать план развития',
          state: 'new',
          claimed_by: null,
          claimed_at: null,
          resolved_by: null,
          resolved_at: null,
          linked_review_id: null,
          decision_note: null,
          updated_by: LEAD_ID,
          created_at: UPDATED_AT,
          updated_at: UPDATED_AT,
        },
      ],
      employee_reviews: [],
    },
  });
}

function request(
  body: unknown,
  options: { authenticated?: boolean } = {},
) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.authenticated !== false) headers.set('authorization', 'Bearer test-token');
  return new NextRequest(
    `http://portal.local/api/team/review-requests/${REQUEST_ID}/convert`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  );
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    reviewDate: '2026-08-20',
    reviewReason: 'Обсудить приоритизацию и рабочий ритм',
    expectedUpdatedAt: UPDATED_AT,
    ...overrides,
  };
}

async function loadRoute() {
  expect(fs.existsSync(routePath)).toBe(true);
  return import('@/app/api/team/review-requests/[id]/convert/route');
}

beforeEach(() => {
  jest.resetModules();
  mockCurrentUser = { id: ALINA_ID };
  conversionError = null;
  mockGetUser.mockReset();
  mockGetUser.mockImplementation(async () => ({ data: { user: mockCurrentUser }, error: null }));
  mockRpc.mockClear();
  mockLogAudit.mockClear();
  mockLogError.mockClear();
  seedDatabase();
});

describe('POST /api/team/review-requests/[id]/convert', () => {
  it.each([ALINA_ID, SERGEY_ID])(
    'atomically converts a new request for private user %s',
    async (userId) => {
      mockCurrentUser = { id: userId };
      const { POST } = await loadRoute();

      const response = await POST(
        request(validBody()),
        { params: Promise.resolve({ id: REQUEST_ID }) },
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(mockRpc.mock.calls[0]).toEqual(['can_access_team', undefined]);
      expect(mockRpc.mock.calls[1]).toEqual([
        'convert_team_review_request',
        {
          p_request_id: REQUEST_ID,
          p_review_date: '2026-08-20',
          p_review_reason: 'Обсудить приоритизацию и рабочий ритм',
          p_expected_updated_at: UPDATED_AT,
        },
      ]);
      expect(mockRpc.mock.calls[1]?.[1]).not.toHaveProperty('actorId');
      expect(mockRpc.mock.calls[1]?.[1]).not.toHaveProperty('userId');

      expect(body).toEqual({
        requestId: REQUEST_ID,
        reviewId: REVIEW_ID,
      });
      expect(mockMainDb.selects).toHaveLength(0);

      const reviews = mockMainDb.getRows('employee_reviews');
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toEqual(expect.objectContaining({
        employee_user_id: EMPLOYEE_ID,
        reviewer_user_id: userId,
        status: 'scheduled',
        outcomes: null,
        problems: null,
        recommendations: null,
      }));
      expect(mockMainDb.getRows('team_review_requests')[0]).toEqual(expect.objectContaining({
        state: 'converted',
        linked_review_id: REVIEW_ID,
        resolved_by: userId,
      }));
    },
  );

  it.each([LEAD_ID, DIRECTOR_ID])(
    'denies submit-only user %s before conversion or service-role access',
    async (userId) => {
      mockCurrentUser = { id: userId };
      const { POST } = await loadRoute();

      const response = await POST(
        request(validBody()),
        { params: Promise.resolve({ id: REQUEST_ID }) },
      );

      expect(response.status).toBe(403);
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(mockRpc).toHaveBeenCalledWith('can_access_team', undefined);
      expect(mockMainDb.selects).toHaveLength(0);
      expect(mockMainDb.mutations).toHaveLength(0);
    },
  );

  it('returns 401 for an anonymous caller', async () => {
    mockCurrentUser = null;
    const { POST } = await loadRoute();

    const response = await POST(
      request(validBody(), { authenticated: false }),
      { params: Promise.resolve({ id: REQUEST_ID }) },
    );

    expect(response.status).toBe(401);
    expect(mockMainDb.mutations).toHaveLength(0);
  });

  it.each([
    ['missing review date', validBody({ reviewDate: undefined }), 400],
    ['invalid review date', validBody({ reviewDate: '20.08.2026' }), 400],
    ['long review reason', validBody({ reviewReason: 'r'.repeat(501) }), 400],
    ['missing precondition', validBody({ expectedUpdatedAt: undefined }), 428],
    ['invalid precondition', validBody({ expectedUpdatedAt: 'yesterday' }), 400],
  ])('rejects %s before the conversion RPC', async (_label, body, expectedStatus) => {
    const { POST } = await loadRoute();

    const response = await POST(
      request(body),
      { params: Promise.resolve({ id: REQUEST_ID }) },
    );

    expect(response.status).toBe(expectedStatus);
    expect(mockRpc.mock.calls.filter(([name]) => name === 'convert_team_review_request'))
      .toHaveLength(0);
    expect(mockMainDb.mutations).toHaveLength(0);
  });

  it.each([
    ['stale request', { code: '40001', message: 'review request conflict' }, 409],
    ['terminal request', { code: '23514', message: 'request is already resolved' }, 409],
    ['stale non-employee target', { code: '23514', message: 'target is no longer an employee' }, 409],
    ['missing request', { code: 'P0002', message: 'request not found' }, 404],
  ])('maps %s without creating an orphan review', async (_label, error, expectedStatus) => {
    conversionError = error;
    const { POST } = await loadRoute();

    const response = await POST(
      request(validBody()),
      { params: Promise.resolve({ id: REQUEST_ID }) },
    );

    expect(response.status).toBe(expectedStatus);
    expect(mockMainDb.getRows('employee_reviews')).toHaveLength(0);
    expect(mockMainDb.getRows('team_review_requests')[0]?.state).toBe('new');
  });

  it('fails closed on capability errors before calling the transaction function', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'capability unavailable' } });
    const { POST } = await loadRoute();

    const response = await POST(
      request(validBody()),
      { params: Promise.resolve({ id: REQUEST_ID }) },
    );

    expect(response.status).toBe(500);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockMainDb.mutations).toHaveLength(0);
  });

  it('does not log request or review text in audit context', async () => {
    const { POST } = await loadRoute();

    const response = await POST(
      request(validBody()),
      { params: Promise.resolve({ id: REQUEST_ID }) },
    );

    expect(response.status).toBe(200);
    const serializedAudit = JSON.stringify(mockLogAudit.mock.calls);
    expect(serializedAudit).not.toContain('Нужна помощь с приоритизацией');
    expect(serializedAudit).not.toContain('Обсудить приоритизацию и рабочий ритм');
  });
});
