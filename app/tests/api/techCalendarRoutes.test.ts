/** @jest-environment node */

/**
 * Ручки календаря технички.
 *
 * Таблица заперта на RLS, и единственный вход в неё — эти ручки, поэтому
 * первое, что пинуется: не-админ не получает ни строки, включая GET. Второе —
 * продление: оно двигает дату на цикл и сбрасывает решение, и именно поэтому
 * живёт отдельной ручкой, а не PATCH'ем.
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import { addDays, mskDateStr } from '@/lib/techCalendar/dates';
import type { NextRequest } from 'next/server';

const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const TECH_ID = '00000000-0000-4000-8000-000000000002';
const INITIAL_UPDATED_AT = '2026-08-01T00:00:00.000Z';

let mockDb: MockSupabaseClient = createMockSupabase();
let currentUserId = ADMIN_ID;
let mockRenewError: string | null = null;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: () => 'test-token',
  createAuthedSupabaseClient: () => ({
    auth: { getUser: jest.fn(async () => ({ data: { user: { id: currentUserId } } })) },
  }),
}));

/**
 * `text()` — источник истины, `json()` построен поверх него, как у настоящего
 * fetch-Request. Так ручка, которая теперь читает тело через `.text()`
 * (чтобы отличить «тела нет» от «тело сломано»), получает от мока то же
 * поведение, что и от Next.js в проде.
 */
function req(body?: unknown): NextRequest {
  const raw = body === undefined ? '' : JSON.stringify(body);
  return {
    headers: { get: () => 'Bearer test-token' },
    nextUrl: { searchParams: new URLSearchParams() },
    text: async () => raw,
    json: async () => JSON.parse(raw || '{}'),
  } as unknown as NextRequest;
}

function reqQuery(query: string): NextRequest {
  return {
    headers: { get: () => 'Bearer test-token' },
    nextUrl: { searchParams: new URLSearchParams(query) },
    text: async () => '',
    json: async () => ({}),
  } as unknown as NextRequest;
}

/** Запрос с сырым (возможно битым) телом — для проверки обработки невалидного JSON. */
function reqRaw(raw: string): NextRequest {
  return {
    headers: { get: () => 'Bearer test-token' },
    text: async () => raw,
    json: async () => JSON.parse(raw),
  } as unknown as NextRequest;
}

function subRow(over: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    service_name: 'Bright Data',
    service_type: 'proxy',
    amount: 250,
    cost_amount_rub: 25_000,
    currency: 'USD',
    billing_cycle: 'monthly',
    next_billing_date: '2026-08-20',
    status: 'pending_review',
    decision_by: null,
    decision_at: null,
    decision_notes: null,
    notes: null,
    source: 'manual',
    external_key: null,
    quantity: 1,
    provider_status: null,
    synced_at: null,
    is_hidden: false,
    hidden_at: null,
    created_by: ADMIN_ID,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: INITIAL_UPDATED_AT,
    ...over,
  };
}

function createTechCalendarDb(subscriptions = [subRow()]): MockSupabaseClient {
  return createMockSupabase({
    tables: {
      profiles: [
        { id: ADMIN_ID, role: 'admin' },
        { id: TECH_ID, role: 'technician' },
      ],
      tech_subscriptions: subscriptions,
      tech_subscription_cost_events: [],
    },
    rpcHandlers: {
      renew_tech_subscription_with_budget: async (params, db) => {
        if (mockRenewError) return { data: null, error: { message: mockRenewError } };
        const current = db.getRows('tech_subscriptions')
          .find((row) => row.id === params.p_subscription_id);
        if (!current) {
          return { data: null, error: { message: 'tech_subscription_not_found' } };
        }
        if (current.updated_at !== params.p_expected_updated_at) {
          return { data: null, error: { message: 'tech_subscription_conflict' } };
        }
        const currentBillingDate = String(current.next_billing_date ?? '');
        const nextBillingDate = String(params.p_next_billing_date ?? '');
        if (
          current.status !== 'keep'
          || nextBillingDate <= currentBillingDate
          || current.cost_amount_rub === null
        ) {
          return { data: null, error: { message: 'tech_subscription_invalid_input' } };
        }

        await db.from('tech_subscriptions').update({
          next_billing_date: params.p_next_billing_date,
          amount: params.p_next_amount ?? current.amount,
          status: 'active',
          decision_by: null,
          decision_at: null,
          decision_notes: null,
        }).eq('id', params.p_subscription_id);
        await db.from('tech_subscription_cost_events').insert({
          subscription_id: current.id,
          service_name: current.service_name,
          billing_date: current.next_billing_date,
          amount: current.amount,
          currency: current.currency,
          amount_rub: current.currency === 'RUB' ? current.amount : 25_000,
          paid_by: params.p_actor_id,
        });
        return { data: params.p_next_billing_date };
      },
    },
  });
}

