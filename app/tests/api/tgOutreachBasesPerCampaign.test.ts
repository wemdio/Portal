/** @jest-environment node */

/**
 * База контактов принадлежит кампании.
 *
 * До 12.08.2026 роут отдавал ВСЕ базы портала: оператор открывал свою кампанию
 * и видел там чужую базу на 2206 контактов — со своими счётчиками и в одной
 * галочке от запуска по ней рассылки. Тесты держат три свойства: чужого в
 * выдаче нет, база без кампании не создаётся, отобрать чужую базу нельзя.
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

const MY_CAMPAIGN = '11111111-1111-1111-1111-111111111111';
const OTHER_CAMPAIGN = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';

let db: MockSupabaseClient;

jest.mock('@/lib/tgOutreach/apiHelpers', () => {
  const { NextResponse } = jest.requireActual('next/server');
  return {
    jsonError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
    authenticateRequest: jest.fn(async () => ({ user: { id: USER_ID }, supabase: db })),
  };
});

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (_o: unknown, h: () => Promise<unknown>) => h(),
}));

import { GET, POST } from '@/app/api/tools/tg-outreach/bases/route';
import { PATCH } from '@/app/api/tools/tg-outreach/bases/[id]/route';

function seed() {
  return createMockSupabase({
    tables: {
      tg_outreach_bases: [
        { id: 'base-mine', user_id: USER_ID, campaign_id: MY_CAMPAIGN, name: 'Гипотеза 1', notes: '', created_at: '2026-08-10T00:00:00Z' },
        { id: 'base-other', user_id: USER_ID, campaign_id: OTHER_CAMPAIGN, name: 'Ру_аутрич_1', notes: '', created_at: '2026-08-09T00:00:00Z' },
        { id: 'base-orphan', user_id: USER_ID, campaign_id: null, name: 'Ничья', notes: '', created_at: '2026-08-08T00:00:00Z' },
      ],
      tg_outreach_base_contacts: [
        { id: 'c1', base_id: 'base-mine', status: 'pending' },
        { id: 'c2', base_id: 'base-mine', status: 'sent' },
        { id: 'c3', base_id: 'base-other', status: 'sent' },
        { id: 'c4', base_id: 'base-orphan', status: 'pending' },
      ],
    },
  });
}

const headers = { get: () => 'Bearer test' };
const req = (url: string) => ({ url, headers } as never);
const jsonReq = (body: unknown) => ({ headers, json: async () => body } as never);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  db = seed();
});

describe('GET /bases', () => {
  it('отдаёт только базы своей кампании — чужая не видна', async () => {
    const res = await GET(req(`http://x/api?campaign_id=${MY_CAMPAIGN}`));
    const body = await res.json() as { items: Array<{ id: string }>; orphans: Array<{ id: string }> };

    expect(body.items.map((b) => b.id)).toEqual(['base-mine']);
    expect(body.items.map((b) => b.id)).not.toContain('base-other');
  });

  it('базы без кампании отдаются отдельным списком, а не теряются', async () => {
    const res = await GET(req(`http://x/api?campaign_id=${MY_CAMPAIGN}`));
    const body = await res.json() as { orphans: Array<{ id: string }> };

    expect(body.orphans.map((b) => b.id)).toEqual(['base-orphan']);
  });

  it('считает контакты по каждой базе', async () => {
    const res = await GET(req(`http://x/api?campaign_id=${MY_CAMPAIGN}`));
    const body = await res.json() as { items: Array<{ counts: Record<string, number> }> };

    expect(body.items[0].counts).toMatchObject({ total: 2, pending: 1, sent: 1 });
  });

  it('без campaign_id не отвечает: иначе это снова список всего портала', async () => {
    const res = await GET(req('http://x/api'));
    expect(res.status).toBe(400);
  });
});

describe('POST /bases', () => {
  it('создаёт базу внутри кампании', async () => {
    const res = await POST(jsonReq({ name: 'Гипотеза 2', campaign_id: MY_CAMPAIGN }));
    expect(res.status).toBe(201);

    const created = db.getRows('tg_outreach_bases').find((r) => r.name === 'Гипотеза 2');
    expect(created?.campaign_id).toBe(MY_CAMPAIGN);
  });

  it('без кампании базу не создать — именно так появлялись ничьи базы', async () => {
    const res = await POST(jsonReq({ name: 'Гипотеза 3' }));
    expect(res.status).toBe(400);
    expect(db.getRows('tg_outreach_bases').some((r) => r.name === 'Гипотеза 3')).toBe(false);
  });

  it('без названия базу не создать', async () => {
    const res = await POST(jsonReq({ campaign_id: MY_CAMPAIGN }));
    expect(res.status).toBe(400);
  });
});

describe('PATCH /bases/[id] — перенос ничьей базы', () => {
  it('база без кампании переносится в кампанию', async () => {
    const res = await PATCH(jsonReq({ campaign_id: MY_CAMPAIGN }), ctx('base-orphan'));
    expect(res.status).toBe(200);

    const row = db.getRows('tg_outreach_bases').find((r) => r.id === 'base-orphan');
    expect(row?.campaign_id).toBe(MY_CAMPAIGN);
  });

  /**
   * Главная защита: иначе «перенос» стал бы новым способом увести чужую базу с
   * её отправками в свою рассылку — ровно та проблема, ради которой всё это.
   */
  it('чужую базу отобрать нельзя', async () => {
    const res = await PATCH(jsonReq({ campaign_id: MY_CAMPAIGN }), ctx('base-other'));
    expect(res.status).toBe(409);

    const row = db.getRows('tg_outreach_bases').find((r) => r.id === 'base-other');
    expect(row?.campaign_id).toBe(OTHER_CAMPAIGN);
  });

  it('несуществующая база — 404', async () => {
    const res = await PATCH(jsonReq({ campaign_id: MY_CAMPAIGN }), ctx('нет такой'));
    expect(res.status).toBe(404);
  });

  it('без campaign_id — 400', async () => {
    const res = await PATCH(jsonReq({}), ctx('base-orphan'));
    expect(res.status).toBe(400);
  });
});
