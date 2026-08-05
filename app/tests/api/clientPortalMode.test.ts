/** @jest-environment node */

/**
 * GET /api/client/portal-mode — помимо режима ('manual'|'auto') отдаёт
 * profiles.market ('ru'|'eng'), чтобы /client/layout мог развести навигацию
 * по рынкам: eng видит только ENG-кабинет, ru — всё кроме ENG.
 */

let mockUser: { id: string } | null = { id: 'u-1' };
let mockProfile: Record<string, unknown> | null = null;

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: (h: string | null) => (h?.startsWith('Bearer ') ? h.slice(7) : null),
  createAuthedSupabaseClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: mockUser }, error: null }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: mockProfile, error: null }),
        }),
      }),
    }),
  }),
}));

jest.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: null }));

import type { NextRequest } from 'next/server';
import { GET } from '@/app/api/client/portal-mode/route';

function makeReq(auth = true): NextRequest {
  return new Request('http://x/api/client/portal-mode', {
    headers: auth ? { authorization: 'Bearer test-token' } : {},
  }) as unknown as NextRequest;
}

beforeEach(() => {
  mockUser = { id: 'u-1' };
  mockProfile = null;
});

describe('GET /api/client/portal-mode — market', () => {
  it('401 без токена', async () => {
    const res = await GET(makeReq(false));
    expect(res.status).toBe(401);
  });

  it('отдаёт market=eng из profiles', async () => {
    mockProfile = { auto_pipeline_enabled: false, market: 'eng' };
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode?: string; market?: string };
    expect(body.mode).toBe('manual');
    expect(body.market).toBe('eng');
  });

  it('market отсутствует в profiles (старая строка) → ru', async () => {
    mockProfile = { auto_pipeline_enabled: false };
    const res = await GET(makeReq());
    const body = (await res.json()) as { market?: string };
    expect(body.market).toBe('ru');
  });

  it('market=ru отдаётся как ru', async () => {
    mockProfile = { auto_pipeline_enabled: false, market: 'ru' };
    const res = await GET(makeReq());
    const body = (await res.json()) as { market?: string };
    expect(body.market).toBe('ru');
  });
});