beforeEach(() => {
  currentUserId = ADMIN_ID;
  mockRenewError = null;
  mockDb = createTechCalendarDb();
  jest.resetModules();
});

describe('доступ', () => {
  it('не пускает техника в список', async () => {
    currentUserId = TECH_ID;
    const { GET } = await import('@/app/api/tech-calendar/subscriptions/route');
    const res = await GET(req());
    expect(res.status).toBe(403);
  });

  it('не пускает техника к продлению', async () => {
    currentUserId = TECH_ID;
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/[id]/renew/route');
    const res = await POST(req(), { params: Promise.resolve({ id: 'sub-1' }) });
    expect(res.status).toBe(403);
  });

  it('не пускает техника к созданию', async () => {
    currentUserId = TECH_ID;
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/route');
    const res = await POST(req({ service_name: 'X', next_billing_date: '2026-09-01' }));
    expect(res.status).toBe(403);
  });

  it('не пускает техника к правке', async () => {
    currentUserId = TECH_ID;
    const { PATCH } = await import('@/app/api/tech-calendar/subscriptions/[id]/route');
    const res = await PATCH(req({ amount: 100 }), { params: Promise.resolve({ id: 'sub-1' }) });
    expect(res.status).toBe(403);
  });

  it('не пускает техника к удалению', async () => {
    currentUserId = TECH_ID;
    const { DELETE } = await import('@/app/api/tech-calendar/subscriptions/[id]/route');
    const res = await DELETE(req(), { params: Promise.resolve({ id: 'sub-1' }) });
    expect(res.status).toBe(403);
  });

  it('не пускает техника к решению', async () => {
    currentUserId = TECH_ID;
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/[id]/decision/route');
    const res = await POST(req({ decision: 'keep' }), { params: Promise.resolve({ id: 'sub-1' }) });
    expect(res.status).toBe(403);
  });
});

describe('GET списка', () => {
  it('отдаёт подписки админу', async () => {
    mockDb = createMockSupabase({
      tables: {
        profiles: [{ id: ADMIN_ID, role: 'admin' }],
        tech_subscriptions: [subRow()],
        tech_provider_balances: [{
          provider: 'serper',
          label: 'Serper',
          balance: 9909,
          unit: 'credits',
          synced_at: '2026-09-01T06:00:00.000Z',
          last_error: null,
          updated_at: '2026-09-01T06:00:00.000Z',
        }, {
          provider: 'proxymarket',
          label: 'proxy.market',
          balance: 32,
          unit: 'RUB',
          synced_at: '2026-09-01T06:00:00.000Z',
          last_error: null,
          updated_at: '2026-09-01T06:00:00.000Z',
        }],
      },
    });
    const { GET } = await import('@/app/api/tech-calendar/subscriptions/route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.subscriptions).toHaveLength(1);
    expect(json.subscriptions[0].service_name).toBe('Bright Data');
    expect(json.balances).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'serper', balance: 9909, unit: 'credits' }),
      expect.objectContaining({ provider: 'proxymarket', balance: 32, unit: 'RUB' }),
    ]));
  });

  it('скрытые строки отдаёт только по явному запросу', async () => {
    mockDb = createMockSupabase({
      tables: {
        profiles: [{ id: ADMIN_ID, role: 'admin' }],
        tech_subscriptions: [subRow({ is_hidden: true, hidden_at: '2026-08-13T10:00:00.000Z' })],
      },
    });
    const { GET } = await import('@/app/api/tech-calendar/subscriptions/route');

    const normal = await GET(req());
    expect((await normal.json()).subscriptions).toHaveLength(0);

    const withHidden = await GET(reqQuery('include_hidden=1'));
    expect((await withHidden.json()).subscriptions).toHaveLength(1);
  });

  it('желтит активный сервис, до списания которого пара дней', async () => {
    const soon = addDays(mskDateStr(new Date()), 2);
    mockDb = createMockSupabase({
      tables: {
        profiles: [{ id: ADMIN_ID, role: 'admin' }],
        tech_subscriptions: [subRow({ status: 'active', next_billing_date: soon })],
      },
    });
    const { GET } = await import('@/app/api/tech-calendar/subscriptions/route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.subscriptions[0].status).toBe('pending_review');
    expect(mockDb.getRows('tech_subscriptions')[0].status).toBe('pending_review');
  });
});

