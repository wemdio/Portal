/** @jest-environment node */

/**
 * Tests for the client domain-picker routes:
 *   /api/client/domains/suggestions (GET first-batch generation, POST
 *   regeneration from a manual brand) and /api/client/domains/selection
 *   (PUT validation + manager notification).
 *
 * Mocks follow clientSupportRoutes.test.ts: configurable auth, in-memory
 * supabase builder, jest.mock for the reg.ru batch check and the notify
 * fanout — no network, no real database.
 */

import type { NextRequest } from 'next/server';

// ── Configurable auth state ──────────────────────────────────────────────────

const clientAuthState = {
  authed: true,
  userId: 'client-A',
  isDemo: false,
};

jest.mock('@/lib/clientApiHelper', () => {
  const { NextResponse } = jest.requireActual('next/server');
  return {
    jsonError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
    requireClientAuth: jest.fn(async () => {
      if (!clientAuthState.authed) {
        return {
          error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
        };
      }
      return {
        auth: {
          userId: clientAuthState.userId,
          accessRows: [],
          isDemo: clientAuthState.isDemo,
        },
      };
    }),
  };
});

// ── In-memory supabase replacement ───────────────────────────────────────────

interface MockRow {
  [k: string]: unknown;
}

const dbState: Record<string, MockRow[]> = {};

function resetDb() {
  for (const key of Object.keys(dbState)) delete dbState[key];
}

function tableRows(table: string): MockRow[] {
  if (!dbState[table]) dbState[table] = [];
  return dbState[table];
}

function makeBuilder(table: string) {
  const eqs: Record<string, unknown> = {};
  const finalize = () => {
    let rows = tableRows(table).slice();
    for (const [col, val] of Object.entries(eqs)) {
      rows = rows.filter((r) => r[col] === val);
    }
    return rows;
  };

  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (col: string, val: unknown) => {
      eqs[col] = val;
      return builder;
    },
    maybeSingle: async () => ({ data: finalize()[0] ?? null, error: null }),
    single: async () => {
      const first = finalize()[0] ?? null;
      return { data: first, error: first ? null : { message: 'not found' } };
    },
    upsert: (payload: MockRow, options?: { onConflict?: string }) => {
      const list = tableRows(table);
      const conflict = options?.onConflict;
      const existing = conflict
        ? list.find((r) => r[conflict] === payload[conflict])
        : undefined;
      if (existing) Object.assign(existing, payload);
      else list.push({ ...payload });
      const self = {
        select: () => self,
        single: async () => ({ data: payload, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ data: payload, error: null }),
      };
      return self;
    },
    then: (resolve: (v: unknown) => void) => resolve({ data: finalize(), error: null }),
  };
  return builder;
}

