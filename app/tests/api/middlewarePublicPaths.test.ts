/** @jest-environment node */

/**
 * Пин публичных путей гостевой таблицы лидов в middleware:
 *  - /leads-board/<token> — страница доступна анониму (нет редиректа на /login);
 *  - /api/lead-board/<token> — публичный API (нет 401 staff-gate'а);
 *  - /api/projects/<id>/lead-board — НЕ публичный: 401 анониму (staff-only);
 *  - залогиненный client на /leads-board/ — не редиректится в /client.
 * Потеря любой из трёх allowlist-строк тихо убивает фичу при зелёных тестах —
 * этот файл и есть сторож.
 */

let mockUser: { id: string } | null = null;
let mockRole: string | null = null;
let mockIsDemo = false;
let mockProfileError: { message: string } | null = null;
let mockGetUserError: Error | null = null;

jest.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => {
        if (mockGetUserError) throw mockGetUserError;
        return { data: { user: mockUser }, error: null };
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: mockUser && !mockProfileError
              ? { role: mockRole, locale: 'ru', is_demo: mockIsDemo }
              : null,
            error: mockProfileError,
          }),
        }),
      }),
    }),
  }),
}));

import { NextRequest } from 'next/server';
import { INTERNAL_ROLES } from '@/lib/roles';
import { middleware } from '@/middleware';

function req(path: string, cookies: Record<string, string> = {}) {
  const cookie = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: cookie ? { cookie } : undefined,
  });
}

beforeEach(() => {
  jest.resetModules();
  mockUser = null;
  mockRole = null;
  mockIsDemo = false;
  mockProfileError = null;
  mockGetUserError = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.test';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  delete process.env.MAINTENANCE_MODE;
});

describe('middleware: публичные пути lead-board', () => {
  it('аноним на /leads-board/<token> — пропускается (нет редиректа на /login)', async () => {
    const res = await middleware(req('/leads-board/lb_abc.sig'));
    expect(res.headers.get('location')).toBeNull();
  });

  it('аноним на /api/lead-board/<token> — пропускается (нет 401)', async () => {
    const res = await middleware(req('/api/lead-board/lb_abc.sig'));
    expect(res.status).not.toBe(401);
    expect(res.headers.get('location')).toBeNull();
  });

  it('аноним на /projects/123 — редирект на /login (контроль: staff-gate жив)', async () => {
    const res = await middleware(req('/projects/123'));
    expect(res.headers.get('location')).toContain('/login');
  });

  it('аноним на /api/projects/123/lead-board — 401 (manage API остаётся staff-only)', async () => {
    const res = await middleware(req('/api/projects/123/lead-board'));
    expect(res.status).toBe(401);
  });

  it('залогиненный client на /leads-board/<token> — НЕ редиректится в /client', async () => {
    mockUser = { id: 'u-client' };
    mockRole = 'client';
    const res = await middleware(req('/leads-board/lb_abc.sig'));
    expect(res.headers.get('location')).toBeNull();
  });

  it('залогиненный client на /projects/123 — редирект в /client (контроль)', async () => {
    mockUser = { id: 'u-client' };
    mockRole = 'client';
    const res = await middleware(req('/projects/123'));
    expect(res.headers.get('location')).toContain('/client');
  });
});

function redirectPath(response: Response): string | null {
  const location = response.headers.get('location');
  return location ? new URL(location).pathname : null;
}

describe('middleware: доступ к /team', () => {
  it.each(INTERNAL_ROLES)(
    'пропускает внутреннюю роль %s',
    async (role) => {
      mockUser = { id: `u-${role}` };
      mockRole = role;

      const res = await middleware(req('/team'));

      expect(redirectPath(res)).toBeNull();
    },
  );

  it('does not trust a forged client role cookie over an internal profile', async () => {
    mockUser = { id: 'u-technician' };
    mockRole = 'technician';

    const res = await middleware(req('/team', {
      'x-portal-role': 'u-technician:client',
    }));

    expect(redirectPath(res)).toBeNull();
  });

  it('uses the authoritative profile role instead of a stale role cookie', async () => {
    mockUser = { id: 'u-client' };
    mockRole = 'client';

    const res = await middleware(req('/team', {
      'x-portal-role': 'u-client:lead',
    }));

    expect(redirectPath(res)).toBe('/client');
  });

  it('denies a demo account even when its stored role is leadership', async () => {
    mockUser = { id: 'u-demo-lead' };
    mockRole = 'lead';
    mockIsDemo = true;

    const res = await middleware(req('/team', {
      'x-portal-role': 'u-demo-lead:lead',
    }));

    expect(redirectPath(res)).toBe('/');
  });

  it('fails closed when the authoritative profile lookup fails', async () => {
    mockUser = { id: 'u-lead' };
    mockRole = 'lead';
    mockProfileError = { message: 'profile lookup failed' };

    const res = await middleware(req('/team', {
      'x-portal-role': 'u-lead:lead',
    }));

    expect(redirectPath(res)).toBe('/');
  });
  it('fails closed when authentication verification throws', async () => {
    mockGetUserError = new Error('auth unavailable');

    const res = await middleware(req('/team'));

    expect(redirectPath(res)).toBe('/');
  });

  it('fails closed when Supabase configuration is missing', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;

    const res = await middleware(req('/team'));

    expect(redirectPath(res)).toBe('/');
  });

  it('оставляет client внутри клиентского портала', async () => {
    mockUser = { id: 'u-client' };
    mockRole = 'client';

    const res = await middleware(req('/team'));

    expect(redirectPath(res)).toBe('/client');
  });

  it('редиректит анонима на login', async () => {
    const res = await middleware(req('/team'));

    expect(redirectPath(res)).toBe('/login');
  });
});