describe('POST создания', () => {
  it('заводит сервис и проставляет автора', async () => {
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/route');
    const res = await POST(
      req({ service_name: 'Hetzner', service_type: 'server', amount: 4500, currency: 'RUB', next_billing_date: '2026-09-01' }),
    );
    expect(res.status).toBe(200);
    const rows = mockDb.getRows('tech_subscriptions');
    const created = rows.find((r) => r.service_name === 'Hetzner');
    expect(created).toMatchObject({ service_type: 'server', currency: 'RUB', status: 'active', created_by: ADMIN_ID });
  });

  it('отдаёт 400 на битой дате', async () => {
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/route');
    const res = await POST(req({ service_name: 'X', next_billing_date: '01.09.2026' }));
    expect(res.status).toBe(400);
  });
});

describe('POST продления', () => {
  it('двигает дату на цикл и сбрасывает решение', async () => {
    mockDb = createTechCalendarDb([
      subRow({ status: 'keep', decision_by: ADMIN_ID, decision_at: '2026-08-13T10:00:00.000Z' }),
    ]);
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/[id]/renew/route');
    const res = await POST(req({}), { params: Promise.resolve({ id: 'sub-1' }) });

    expect(res.status).toBe(200);
    const row = mockDb.getRows('tech_subscriptions')[0];
    expect(row).toMatchObject({
      next_billing_date: '2026-09-20',
      status: 'active',
      decision_by: null,
      decision_at: null,
    });
    expect(mockDb.getRows('tech_subscription_cost_events')).toEqual([
      expect.objectContaining({
        subscription_id: 'sub-1',
        billing_date: '2026-08-20',
        paid_by: ADMIN_ID,
      }),
    ]);
    expect(mockDb.rpcCalls).toContainEqual({
      fn: 'renew_tech_subscription_with_budget',
      params: {
        p_subscription_id: 'sub-1',
        p_next_billing_date: '2026-09-20',
        p_next_amount: null,
        p_actor_id: ADMIN_ID,
        p_expected_updated_at: INITIAL_UPDATED_AT,
      },
    });
  });

  it('принимает ручную дату и сумму', async () => {
    mockDb = createTechCalendarDb([subRow({ status: 'keep' })]);
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/[id]/renew/route');
    const res = await POST(req({
      next_billing_date: '2026-09-25',
      amount: 275,
      expected_updated_at: INITIAL_UPDATED_AT,
    }), {
      params: Promise.resolve({ id: 'sub-1' }),
    });

    expect(res.status).toBe(200);
    expect(mockDb.getRows('tech_subscriptions')[0]).toMatchObject({
      next_billing_date: '2026-09-25',
      amount: 275,
    });
  });

  it('отдаёт 404 на несуществующем сервисе', async () => {
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/[id]/renew/route');
    const res = await POST(req({}), { params: Promise.resolve({ id: 'нет-такого' }) });
    expect(res.status).toBe(404);
  });

  it.each([
    ['payment_request_cost_limit_exceeded', 'cost_limit_exceeded'],
    ['payment_request_cost_budget_incomplete', 'cost_budget_incomplete'],
  ])('не двигает дату, когда бюджетный RPC отклоняет продление: %s', async (message, code) => {
    mockRenewError = message;
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/[id]/renew/route');
    const res = await POST(req({}), { params: Promise.resolve({ id: 'sub-1' }) });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(expect.objectContaining({ code }));
    expect(mockDb.getRows('tech_subscriptions')[0].next_billing_date).toBe('2026-08-20');
    expect(mockDb.getRows('tech_subscription_cost_events')).toHaveLength(0);
  });

  it('отдаёт конфликт и не продлевает устаревшую карточку', async () => {
    mockDb = createTechCalendarDb([subRow({
      status: 'keep',
      updated_at: '2026-08-02T00:00:00.000Z',
    })]);
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/[id]/renew/route');
    const res = await POST(req({ expected_updated_at: INITIAL_UPDATED_AT }), {
      params: Promise.resolve({ id: 'sub-1' }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(expect.objectContaining({ code: 'tech_subscription_conflict' }));
    expect(mockDb.getRows('tech_subscription_cost_events')).toHaveLength(0);
  });

  it('объясняет, что продлевать можно только подтверждённый сервис', async () => {
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/[id]/renew/route');
    const res = await POST(req({}), { params: Promise.resolve({ id: 'sub-1' }) });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(expect.objectContaining({
      code: 'tech_subscription_invalid_input',
    }));
    expect(mockDb.getRows('tech_subscription_cost_events')).toHaveLength(0);
  });

  it('пустое тело — это «посчитай по циклу», а не ошибка', async () => {
    mockDb = createTechCalendarDb([subRow({ status: 'keep' })]);
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/[id]/renew/route');
    const res = await POST(req(), { params: Promise.resolve({ id: 'sub-1' }) });
    expect(res.status).toBe(200);
    expect(mockDb.getRows('tech_subscriptions')[0].next_billing_date).toBe('2026-09-20');
  });

  it('отдаёт 400 на битом JSON вместо того, чтобы молча продлить по циклу', async () => {
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/[id]/renew/route');
    const res = await POST(reqRaw('{"amount": '), { params: Promise.resolve({ id: 'sub-1' }) });
    expect(res.status).toBe(400);
    // Битое тело не должно было продвинуть дату — ручка обязана упасть раньше update.
    expect(mockDb.getRows('tech_subscriptions')[0].next_billing_date).toBe('2026-08-20');
  });
});

describe('POST решения', () => {
  it('требует версию карточки для защиты от перезаписи', async () => {
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/[id]/decision/route');
    const res = await POST(req({ decision: 'keep' }), {
      params: Promise.resolve({ id: 'sub-1' }),
    });

    expect(res.status).toBe(400);
    expect(mockDb.getRows('tech_subscriptions')[0].status).toBe('pending_review');
  });

  it('пишет решение и автора', async () => {
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/[id]/decision/route');
    const res = await POST(req({
      decision: 'cancel',
      notes: 'дорого',
      expected_updated_at: INITIAL_UPDATED_AT,
    }), {
      params: Promise.resolve({ id: 'sub-1' }),
    });

    expect(res.status).toBe(200);
    expect(mockDb.getRows('tech_subscriptions')[0]).toMatchObject({
      status: 'cancel',
      decision_by: ADMIN_ID,
      decision_notes: 'дорого',
    });
  });

  it.each([
    ['payment_request_cost_limit_exceeded', 'cost_limit_exceeded'],
    ['payment_request_cost_budget_incomplete', 'cost_budget_incomplete'],
    ['tech_subscription_paid_cycle_locked', 'tech_subscription_paid_cycle_locked'],
  ])('не ставит «Оставить», если бюджетный guard отклонил решение: %s', async (message, code) => {
    mockDb = createMockSupabase({
      tables: {
        profiles: [{ id: ADMIN_ID, role: 'admin' }],
        tech_subscriptions: [subRow()],
      },
      errorUpdates: {
        tech_subscriptions: { message, patchIncludes: { status: 'keep' } },
      },
    });
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/[id]/decision/route');
    const res = await POST(req({ decision: 'keep', expected_updated_at: INITIAL_UPDATED_AT }), {
      params: Promise.resolve({ id: 'sub-1' }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(expect.objectContaining({ code }));
    expect(mockDb.getRows('tech_subscriptions')[0].status).toBe('pending_review');
  });

  it('не применяет решение из устаревшей карточки', async () => {
    mockDb = createMockSupabase({
      tables: {
        profiles: [{ id: ADMIN_ID, role: 'admin' }],
        tech_subscriptions: [subRow()],
      },
      beforeFirstUpdates: {
        tech_subscriptions: (rows) => rows.map((row) => ({
          ...row,
          updated_at: '2026-08-02T00:00:00.000Z',
        })),
      },
    });
    const { POST } = await import('@/app/api/tech-calendar/subscriptions/[id]/decision/route');
    const res = await POST(req({ decision: 'cancel', expected_updated_at: INITIAL_UPDATED_AT }), {
      params: Promise.resolve({ id: 'sub-1' }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(expect.objectContaining({ code: 'tech_subscription_conflict' }));
    expect(mockDb.getRows('tech_subscriptions')[0].status).toBe('pending_review');
  });
});

describe('PATCH', () => {
  it('требует версию карточки для защиты от перезаписи', async () => {
    const { PATCH } = await import('@/app/api/tech-calendar/subscriptions/[id]/route');
    const res = await PATCH(req({ amount: 300 }), {
      params: Promise.resolve({ id: 'sub-1' }),
    });

    expect(res.status).toBe(400);
    expect(mockDb.getRows('tech_subscriptions')[0].amount).toBe(250);
  });

  it('правит поле', async () => {
    const { PATCH } = await import('@/app/api/tech-calendar/subscriptions/[id]/route');
    const res = await PATCH(req({ amount: 300, expected_updated_at: INITIAL_UPDATED_AT }), {
      params: Promise.resolve({ id: 'sub-1' }),
    });
    expect(res.status).toBe(200);
    expect(mockDb.getRows('tech_subscriptions')[0]).toMatchObject({ amount: 300 });
  });

  it('скрывает сервис без удаления', async () => {
    const { PATCH } = await import('@/app/api/tech-calendar/subscriptions/[id]/route');
    const res = await PATCH(req({
      is_hidden: true,
      expected_updated_at: INITIAL_UPDATED_AT,
    }), { params: Promise.resolve({ id: 'sub-1' }) });
    expect(res.status).toBe(200);
    expect(mockDb.getRows('tech_subscriptions')).toHaveLength(1);
    expect(mockDb.getRows('tech_subscriptions')[0]).toMatchObject({ is_hidden: true });
  });

  it('отдаёт 404 на несуществующем сервисе', async () => {
    const { PATCH } = await import('@/app/api/tech-calendar/subscriptions/[id]/route');
    const res = await PATCH(req({ amount: 300, expected_updated_at: INITIAL_UPDATED_AT }), {
      params: Promise.resolve({ id: 'нет-такого' }),
    });
    expect(res.status).toBe(404);
  });

  it('возвращает понятный конфликт, если правка подтверждённого сервиса превышает лимит', async () => {
    mockDb = createMockSupabase({
      tables: {
        profiles: [{ id: ADMIN_ID, role: 'admin' }],
        tech_subscriptions: [subRow({ status: 'keep' })],
      },
      errorUpdates: {
        tech_subscriptions: {
          message: 'payment_request_cost_limit_exceeded',
          patchIncludes: { amount: 700_000 },
        },
      },
    });
    const { PATCH } = await import('@/app/api/tech-calendar/subscriptions/[id]/route');
    const res = await PATCH(req({ amount: 700_000, expected_updated_at: INITIAL_UPDATED_AT }), {
      params: Promise.resolve({ id: 'sub-1' }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(expect.objectContaining({ code: 'cost_limit_exceeded' }));
    expect(mockDb.getRows('tech_subscriptions')[0].amount).toBe(250);
  });

  it('не перезаписывает изменения другого администратора', async () => {
    mockDb = createMockSupabase({
      tables: {
        profiles: [{ id: ADMIN_ID, role: 'admin' }],
        tech_subscriptions: [subRow()],
      },
      beforeFirstUpdates: {
        tech_subscriptions: (rows) => rows.map((row) => ({
          ...row,
          amount: 275,
          updated_at: '2026-08-02T00:00:00.000Z',
        })),
      },
    });
    const { PATCH } = await import('@/app/api/tech-calendar/subscriptions/[id]/route');
    const res = await PATCH(req({ amount: 300, expected_updated_at: INITIAL_UPDATED_AT }), {
      params: Promise.resolve({ id: 'sub-1' }),
    });

    expect(res.status).toBe(409);
    expect(mockDb.getRows('tech_subscriptions')[0].amount).toBe(275);
  });

  it('не возвращает карточку на уже сохранённый в истории период', async () => {
    mockDb = createMockSupabase({
      tables: {
        profiles: [{ id: ADMIN_ID, role: 'admin' }],
        tech_subscriptions: [subRow({ status: 'active' })],
      },
      errorUpdates: {
        tech_subscriptions: {
          message: 'tech_subscription_cycle_already_archived',
          patchIncludes: { next_billing_date: '2026-07-20' },
        },
      },
    });
    const { PATCH } = await import('@/app/api/tech-calendar/subscriptions/[id]/route');
    const res = await PATCH(req({
      next_billing_date: '2026-07-20',
      expected_updated_at: INITIAL_UPDATED_AT,
    }), {
      params: Promise.resolve({ id: 'sub-1' }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(expect.objectContaining({
      code: 'tech_subscription_cycle_already_archived',
    }));
    expect(mockDb.getRows('tech_subscriptions')[0].next_billing_date).toBe('2026-08-20');
  });
});

describe('DELETE', () => {
  it('требует версию карточки для защиты от случайного удаления', async () => {
    const { DELETE } = await import('@/app/api/tech-calendar/subscriptions/[id]/route');
    const res = await DELETE(req(), { params: Promise.resolve({ id: 'sub-1' }) });

    expect(res.status).toBe(400);
    expect(mockDb.getRows('tech_subscriptions')).toHaveLength(1);
  });

  it('удаляет сервис', async () => {
    const { DELETE } = await import('@/app/api/tech-calendar/subscriptions/[id]/route');
    const res = await DELETE(req({ expected_updated_at: INITIAL_UPDATED_AT }), {
      params: Promise.resolve({ id: 'sub-1' }),
    });
    expect(res.status).toBe(200);
    expect(mockDb.getRows('tech_subscriptions')).toHaveLength(0);
  });

  it('отдаёт 404 на несуществующем сервисе', async () => {
    const { DELETE } = await import('@/app/api/tech-calendar/subscriptions/[id]/route');
    const res = await DELETE(req({ expected_updated_at: INITIAL_UPDATED_AT }), {
      params: Promise.resolve({ id: 'нет-такого' }),
    });
    expect(res.status).toBe(404);
  });

  it('не удаляет карточку, открытую до чужого изменения', async () => {
    mockDb = createTechCalendarDb([subRow({
      updated_at: '2026-08-02T00:00:00.000Z',
    })]);
    const { DELETE } = await import('@/app/api/tech-calendar/subscriptions/[id]/route');
    const res = await DELETE(req({ expected_updated_at: INITIAL_UPDATED_AT }), {
      params: Promise.resolve({ id: 'sub-1' }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(expect.objectContaining({ code: 'tech_subscription_conflict' }));
    expect(mockDb.getRows('tech_subscriptions')).toHaveLength(1);
  });
});
