/** @jest-environment node */

/**
 * Integration test for POST /api/signup. Mocks Supabase admin client so we
 * test request handling + DB row creation logic without hitting a real DB.
 */

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
  logInfo: jest.fn(async () => {}),
  logWarn: jest.fn(async () => {}),
}));

import { POST } from '@/app/api/signup/route';

jest.mock('@/lib/supabaseAdmin', () => {
  const created: { auth: any[]; profiles: any[]; tariffs: any[] } = { auth: [], profiles: [], tariffs: [] };
  const mock = {
    __created: created,
    auth: {
      admin: {
        createUser: jest.fn(async (params: { email: string; password: string }) => {
          created.auth.push(params);
          return { data: { user: { id: 'user-123', email: params.email } }, error: null };
        }),
      },
    },
    from: (table: string) => ({
      insert: jest.fn(async (row: any) => {
        if (table === 'profiles') created.profiles.push(row);
        if (table === 'client_tariffs') created.tariffs.push(row);
        return { error: null };
      }),
    }),
  };
  return { supabaseAdmin: mock };
});

function makeReq(body: any) {
  return new Request('http://localhost/api/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/signup', () => {
  it('rejects missing email', async () => {
    const res = await POST(makeReq({ password: 'longenough123' }) as any);
    expect(res.status).toBe(400);
  });

  it('rejects too-short password', async () => {
    const res = await POST(makeReq({ email: 'a@b.com', password: 'short' }) as any);
    expect(res.status).toBe(400);
  });

  it('creates user + profile{role:client} + client_tariffs{is_active:false} on valid input', async () => {
    const res = await POST(makeReq({ email: 'new@user.com', password: 'longenough123' }) as any);
    expect(res.status).toBe(201);
    const { supabaseAdmin } = require('@/lib/supabaseAdmin');
    const c = (supabaseAdmin as any).__created;
    expect(c.auth.length).toBeGreaterThanOrEqual(1);
    expect(c.profiles.length).toBeGreaterThanOrEqual(1);
    expect(c.profiles.at(-1)).toMatchObject({ id: 'user-123', role: 'client' });
    expect(c.tariffs.length).toBeGreaterThanOrEqual(1);
    expect(c.tariffs.at(-1)).toMatchObject({ user_id: 'user-123', is_active: false, tariff_type: 'standard' });
  });
});
