/** @jest-environment node */

/**
 * Юнит-тесты РЕАЛЬНОГО requireClientAuth (lib/clientApiHelper).
 *
 * Контекст (инцидент 15.07.2026): при блипе БД ошибка select'а глоталась —
 *   - client_instantly_access error → accessRows=[] → роуты отвечали 200
 *     «данных нет», клиент видел «Кампаний пока нет» вместо ошибки;
 *   - profiles error → role=null → клиент получал «Forbidden» (403).
 * Фикс: инфраструктурная ошибка любой из двух выборок → 503, чтобы UI показал
 * error-баннер с ретраем. При этом легитимные состояния сохранены:
 *   - новый клиент без прав (rows=[] БЕЗ error) → как раньше, auth с [];
 *   - профиля нет (PGRST116) → как раньше, 403 Forbidden;
 *   - демо-аккаунт не зависит от instantly-БД (rows не используются).
 *
 * clientPortalSmoke этот код НЕ покрывает — там requireClientAuth замокан
 * целиком, поэтому гарды живут под собственным сьютом.
 */

import { NextRequest } from 'next/server';

const AUTH_ROW = {
  resource_type: 'campaign',
  resource_id: 'cmp-1',
  instantly_account_id: 'account-2',
};

// Переключаемые результаты выборок (сбрасываются в beforeEach).
const state: {
  profileResult: { data: Record<string, unknown> | null; error: { code?: string; message: string } | null };
  rowsResult: { data: Array<Record<string, unknown>> | null; error: { code?: string; message: string } | null };
} = {
  profileResult: { data: { role: 'client', is_demo: false }, error: null },
  rowsResult: { data: [AUTH_ROW], error: null },
};

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: (header: string | null) => (header ? 'tok' : null),
  createAuthedSupabaseClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u-1' } } }) },
  }),
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => state.profileResult }),
      }),
    }),
  },
}));

jest.mock('@/lib/supabaseInstantly', () => ({
  supabaseInstantly: {
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve(state.rowsResult),
      }),
    }),
  },
}));

jest.mock('@/lib/apiTiming', () => ({
  withApiTiming: async <T,>(_op: string, fn: () => Promise<T>) => fn(),
}));

import { requireClientAuth } from '@/lib/clientApiHelper';

function makeReq(method = 'GET', path = '/api/client/campaigns'): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { authorization: 'Bearer t' },
  });
}

beforeEach(() => {
  state.profileResult = { data: { role: 'client', is_demo: false }, error: null };
  state.rowsResult = { data: [AUTH_ROW], error: null };
});

describe('requireClientAuth — инфраструктурные ошибки НЕ маскируются', () => {
  it('happy path: auth с проброшенными accessRows', async () => {
    const result = await requireClientAuth(makeReq());
    if ('error' in result) throw new Error('ожидали auth');
    expect(result.auth.userId).toBe('u-1');
    expect(result.auth.accessRows).toEqual([AUTH_ROW]);
    expect(result.auth.isDemo).toBe(false);
  });

  it('новый клиент: rows=[] БЕЗ ошибки → auth с пустыми правами (200-путь, НЕ 503)', async () => {
    state.rowsResult = { data: [], error: null };
    const result = await requireClientAuth(makeReq());
    if ('error' in result) throw new Error('легитимная пустота не должна стать ошибкой');
    expect(result.auth.accessRows).toEqual([]);
  });

  it('блип instantly-БД (rows error) → 503, а не фейковая пустота', async () => {
    state.rowsResult = { data: null, error: { code: '', message: 'TypeError: fetch failed' } };
    const result = await requireClientAuth(makeReq());
    if (!('error' in result)) throw new Error('ожидали error-ответ');
    expect(result.error.status).toBe(503);
    const body = (await result.error.json()) as { error: string };
    expect(body.error).toMatch(/временно недоступен/i);
  });

  it('блип main-БД (profile infra error) → 503, а не Forbidden', async () => {
    state.profileResult = { data: null, error: { code: 'XX000', message: 'timeout' } };
    const result = await requireClientAuth(makeReq());
    if (!('error' in result)) throw new Error('ожидали error-ответ');
    expect(result.error.status).toBe(503);
  });

  it('профиля реально нет (PGRST116) → прежняя семантика: 403 Forbidden', async () => {
    state.profileResult = { data: null, error: { code: 'PGRST116', message: '0 rows' } };
    const result = await requireClientAuth(makeReq());
    if (!('error' in result)) throw new Error('ожидали error-ответ');
    expect(result.error.status).toBe(403);
  });

  it('демо-аккаунт при rows error проходит (демо-роуты отдают фикстуры, rows не нужны)', async () => {
    state.profileResult = { data: { role: 'client', is_demo: true }, error: null };
    state.rowsResult = { data: null, error: { code: '', message: 'fetch failed' } };
    const result = await requireClientAuth(makeReq());
    if ('error' in result) throw new Error('демо не должно зависеть от instantly-БД');
    expect(result.auth.isDemo).toBe(true);
    expect(result.auth.accessRows).toEqual([]);
  });

  it('демо + мутирующий метод → прежняя семантика: 403 DEMO_READONLY (гард раньше rows-проверки)', async () => {
    state.profileResult = { data: { role: 'client', is_demo: true }, error: null };
    state.rowsResult = { data: null, error: { code: '', message: 'fetch failed' } };
    const result = await requireClientAuth(makeReq('POST', '/api/client/blocklist'));
    if (!('error' in result)) throw new Error('ожидали error-ответ');
    expect(result.error.status).toBe(403);
    const body = (await result.error.json()) as { code?: string };
    expect(body.code).toBe('DEMO_READONLY');
  });

  it('не-клиентская роль → прежняя семантика: 403', async () => {
    state.profileResult = { data: { role: 'lead', is_demo: false }, error: null };
    const result = await requireClientAuth(makeReq());
    if (!('error' in result)) throw new Error('ожидали error-ответ');
    expect(result.error.status).toBe(403);
  });
});
