/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import { USER_DELETE_HEAVY_JOB_TABLES } from '@/lib/admin/purgeUserOwnedJobs';
import type { NextRequest } from 'next/server';

const ADMIN_USER_ID = '00000000-0000-4000-8000-000000000001';
const TARGET_USER_ID = '00000000-0000-4000-8000-000000000002';
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000003';

type AdminDb = MockSupabaseClient & {
  auth: { admin: { deleteUser: jest.Mock } };
};

let mockDb: AdminDb = createAdminDb();
let actingUserId = ADMIN_USER_ID;

function createAdminDb(seed?: Parameters<typeof createMockSupabase>[0]): AdminDb {
  const db = createMockSupabase(seed);
  const deleteUser = jest.fn(async () => ({ data: { user: {} }, error: null }));
  return Object.assign(db, { auth: { admin: { deleteUser } } });
}

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: () => 'test-token',
  createAuthedSupabaseClient: () => ({
    auth: {
      getUser: jest.fn(async () => ({ data: { user: { id: actingUserId } } })),
    },
  }),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

function seedJobs(options?: { errorTables?: Record<string, string> }) {
  mockDb = createAdminDb({
    tables: {
      profiles: [
        { id: ADMIN_USER_ID, role: 'admin' },
        { id: TARGET_USER_ID, role: 'manager' },
        { id: OTHER_USER_ID, role: 'manager' },
      ],
      email_validation_jobs: [
        { id: 'ev-target', user_id: TARGET_USER_ID },
        { id: 'ev-other', user_id: OTHER_USER_ID },
      ],
      website_enrichment_jobs: [
        { id: 'we-target', user_id: TARGET_USER_ID },
        { id: 'we-other', user_id: OTHER_USER_ID },
      ],
      yandex_maps_jobs: [
        { id: 'ym-target', user_id: TARGET_USER_ID },
        { id: 'ym-other', user_id: OTHER_USER_ID },
      ],
      search_parser_jobs: [
        { id: 'sp-target', user_id: TARGET_USER_ID },
        { id: 'sp-other', user_id: OTHER_USER_ID },
      ],
    },
    errorTables: options?.errorTables,
  });
}

function makeRequest(userId: string): NextRequest {
  return new Request(`http://x/api/admin/users/${userId}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer test-token' },
  }) as unknown as NextRequest;
}

async function del(userId: string) {
  const { DELETE } = await import('@/app/api/admin/users/[id]/route');
  const response = await DELETE(makeRequest(userId), {
    params: Promise.resolve({ id: userId }),
  });
  if (!response) throw new Error('admin users DELETE returned no response');
  return response;
}

function ids(table: string): string[] {
  return mockDb.getRows(table).map((row) => String(row.id)).sort();
}

beforeEach(() => {
  jest.resetModules();
  actingUserId = ADMIN_USER_ID;
  seedJobs();
});

describe('DELETE /api/admin/users/[id]', () => {
  it('purges the target user’s heavy jobs before GoTrue deleteUser and leaves other users’ jobs', async () => {
    const response = await del(TARGET_USER_ID);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    expect(ids('email_validation_jobs')).toEqual(['ev-other']);
    expect(ids('website_enrichment_jobs')).toEqual(['we-other']);
    expect(ids('yandex_maps_jobs')).toEqual(['ym-other']);
    expect(ids('search_parser_jobs')).toEqual(['sp-other']);

    const deletedTables = mockDb.mutations
      .filter((mutation) => mutation.kind === 'delete')
      .map((mutation) => mutation.table);
    expect(deletedTables).toEqual(expect.arrayContaining([...USER_DELETE_HEAVY_JOB_TABLES]));

    expect(mockDb.auth.admin.deleteUser).toHaveBeenCalledTimes(1);
    expect(mockDb.auth.admin.deleteUser).toHaveBeenCalledWith(TARGET_USER_ID);
  });

  it('does not call deleteUser when a heavy job table cannot be purged', async () => {
    seedJobs({ errorTables: { yandex_maps_jobs: 'db blip' } });

    const response = await del(TARGET_USER_ID);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Ошибка удаления пользователя' });
    expect(mockDb.auth.admin.deleteUser).not.toHaveBeenCalled();
    expect(ids('email_validation_jobs')).toContain('ev-other');
    expect(ids('website_enrichment_jobs')).toContain('we-other');
    expect(ids('search_parser_jobs')).toContain('sp-other');
  });

  it('still deletes a user who has no heavy jobs', async () => {
    mockDb = createAdminDb({
      tables: {
        profiles: [{ id: ADMIN_USER_ID, role: 'admin' }],
        email_validation_jobs: [],
        website_enrichment_jobs: [],
        yandex_maps_jobs: [],
        search_parser_jobs: [],
      },
    });

    const response = await del(TARGET_USER_ID);

    expect(response.status).toBe(200);
    expect(mockDb.auth.admin.deleteUser).toHaveBeenCalledWith(TARGET_USER_ID);
  });

  it('rejects deleting yourself', async () => {
    const response = await del(ADMIN_USER_ID);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Нельзя удалить самого себя' });
    expect(mockDb.auth.admin.deleteUser).not.toHaveBeenCalled();
  });
});
