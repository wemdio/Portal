/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const ADMIN_USER_ID = '00000000-0000-4000-8000-000000000001';
const TARGET_USER_ID = '00000000-0000-4000-8000-000000000002';

let actorUserId = ADMIN_USER_ID;
let mockDb: MockSupabaseClient;
const mockGetUserById = jest.fn();
const mockUpdateUserById = jest.fn();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return {
      ...mockDb,
      auth: {
        admin: {
          getUserById: mockGetUserById,
          updateUserById: mockUpdateUserById,
        },
      },
    };
  },
}));

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: () => 'test-token',
  createAuthedSupabaseClient: () => ({
    auth: {
      getUser: jest.fn(async () => ({ data: { user: { id: actorUserId } } })),
    },
  }),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

function seed(options?: {
  actorRole?: string;
  targetDemo?: boolean;
  targetRobot?: boolean;
  rpcError?: string;
}) {
  mockDb = createMockSupabase({
    tables: {
      profiles: [
        { id: ADMIN_USER_ID, role: options?.actorRole ?? 'admin', is_demo: false, is_api_robot: false },
        {
          id: TARGET_USER_ID,
          role: 'manager',
          is_demo: options?.targetDemo ?? false,
          is_api_robot: options?.targetRobot ?? false,
        },
      ],
    },
    rpcHandlers: {
      admin_revoke_user_sessions: () => options?.rpcError
        ? { data: null, error: { message: options.rpcError } }
        : { data: 1 },
    },
  });
}

function request(method: 'GET' | 'POST', body?: unknown): NextRequest {
  return new Request(`http://x/api/admin/users/${TARGET_USER_ID}/block`, {
    method,
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as NextRequest;
}

async function call(method: 'GET' | 'POST', body?: unknown) {
  const route = await import('@/app/api/admin/users/[id]/block/route');
  return route[method](request(method, body), {
    params: Promise.resolve({ id: TARGET_USER_ID }),
  });
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  actorUserId = ADMIN_USER_ID;
  seed();
  mockGetUserById.mockResolvedValue({
    data: { user: { id: TARGET_USER_ID, banned_until: '2126-01-01T00:00:00.000Z' } },
    error: null,
  });
  mockUpdateUserById.mockResolvedValue({ data: { user: { id: TARGET_USER_ID } }, error: null });
});

describe('/api/admin/users/[id]/block', () => {
  it('reports the current blocked status', async () => {
    const response = await call('GET');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      blocked: true,
      bannedUntil: '2126-01-01T00:00:00.000Z',
      protected: false,
    });
  });

  it('blocks a regular user and revokes active sessions', async () => {
    const response = await call('POST', { blocked: true });

    expect(response.status).toBe(200);
    expect(mockUpdateUserById).toHaveBeenCalledWith(TARGET_USER_ID, { ban_duration: '876000h' });
    expect(mockDb.rpcCalls).toContainEqual({
      fn: 'admin_revoke_user_sessions',
      params: { target_user_id: TARGET_USER_ID },
    });
    await expect(response.json()).resolves.toMatchObject({ ok: true, blocked: true });
  });

  it('unblocks a regular user without revoking sessions', async () => {
    const response = await call('POST', { blocked: false });

    expect(response.status).toBe(200);
    expect(mockUpdateUserById).toHaveBeenCalledWith(TARGET_USER_ID, { ban_duration: 'none' });
    expect(mockDb.rpcCalls).toHaveLength(0);
    await expect(response.json()).resolves.toMatchObject({ ok: true, blocked: false });
  });

  it.each([
    ['demo account', { targetDemo: true }],
    ['API robot', { targetRobot: true }],
  ])('refuses to change a protected %s', async (_label, options) => {
    seed(options);

    const response = await call('POST', { blocked: true });

    expect(response.status).toBe(400);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it('refuses to block the acting administrator', async () => {
    actorUserId = TARGET_USER_ID;
    mockDb = createMockSupabase({
      tables: {
        profiles: [{ id: TARGET_USER_ID, role: 'admin', is_demo: false, is_api_robot: false }],
      },
    });

    const response = await call('POST', { blocked: true });

    expect(response.status).toBe(400);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it('rejects non-admin callers', async () => {
    seed({ actorRole: 'manager' });

    const response = await call('POST', { blocked: true });

    expect(response.status).toBe(403);
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });
});
