/** @jest-environment node */

import type { NextRequest } from 'next/server';

const AUTH_USER_ID = 'client-user-cap';

// 60 «компаний» в базе под фильтр.
const DATASET = Array.from({ length: 60 }, (_, i) => ({
  id: i + 1,
  name: `Компания ${i + 1}`,
  inn: String(7700000000 + i),
}));

const mockSearchRows = jest.fn(
  async (_body: unknown, limit: number, offset: number = 0) => ({
    rows: DATASET.slice(offset, offset + limit) as Record<string, unknown>[],
  }),
);
const mockRecordSeen = jest.fn(async () => ({ ok: true }));
let mockMaxRows = 20;

jest.mock('@/lib/clientApiHelper', () => {
  const { NextResponse } = jest.requireActual('next/server');
  return {
    jsonError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
    requireClientAuth: jest.fn(async () => ({
      auth: { userId: AUTH_USER_ID, accessRows: [], isDemo: false },
    })),
  };
});

jest.mock('@/lib/companiesSearch/rpcSearch', () => ({
  searchRows: (...args: unknown[]) => mockSearchRows(...(args as [unknown, number, number])),
}));

jest.mock('@/lib/companiesSearch/seenJournal', () => ({
  recordSeenCompanies: (...args: unknown[]) => mockRecordSeen(...(args as [])),
  extractCompanyIds: (rows: Array<{ id: number }>) => rows.map((r) => r.id),
}));

jest.mock('@/lib/tariffs', () => ({
  getClientTariffRow: jest.fn(async () => ({})),
  resolveEffectiveLimits: jest.fn(() => ({ max_rows: mockMaxRows })),
  getBillingPeriodStart: jest.fn(() => '2026-07-01T00:00:00.000Z'),
  countClientRows: jest.fn(async () => 0),
  // Гейт оплаты: в этих тестах тариф оплачен (active) → пропускаем.
  getClientStatus: jest.fn(() => 'active'),
  isClientToolAccessAllowed: jest.fn(() => true),
  isAwaitingFirstPayment: jest.fn(() => false),
  TOOL_ACCESS_DENIED_MESSAGE: 'Подписка не активна. Оплатите тариф для продолжения работы.',
  AWAITING_PAYMENT_MESSAGE: 'Оформлена подписка, но оплата ещё не поступила. Доступ откроется после оплаты.',
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: () => ({ insert: async () => ({ error: null }) }),
  },
}));

function makeReq(): NextRequest {
  return new Request('http://x/api/client/companies-search/export?format=csv', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hasEmail: false }),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  jest.resetModules();
  mockSearchRows.mockClear();
  mockRecordSeen.mockClear();
});

describe('POST /api/client/companies-search/export — кап по остатку тарифа', () => {
  it('остаток 20 при 60 подходящих → в файле ровно 20 строк (не 60)', async () => {
    mockMaxRows = 20;
    const { POST } = await import('@/app/api/client/companies-search/export/route');
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1 + 20); // заголовок + 20 строк данных
    expect(res.headers.get('X-Rows-Count')).toBe('20');
    // Ни один запрос не просил больше остатка.
    for (const call of mockSearchRows.mock.calls) {
      expect(call[1]).toBeLessThanOrEqual(20);
    }
  });

  it('остаток больше выборки (100 > 60) → отдаются все 60', async () => {
    mockMaxRows = 100;
    const { POST } = await import('@/app/api/client/companies-search/export/route');
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1 + 60);
  });

  it('остаток 0 → 429, поиск не вызывается', async () => {
    mockMaxRows = 0;
    const { POST } = await import('@/app/api/client/companies-search/export/route');
    const res = await POST(makeReq());
    expect(res.status).toBe(429);
    expect(mockSearchRows).not.toHaveBeenCalled();
  });
});
