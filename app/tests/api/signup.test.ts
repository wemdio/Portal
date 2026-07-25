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

// Signup fires a lead alert on success. Mock it so the test never makes a real
// Telegram fetch (the test env loads .env, where the fallback bot token may be set).
jest.mock('@/lib/demoLead/notify', () => ({
  sendDemoLeadTelegramAlert: jest.fn(async () => {}),
}));

import { POST } from '@/app/api/signup/route';
import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sendDemoLeadTelegramAlert } from '@/lib/demoLead/notify';

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

function makeReq(
  body: Record<string, unknown>,
  oosUtm?: string,
  clientLocale?: string,
): NextRequest {
  const req = new Request('http://localhost/api/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  // A plain Request has no NextRequest.cookies; stub the getter the route reads
  // (readSignupUtm → req.cookies.get('oos_utm')). The value mimics what Next hands
  // us AFTER its single URL-decode: the raw JSON string the landing set.
  Object.defineProperty(req, 'cookies', {
    configurable: true,
    value: {
      get: (name: string) => {
        if (name === 'oos_utm' && oosUtm) return { name, value: oosUtm };
        if (name === 'outreachos-client-locale' && clientLocale) {
          return { name, value: clientLocale };
        }
        return undefined;
      },
    },
  });
  return req;
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

  it('rejects missing name', async () => {
    const res = await POST(makeReq({ email: 'a@b.com', password: 'longenough123', company: 'Acme' }));
    expect(res.status).toBe(400);
  });

  it('rejects missing company', async () => {
    const res = await POST(makeReq({ email: 'a@b.com', password: 'longenough123', full_name: 'Иван' }));
    expect(res.status).toBe(400);
  });

  it('creates auth user with role=client + persists contact fields + creates inactive tariff', async () => {
    const res = await POST(makeReq({
      email: 'new@user.com',
      password: 'longenough123',
      full_name: 'Иван Тест',
      company: 'ООО Ромашка',
      phone: '+70000000000',
      telegram: '@ivan',
    }));
    expect(res.status).toBe(201);
    const c = (supabaseAdmin as unknown as MockedAdmin).__created;

    expect(c.auth.length).toBeGreaterThanOrEqual(1);
    expect(c.auth.at(-1)).toMatchObject({ user_metadata: { role: 'client' } });

    expect(c.profileUpdates.length).toBeGreaterThanOrEqual(1);
    expect(c.profileUpdates.at(-1)).toMatchObject({
      id: 'user-123',
      patch: {
        role: 'client',
        locale: 'ru',
        full_name: 'Иван Тест',
        company: 'ООО Ромашка',
        phone: '+70000000000',
        telegram: '@ivan',
      },
    });

    expect(c.tariffs.length).toBeGreaterThanOrEqual(1);
    expect(c.tariffs.at(-1)).toMatchObject({ user_id: 'user-123', is_active: false, tariff_type: 'Запуск' });
  });

  it('captures UTM from the oos_utm cookie → profiles.signup_utm + register alert', async () => {
    // Cookie value = what Next.js hands us after its single URL-decode: the raw JSON
    // string the landing set. Includes a literal '%' (50%off) — exactly the case the
    // old double-decode dropped (URIError → null).
    const cookie = JSON.stringify({
      utm_source: 'outreach', utm_medium: 'email', utm_campaign: '50%off',
      referrer: 'https://mail.example/x', landing: '/?utm_campaign=50%off', ts: '2026-06-30T00:00:00.000Z',
    });
    const res = await POST(makeReq({
      email: 'utm@user.com', password: 'longenough123', full_name: 'Пётр', company: 'ООО Аутрич',
    }, cookie));
    expect(res.status).toBe(201);

    const c = (supabaseAdmin as unknown as MockedAdmin).__created;
    expect(c.profileUpdates.at(-1)?.patch).toMatchObject({
      signup_utm: { utm_source: 'outreach', utm_medium: 'email', utm_campaign: '50%off' },
    });

    const alert = sendDemoLeadTelegramAlert as unknown as jest.Mock;
    const call = alert.mock.calls.find((args) => (args[0] as { email?: string })?.email === 'utm@user.com');
    expect(call).toBeTruthy();
    expect(call?.[0]).toMatchObject({
      source: 'register',
      utm: { utm_campaign: '50%off' },
      referrer: 'https://mail.example/x',
    });
  });

  it.each([
    ['es', 'es'],
    ['de', 'ru'],
  ])('persists locale cookie %s as profile locale %s', async (cookieLocale, expectedLocale) => {
    const res = await POST(makeReq({
      email: `${cookieLocale}@user.com`,
      password: 'longenough123',
      full_name: 'Locale Test',
      company: 'OutreachOS',
    }, undefined, cookieLocale));
    expect(res.status).toBe(201);

    const c = (supabaseAdmin as unknown as MockedAdmin).__created;
    expect(c.profileUpdates.at(-1)?.patch).toMatchObject({ locale: expectedLocale });
  });
});
