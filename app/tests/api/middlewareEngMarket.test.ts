/** @jest-environment node */

/**
 * ENG-разделение по хосту в middleware (app.outreachos.xyz = ENG-кабинет):
 *
 *  - ENG-хост: '/' → /client/eng (eng-клиент) или /login (гость);
 *    ru-клиент и стафф уводятся на MAIN_APP_HOST (polza-portal.ru).
 *  - market-гейты на любом хосте: eng-клиент вне /client/eng → /client/eng;
 *    ru-клиент на /client/eng → /client.
 *  - market кэшируется в x-portal-role третьим сегментом (userId:role:market);
 *    старый формат (userId:role) = market неизвестен → точечный read profiles.
 *  - RU-поведение (ru-клиент на RU-хосте) не меняется.
 *
 * Моки — по образцу middlewarePublicPaths.test.ts.
 */

let mockUser: { id: string } | null = null;
let mockRole: string | null = null;
let mockMarket: string | null = null;
let mockIsDemo = false;

jest.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: mockUser }, error: null }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: mockUser
              ? { role: mockRole, locale: 'ru', is_demo: mockIsDemo, market: mockMarket }
              : null,
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

const ENG_HOST = 'app.outreachos.xyz';
const MAIN_HOST = 'polza-portal.ru';
const RU_HOSTS = [MAIN_HOST, 'app.outreachos.pro'] as const;

function req(
  path: string,
  host: string = MAIN_HOST,
  cookies: Record<string, string> = {},
) {
  const cookie = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
  const headers: Record<string, string> = { host };
  if (cookie) headers.cookie = cookie;
  return new NextRequest(`http://${host}${path}`, { headers });
}

function locationOf(res: Response): string | null {
  return res.headers.get('location');
}

beforeEach(() => {
  jest.resetModules();
  mockUser = null;
  mockRole = null;
  mockMarket = null;
  mockIsDemo = false;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.test';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  delete process.env.MAINTENANCE_MODE;
});

function loginAs(role: string, market: string | null) {
  mockUser = { id: `u-${role}-${market ?? 'none'}` };
  mockRole = role;
  mockMarket = market;
}

describe('middleware: ENG-хост app.outreachos.xyz', () => {
  it('гость на / → /login', async () => {
    const res = await middleware(req('/', ENG_HOST));
    expect(locationOf(res)).toBe(`http://${ENG_HOST}/login`);
  });

  it('eng-клиент на / → /client/eng на том же хосте', async () => {
    loginAs('client', 'eng');
    const res = await middleware(req('/', ENG_HOST));
    expect(locationOf(res)).toBe(`http://${ENG_HOST}/client/eng`);
  });

  it('ru-клиент на / → https://polza-portal.ru/', async () => {
    loginAs('client', 'ru');
    const res = await middleware(req('/', ENG_HOST));
    expect(locationOf(res)).toBe(`https://${MAIN_HOST}/`);
  });

  it('ru-клиент на /client → https://polza-portal.ru/', async () => {
    loginAs('client', 'ru');
    const res = await middleware(req('/client', ENG_HOST));
    expect(locationOf(res)).toBe(`https://${MAIN_HOST}/`);
  });

  it('стафф (lead) на / → https://polza-portal.ru/', async () => {
    loginAs('lead', 'ru');
    const res = await middleware(req('/', ENG_HOST));
    expect(locationOf(res)).toBe(`https://${MAIN_HOST}/`);
  });

  it('стафф (admin) на /team → https://polza-portal.ru/ (а не внутренний раздел)', async () => {
    loginAs('admin', 'ru');
    const res = await middleware(req('/team', ENG_HOST));
    expect(locationOf(res)).toBe(`https://${MAIN_HOST}/`);
  });

  it('eng-клиент на /client/eng — остаётся', async () => {
    loginAs('client', 'eng');
    const res = await middleware(req('/client/eng', ENG_HOST));
    expect(locationOf(res)).toBeNull();
  });

  it('eng-клиент на /client/eng/mailboxes — остаётся (иначе форму не открыть)', async () => {
    loginAs('client', 'eng');
    const res = await middleware(req('/client/eng/mailboxes', ENG_HOST));
    expect(locationOf(res)).toBeNull();
  });

  it('eng-клиент на /client/dashboard → /client/eng', async () => {
    loginAs('client', 'eng');
    const res = await middleware(req('/client/dashboard', ENG_HOST));
    expect(locationOf(res)).toBe(`http://${ENG_HOST}/client/eng`);
  });

  it('гость на /login — остаётся (страница логина ENG-кабинета)', async () => {
    const res = await middleware(req('/login', ENG_HOST));
    expect(locationOf(res)).toBeNull();
  });

  it('анонимный /api/client/eng/* — не трогаем (host-гейты не про API)', async () => {
    const res = await middleware(req('/api/client/eng/projects', ENG_HOST));
    expect(res.status).not.toBe(401);
    expect(locationOf(res)).toBeNull();
  });
});

