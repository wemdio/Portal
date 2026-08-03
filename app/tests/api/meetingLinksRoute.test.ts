/** @jest-environment node */

/**
 * Экран ручной привязки записей встреч (Task 3 плана
 * docs/superpowers/plans/2026-07-30-meeting-deal-links.md). Под тестом —
 * места, где молчаливая ошибка стоит дороже явной:
 *  - гонка при параллельной разметке одной записи двумя людьми (уникальный
 *    индекс на transcript_id должен дать явный 409, а не тихую перезапись);
 *  - минимальная длина поискового запроса по сделкам;
 *  - валидация входа PUT (нужен либо amo_deal_id, либо not_a_meeting).
 */

import { NextRequest } from 'next/server';

type ChainResult = { data?: unknown; error?: unknown };

function makeChain(result: ChainResult) {
  const chain: Record<string, unknown> = {};
  const passthrough = ['select', 'eq', 'gte', 'lte', 'order', 'limit', 'in', 'or'];
  for (const m of passthrough) {
    chain[m] = jest.fn(() => chain);
  }
  chain.maybeSingle = jest.fn(async () => result);
  chain.insert = jest.fn(async () => result);
  // Большинство вызовов в роуте awaits сам билдер без терминального метода
  // (тот же паттерн, что и в остальных first-sales роутах) — билдер обязан
  // быть thenable.
  (chain as unknown as PromiseLike<ChainResult>).then = (resolve, reject) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

const state: { byTable: Record<string, ChainResult> } = { byTable: {} };

function makeDb() {
  return {
    from: (table: string) => makeChain(state.byTable[table] ?? { data: [], error: null }),
  };
}

jest.mock('@/lib/firstSales/access', () => ({
  requireFirstSalesAccess: async () => ({ user: { id: 'u-1' }, supabaseAdmin: makeDb() }),
}));

import { GET, PUT } from '@/app/api/analytics/first-sales/meeting-links/route';

beforeEach(() => {
  state.byTable = {};
});

function putReq(body: unknown) {
  return new NextRequest('http://localhost/api/analytics/first-sales/meeting-links', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

function getReq(qs: string) {
  return new NextRequest(`http://localhost/api/analytics/first-sales/meeting-links?${qs}`);
}

describe('PUT /meeting-links — гонка при параллельной разметке', () => {
  it('запись существует, сделка из воронки первички — 200 и manual-инсерт', async () => {
    state.byTable = {
      tg_video_transcripts: { data: { id: 't-1' }, error: null },
      amo_leads: { data: { amo_id: 42 }, error: null },
      meeting_deal_links: { data: null, error: null },
    };
    const res = await PUT(putReq({ transcript_id: 't-1', amo_deal_id: 42 }));
    expect(res.status).toBe(200);
  });

  it('уникальный индекс (23505) — второй сохраняющий получает явный 409, а не тихий успех', async () => {
    state.byTable = {
      tg_video_transcripts: { data: { id: 't-1' }, error: null },
      amo_leads: { data: { amo_id: 42 }, error: null },
      meeting_deal_links: { data: null, error: { code: '23505', message: 'duplicate key' } },
    };
    const res = await PUT(putReq({ transcript_id: 't-1', amo_deal_id: 42 }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/уже разметил/i);
  });

  it('not_a_meeting: true — привязка не требуется, amo_deal_id не проверяется', async () => {
    state.byTable = {
      tg_video_transcripts: { data: { id: 't-1' }, error: null },
      meeting_deal_links: { data: null, error: null },
    };
    const res = await PUT(putReq({ transcript_id: 't-1', not_a_meeting: true }));
    expect(res.status).toBe(200);
  });

  it('без amo_deal_id и без not_a_meeting — 400', async () => {
    const res = await PUT(putReq({ transcript_id: 't-1' }));
    expect(res.status).toBe(400);
  });

  it('несуществующая запись — 404', async () => {
    state.byTable = { tg_video_transcripts: { data: null, error: null } };
    const res = await PUT(putReq({ transcript_id: 'missing', amo_deal_id: 42 }));
    expect(res.status).toBe(404);
  });

  it('сделка не из воронки первички — 400, привязка не создаётся', async () => {
    state.byTable = {
      tg_video_transcripts: { data: { id: 't-1' }, error: null },
      amo_leads: { data: null, error: null },
    };
    const res = await PUT(putReq({ transcript_id: 't-1', amo_deal_id: 999 }));
    expect(res.status).toBe(400);
  });
});

describe('GET /meeting-links?q= — поиск сделки', () => {
  it('короткий запрос (1 символ) не бьёт по базе и возвращает пусто', async () => {
    const res = await GET(getReq('q=a'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });

  it('запрос из 2+ символов уходит в поиск', async () => {
    state.byTable = {
      amo_leads: {
        data: [{ amo_id: 1, name: 'ООО Ромашка', company_name: 'Ромашка', company_website: 'romashka.ru', created_at: '2026-07-01T00:00:00Z', status_name: 'В работе' }],
        error: null,
      },
    };
    const res = await GET(getReq('q=ромашка'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ amo_id: number }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].amo_id).toBe(1);
  });
});

describe('GET /meeting-links — очередь', () => {
  it('исключает записи, уже присутствующие в meeting_deal_links (включая not_a_meeting)', async () => {
    state.byTable = {
      tg_video_transcripts: {
        data: [
          { id: 't-1', tg_message_date: '2026-07-01T10:00:00Z', caption: 'laserstyle', filename: '1.mp4', text: 'привет, это созвон с laserstyle по поводу сайта' },
          { id: 't-2', tg_message_date: '2026-07-02T10:00:00Z', caption: null, filename: '2.mp4', text: '' },
        ],
        error: null,
      },
      meeting_deal_links: { data: [{ transcript_id: 't-1' }], error: null },
    };
    const res = await GET(getReq('from=2026-07-01&to=2026-07-31'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows.map((r) => r.id)).toEqual(['t-2']);
  });
});