jest.mock('@/lib/supabaseInstantly', () => ({
  supabaseInstantly: { from: (table: string) => makeBuilder(table) },
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: (table: string) => makeBuilder(table) },
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

jest.mock('@/lib/clientCache', () => ({
  invalidate: jest.fn(),
  cached: jest.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
}));

// reg.ru batch check — mocked; per-test availability via mockAvailability.
jest.mock('@/lib/regru/client', () => ({
  checkDomainsAvailable: jest.fn(),
}));

jest.mock('@/lib/clientDomains/notify', () => ({
  notifyManagersOfDomainSelection: jest.fn(async () => ({ inserted: 2 })),
  sendDomainSelectionTelegramAlert: jest.fn(async () => ({ sent: true, messageId: 1 })),
}));

import { checkDomainsAvailable } from '@/lib/regru/client';
import { notifyManagersOfDomainSelection } from '@/lib/clientDomains/notify';
import { invalidate } from '@/lib/clientCache';

const mockCheck = checkDomainsAvailable as unknown as jest.Mock;
const mockNotify = notifyManagersOfDomainSelection as unknown as jest.Mock;
const mockInvalidate = invalidate as unknown as jest.Mock;

function allAvailable(dnames: string[]) {
  return Object.fromEntries(dnames.map((d) => [d, true]));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(url: string, init: { method?: string; body?: unknown } = {}) {
  return new Request(url, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  }) as unknown as NextRequest;
}

const SUGGESTIONS_URL = 'http://x/api/client/domains/suggestions';
const SELECTION_URL = 'http://x/api/client/domains/selection';

const SUGGESTED_FIXTURE = [
  { domain: 'acme.ru', tld: 'ru', available: true, checked_at: '2026-07-25T00:00:00.000Z' },
  { domain: 'acme-hq.ru', tld: 'ru', available: true, checked_at: '2026-07-25T00:00:00.000Z' },
  { domain: 'acme-team.ru', tld: 'ru', available: false, checked_at: '2026-07-25T00:00:00.000Z' },
  { domain: 'acme.online', tld: 'online', available: true, checked_at: '2026-07-25T00:00:00.000Z' },
];

function seedSelectionRow(patch: Partial<MockRow> = {}) {
  tableRows('client_domain_selections').push({
    client_user_id: 'client-A',
    brand: 'acme',
    suggested: SUGGESTED_FIXTURE,
    selected: [],
    required_count: 3,
    status: 'suggested',
    ...patch,
  });
}

beforeEach(() => {
  resetDb();
  clientAuthState.authed = true;
  clientAuthState.userId = 'client-A';
  clientAuthState.isDemo = false;
  mockCheck.mockReset();
  mockCheck.mockImplementation(async (dnames: string[]) => allAvailable(dnames));
  mockNotify.mockClear();
  mockInvalidate.mockClear();
});

// ── GET suggestions ──────────────────────────────────────────────────────────

describe('GET /api/client/domains/suggestions', () => {
  it('401 without auth', async () => {
    clientAuthState.authed = false;
    const { GET } = await import('@/app/api/client/domains/suggestions/route');
    const res = await GET(makeReq(SUGGESTIONS_URL));
    expect(res.status).toBe(401);
  });

  it('existing row → returned as-is, no reg.ru call', async () => {
    seedSelectionRow();
    const { GET } = await import('@/app/api/client/domains/suggestions/route');
    const res = await GET(makeReq(SUGGESTIONS_URL));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.brand).toBe('acme');
    expect(json.required_count).toBe(3);
    expect(json.suggested.length).toBe(4);
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('no row + brief website → generates 2N offers and stores the row', async () => {
    tableRows('client_briefs').push({
      client_user_id: 'client-A',
      fields: { company_website: 'https://www.acme-sales.com/about' },
    });
    const { GET } = await import('@/app/api/client/domains/suggestions/route');
    const res = await GET(makeReq(SUGGESTIONS_URL));
    expect(res.status).toBe(200);
    const json = await res.json();
    // standard tariff (no client_tariffs row) → required 3 → 6 offers.
    expect(json.brand).toBe('acme-sales');
    expect(json.required_count).toBe(3);
    expect(json.suggested.length).toBe(6);
    expect(mockCheck).toHaveBeenCalledTimes(1);
    const stored = tableRows('client_domain_selections').find(
      (r) => r.client_user_id === 'client-A',
    );
    expect(stored?.brand).toBe('acme-sales');
    expect(stored?.status).toBe('suggested');
  });

  it('no brief website → brand null, empty offers, no reg.ru call', async () => {
    const { GET } = await import('@/app/api/client/domains/suggestions/route');
    const res = await GET(makeReq(SUGGESTIONS_URL));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.brand).toBeNull();
    expect(json.suggested).toEqual([]);
    expect(mockCheck).not.toHaveBeenCalled();
  });
});

// ── POST suggestions ─────────────────────────────────────────────────────────

describe('POST /api/client/domains/suggestions', () => {
  it('400 on cyrillic brand', async () => {
    const { POST } = await import('@/app/api/client/domains/suggestions/route');
    const res = await POST(makeReq(SUGGESTIONS_URL, { method: 'POST', body: { brand: 'пример' } }));
    expect(res.status).toBe(400);
  });

  it('400 on empty brand', async () => {
    const { POST } = await import('@/app/api/client/domains/suggestions/route');
    const res = await POST(makeReq(SUGGESTIONS_URL, { method: 'POST', body: { brand: '  ' } }));
    expect(res.status).toBe(400);
  });

  it('400 on a brand with a space (single latin word expected)', async () => {
    const { POST } = await import('@/app/api/client/domains/suggestions/route');
    const res = await POST(
      makeReq(SUGGESTIONS_URL, { method: 'POST', body: { brand: 'Orbita Group' } }),
    );
    expect(res.status).toBe(400);
  });

  it('regenerates from a valid manual brand and stores it', async () => {
    const { POST } = await import('@/app/api/client/domains/suggestions/route');
    const res = await POST(
      makeReq(SUGGESTIONS_URL, { method: 'POST', body: { brand: 'orbita', offset: 1 } }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.brand).toBe('orbita');
    expect(json.suggested.length).toBe(6);
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });
});

// ── PUT selection ────────────────────────────────────────────────────────────

describe('PUT /api/client/domains/selection', () => {
  it('401 without auth', async () => {
    clientAuthState.authed = false;
    const { PUT } = await import('@/app/api/client/domains/selection/route');
    const res = await PUT(makeReq(SELECTION_URL, { method: 'PUT', body: { selected: [] } }));
    expect(res.status).toBe(401);
  });

  it('409 when no suggestions row exists yet', async () => {
    const { PUT } = await import('@/app/api/client/domains/selection/route');
    const res = await PUT(
      makeReq(SELECTION_URL, { method: 'PUT', body: { selected: ['a.ru', 'b.ru', 'c.ru'] } }),
    );
    expect(res.status).toBe(409);
  });

  it('400 when selected is not an array', async () => {
    seedSelectionRow();
    const { PUT } = await import('@/app/api/client/domains/selection/route');
    const res = await PUT(makeReq(SELECTION_URL, { method: 'PUT', body: { selected: 'acme.ru' } }));
    expect(res.status).toBe(400);
  });

  it('400 on wrong count (must be exactly required_count)', async () => {
    seedSelectionRow();
    const { PUT } = await import('@/app/api/client/domains/selection/route');
    const res = await PUT(
      makeReq(SELECTION_URL, { method: 'PUT', body: { selected: ['acme.ru', 'acme-hq.ru'] } }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when a domain is not in the offered list', async () => {
    seedSelectionRow();
    const { PUT } = await import('@/app/api/client/domains/selection/route');
    const res = await PUT(
      makeReq(SELECTION_URL, {
        method: 'PUT',
        body: { selected: ['acme.ru', 'acme-hq.ru', 'evil-taken.ru'] },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when a domain was checked as unavailable', async () => {
    seedSelectionRow();
    const { PUT } = await import('@/app/api/client/domains/selection/route');
    const res = await PUT(
      makeReq(SELECTION_URL, {
        method: 'PUT',
        body: { selected: ['acme.ru', 'acme-hq.ru', 'acme-team.ru'] },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('200 on a valid full set: stores selection, notifies managers, invalidates cache', async () => {
    seedSelectionRow();
    tableRows('profiles').push({ id: 'client-A', full_name: 'Ольга', email: 'olga@acme.ru' });
    const { PUT } = await import('@/app/api/client/domains/selection/route');
    const res = await PUT(
      makeReq(SELECTION_URL, {
        method: 'PUT',
        body: { selected: ['acme.ru', 'acme-hq.ru', 'acme.online'] },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('selected');
    expect(json.selected).toEqual(['acme.ru', 'acme-hq.ru', 'acme.online']);

    const stored = tableRows('client_domain_selections').find(
      (r) => r.client_user_id === 'client-A',
    );
    expect(stored?.status).toBe('selected');
    expect(stored?.selected).toEqual(['acme.ru', 'acme-hq.ru', 'acme.online']);

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][0].domains).toEqual(['acme.ru', 'acme-hq.ru', 'acme.online']);
    expect(mockInvalidate).toHaveBeenCalledWith('client-onboarding:client-A');
  });

  it('selection of another client is unreachable: row lookup is scoped by auth userId', async () => {
    // Строка принадлежит client-B; client-A её не видит → 409 «нет вариантов».
    seedSelectionRow({ client_user_id: 'client-B' });
    const { PUT } = await import('@/app/api/client/domains/selection/route');
    const res = await PUT(
      makeReq(SELECTION_URL, {
        method: 'PUT',
        body: { selected: ['acme.ru', 'acme-hq.ru', 'acme.online'] },
      }),
    );
    expect(res.status).toBe(409);
  });
});
