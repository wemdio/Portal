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
import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

type CreatedSink = {
  auth: Array<Record<string, unknown>>;
  /** Updates applied to profiles via .update().eq('id', ...) */
  profileUpdates: Array<{ id: string; patch: Record<string, unknown> }>;
  tariffs: Array<Record<string, unknown>>;
};

type MockedAdmin = {
  __created: CreatedSink;
  auth: {
    admin: {
      createUser: jest.Mock;
    };
  };
  from: (table: string) => {
    insert?: jest.Mock;
    update?: jest.Mock;
  };
};

jest.mock('@/lib/supabaseAdmin', () => {
  const created: CreatedSink = { auth: [], profileUpdates: [], tariffs: [] };
  const mock = {
    __created: created,
    auth: {
      admin: {
        createUser: jest.fn(
          async (params: { email: string; password: string; user_metadata?: Record<string, unknown> }) => {
            created.auth.push(params);
            return { data: { user: { id: 'user-123', email: params.email } }, error: null };
          },
        ),
      },
    },
    from: (table: string) => {
      if (table === 'profiles') {
        // /api/signup использует .update().eq() — мокаем именно эту цепочку.
        return {
          update: jest.fn((patch: Record<string, unknown>) => ({
            eq: jest.fn(async (_col: string, id: string) => {
              created.profileUpdates.push({ id, patch });
              return { error: null };
            }),
          })),
        };
      }
      if (table === 'client_tariffs') {
        return {
          insert: jest.fn(async (row: Record<string, unknown>) => {
            created.tariffs.push(row);
            return { error: null };
          }),
        };
      }
      return {
        insert: jest.fn(async () => ({ error: null })),
        update: jest.fn(() => ({ eq: jest.fn(async () => ({ error: null })) })),
      };
    },
  };
  return { supabaseAdmin: mock };
});

function makeReq(body: Record<string, unknown>): NextRequest {
  return new Request('http://localhost/api/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe('POST /api/signup', () => {
  it('rejects missing email', async () => {
    const res = await POST(makeReq({ password: 'longenough123' }));
    expect(res.status).toBe(400);
  });

  it('rejects too-short password', async () => {
    const res = await POST(makeReq({ email: 'a@b.com', password: 'short' }));
    expect(res.status).toBe(400);
  });

  it('creates auth user with user_metadata.role=client + sets profile.role + creates inactive tariff', async () => {
    const res = await POST(makeReq({ email: 'new@user.com', password: 'longenough123' }));
    expect(res.status).toBe(201);
    const c = (supabaseAdmin as unknown as MockedAdmin).__created;

    expect(c.auth.length).toBeGreaterThanOrEqual(1);
    expect(c.auth.at(-1)).toMatchObject({ user_metadata: { role: 'client' } });

    expect(c.profileUpdates.length).toBeGreaterThanOrEqual(1);
    expect(c.profileUpdates.at(-1)).toMatchObject({ id: 'user-123', patch: { role: 'client', locale: 'ru' } });

    expect(c.tariffs.length).toBeGreaterThanOrEqual(1);
    expect(c.tariffs.at(-1)).toMatchObject({ user_id: 'user-123', is_active: false, tariff_type: 'standard' });
  });
});