describe('middleware: market-гейты на RU-хостах', () => {
  it.each(RU_HOSTS)('ru-клиент на %s /client/eng → /client', async (host) => {
    loginAs('client', 'ru');
    const res = await middleware(req('/client/eng', host));
    expect(locationOf(res)).toBe(`http://${host}/client`);
  });

  it.each(RU_HOSTS)('eng-клиент на %s /client/brief → /client/eng', async (host) => {
    loginAs('client', 'eng');
    const res = await middleware(req('/client/brief', host));
    expect(locationOf(res)).toBe(`http://${host}/client/eng`);
  });

  it('eng-клиент на /client (корень кабинета) → /client/eng', async () => {
    loginAs('client', 'eng');
    const res = await middleware(req('/client', MAIN_HOST));
    expect(locationOf(res)).toBe(`http://${MAIN_HOST}/client/eng`);
  });

  it('eng-клиент на /client/eng — остаётся', async () => {
    loginAs('client', 'eng');
    const res = await middleware(req('/client/eng', MAIN_HOST));
    expect(locationOf(res)).toBeNull();
  });

  it('ru-клиент на /client/brief — остаётся (контроль: RU-поведение неизменно)', async () => {
    loginAs('client', 'ru');
    const res = await middleware(req('/client/brief', MAIN_HOST));
    expect(locationOf(res)).toBeNull();
  });

  it('ru-клиент на /client — остаётся (контроль)', async () => {
    loginAs('client', 'ru');
    const res = await middleware(req('/client', MAIN_HOST));
    expect(locationOf(res)).toBeNull();
  });

  it('стафф (lead) на /team — остаётся (контроль: staff-gate не задет)', async () => {
    loginAs('lead', 'ru');
    const res = await middleware(req('/team', MAIN_HOST));
    expect(locationOf(res)).toBeNull();
  });

  it('профиль без market (старая строка) читается как ru: /client/eng → /client', async () => {
    loginAs('client', null);
    const res = await middleware(req('/client/eng', MAIN_HOST));
    expect(locationOf(res)).toBe(`http://${MAIN_HOST}/client`);
  });
});

describe('middleware: кэш market в x-portal-role', () => {
  it('старый формат куки userId:role — роль из куки, market дочитывается из profiles', async () => {
    mockUser = { id: 'u-old' };
    mockRole = 'client';
    mockMarket = 'eng';
    const res = await middleware(req('/client/brief', MAIN_HOST, {
      'x-portal-role': 'u-old:client',
    }));
    expect(locationOf(res)).toBe(`http://${MAIN_HOST}/client/eng`);
  });

  it('новый формат userId:role:market — market берётся из куки', async () => {
    mockUser = { id: 'u-new' };
    mockRole = 'ru-in-db'; // в БД другое значение: кука должна победить
    mockMarket = 'ru';
    const res = await middleware(req('/client/brief', MAIN_HOST, {
      'x-portal-role': 'u-new:client:eng',
    }));
    expect(locationOf(res)).toBe(`http://${MAIN_HOST}/client/eng`);
  });

  it('кука userId:role:ru у eng-профиля в БД — кука побеждает (ru-гейт)', async () => {
    mockUser = { id: 'u-flip' };
    mockRole = 'client';
    mockMarket = 'eng';
    const res = await middleware(req('/client/eng', MAIN_HOST, {
      'x-portal-role': 'u-flip:client:ru',
    }));
    expect(locationOf(res)).toBe(`http://${MAIN_HOST}/client`);
  });

  it('чужая кука (другой userId) игнорируется — роль и market из БД', async () => {
    mockUser = { id: 'u-real' };
    mockRole = 'client';
    mockMarket = 'ru';
    const res = await middleware(req('/client/eng', MAIN_HOST, {
      'x-portal-role': 'u-forged:client:eng',
    }));
    expect(locationOf(res)).toBe(`http://${MAIN_HOST}/client`);
  });
});
