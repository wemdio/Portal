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

jest.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: mockUser }, error: null }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: mockUser ? { role: mockRole, locale: 'ru' } : null,
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

function req(path: string) {
  return new NextRequest(`http://localhost:3000${path}`);
}

beforeEach(() => {
  jest.resetModules();
  mockUser = null;
  mockRole = null;
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
