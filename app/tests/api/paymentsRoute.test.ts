/** @jest-environment node */

import { NextRequest } from 'next/server';
import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

const PAYMENTS_ROUTE = '@/app/api/payments/route';
const ANYA_ID = '9e2c53fe-4b86-40b1-b464-757ffe0944dd';
const REQUESTER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_STAFF_ID = '00000000-0000-4000-8000-000000000002';
const PROJECT_ID = '00000000-0000-4000-8000-000000000003';
const REQUEST_ID = '00000000-0000-4000-8000-000000000004';
const IDEMPOTENCY_KEY = '00000000-0000-4000-8000-000000000005';

type PaymentsRouteModule = {
  GET: (request: NextRequest) => Promise<Response>;
  POST: (request: NextRequest) => Promise<Response>;
};

let mockMainDb: MockSupabaseClient = createMockSupabase();
let mockCurrentUser: { id: string } | null = { id: OTHER_STAFF_ID };
let mockCanUse = true;
let mockCanManage = false;
let mockCapabilityError: { message: string } | null = null;
let mockListError: { message: string } | null = null;
let mockSummaryError: { message: string } | null = null;
let mockSubmitError: { message: string; code?: string } | null = null;
const mockRpc = jest.fn();
const mockGetUser = jest.fn();
const mockLogAudit = jest.fn(async (..._args: unknown[]) => {});
const mockLogError = jest.fn(async (..._args: unknown[]) => {});

function rawRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    user_id: REQUESTER_ID,
    requester_name: 'Иван Петров',
    department: 'outreach',
    description: 'Разовая база контактов',
    amount: 10_000,
    project_id: PROJECT_ID,
    project_name: 'Аутрич',
    project_client: 'Acme',
    comment: 'Для теста нового сегмента',
    expense_type: 'one_time',
    budget_scope: 'general',
    cost_category: null,
    status: 'approved',
    approval_reason: null,
    expected_payment_on: '2026-08-25',
    paid_on: null,
    paid_on_source: null,
    urgency: 'urgent',
    document_url: 'https://docs.example.com/invoice.pdf',
    decided_by: null,
    decider_name: null,
    decided_at: null,
    decision_comment: null,
    paid_by: null,
    paid_by_name: null,
    paid_at: null,
    created_at: '2026-08-18T10:00:00.000Z',
    updated_at: '2026-08-18T10:00:00.000Z',
    ...overrides,
  };
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    limit: 75_000,
    paidOneTime: 12_000,
    reservedOneTime: 10_000,
    usedOneTime: 22_000,
    remaining: 53_000,
    overage: 0,
    usagePct: 29.333333,
    level: 'normal',
    legacyCount: 2,
    legacyAmount: 4_500,
    paidAll: 17_000,
    pendingCount: 1,
    approvedCount: 1,
    costBudget: {
      limit: 650_000,
      paid: 50_000,
      reserved: 100_000,
      used: 150_000,
      remaining: 500_000,
      overage: 0,
      usagePct: 23.076923,
      level: 'normal',
      dataComplete: true,
      missingFxCount: 0,
      mailPaid: 20_000,
      mailReserved: 30_000,
      manualPaid: 30_000,
      manualReserved: 70_000,
      byCategory: {
        instantly: { paid: 30_000, reserved: 70_000 },
        email: { paid: 20_000, reserved: 30_000 },
        bases: { paid: 0, reserved: 0 },
        domains: { paid: 0, reserved: 0 },
        other: { paid: 0, reserved: 0 },
      },
    },
    ...overrides,
  };
}

function request(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    authenticated?: boolean;
    idempotencyKey?: string | null;
  } = {},
) {
  const headers = new Headers();
  const method = init.method ?? 'GET';
  if (init.authenticated !== false) headers.set('authorization', 'Bearer test-token');
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  if (method === 'POST' && init.idempotencyKey !== null) {
    headers.set('idempotency-key', init.idempotencyKey ?? IDEMPOTENCY_KEY);
  }
  return new NextRequest(`http://portal.local${path}`, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    department: 'outreach',
    description: 'Разовая база контактов',
    amount: 10_000,
    projectId: PROJECT_ID,
    comment: 'Для теста нового сегмента',
    expenseType: 'one_time',
    budgetScope: 'general',
    costCategory: null,
    expectedPaymentOn: '2026-08-25',
    urgency: 'urgent',
    documentUrl: 'https://docs.example.com/invoice.pdf',
    ...overrides,
  };
}

async function loadRoute(): Promise<PaymentsRouteModule> {
  return import(PAYMENTS_ROUTE) as Promise<PaymentsRouteModule>;
}

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockMainDb;
  },
}));

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: (header: string | null) => header?.replace(/^Bearer\s+/i, '') || null,
  createAuthedSupabaseClient: () => ({
    auth: {
      getUser: (...args: unknown[]) => mockGetUser(...args),
    },
    rpc: (...args: unknown[]) => mockRpc(...args),
  }),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
  logError: (...args: unknown[]) => mockLogError(...args),
}));

beforeEach(() => {
  jest.resetModules();
  mockCurrentUser = { id: OTHER_STAFF_ID };
  mockCanUse = true;
  mockCanManage = false;
  mockCapabilityError = null;
  mockListError = null;
  mockSummaryError = null;
  mockSubmitError = null;
  mockLogAudit.mockClear();
  mockLogError.mockClear();
  mockMainDb = createMockSupabase({
    tables: {
      projects: [{ id: PROJECT_ID, client: 'Acme', name: 'Аутрич' }],
    },
  });
  mockRpc.mockReset();
  mockGetUser.mockReset();
  mockGetUser.mockImplementation(async () => ({
    data: { user: mockCurrentUser },
    error: null,
  }));
  mockRpc.mockImplementation(async (fn: string, params: Record<string, unknown> = {}) => {
    switch (fn) {
      case 'can_use_payment_requests':
        return { data: mockCanUse, error: mockCapabilityError };
      case 'can_manage_payment_requests':
        return { data: mockCanManage, error: mockCapabilityError };
      case 'list_payment_requests_with_budget':
        return { data: [rawRequest()], error: mockListError };
      case 'payment_request_month_summary':
        return { data: summary(), error: mockSummaryError };
      case 'submit_payment_request_with_budget': {
        const isCosts = params.p_budget_scope === 'costs';
        const needsApproval = !isCosts && (
          params.p_expense_type === 'planned' || Number(params.p_amount) > 53_000
        );
        return {
          data: {
            request: rawRequest({
              expense_type: params.p_expense_type,
              budget_scope: params.p_budget_scope,
              cost_category: params.p_cost_category,
              expected_payment_on: params.p_expected_payment_on,
              urgency: params.p_urgency,
              amount: params.p_amount,
              status: needsApproval ? 'pending' : 'approved',
              approval_reason: !isCosts && params.p_expense_type === 'planned'
                ? 'planned'
                : needsApproval
                  ? 'limit_exceeded'
                  : null,
            }),
            summary: summary(),
            outcome: needsApproval ? 'approval_required' : 'auto_approved',
          },
          error: mockSubmitError,
        };
      }
      default:
        return { data: null, error: { message: `Unexpected RPC ${fn}` } };
    }
  });
});

describe('GET /api/payments', () => {
  it('returns the canonical month, summary, request and project read model', async () => {
    const { GET } = await loadRoute();
    const response = await GET(request('/api/payments?month=2026-08'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.period).toEqual({
      key: '2026-08',
      label: 'Август 2026',
      previous: '2026-07',
      next: '2026-09',
      asOf: expect.any(String),
    });
    expect(body.summary).toEqual(summary());
    expect(body.canManage).toBe(false);
    expect(body.projects).toEqual([
      { id: PROJECT_ID, client: 'Acme', name: 'Аутрич' },
    ]);
    expect(body.requests).toEqual([
      expect.objectContaining({
        id: REQUEST_ID,
        requester: {
          id: REQUESTER_ID,
          name: 'Иван Петров',
        },
        department: 'outreach',
        description: 'Разовая база контактов',
        amount: 10_000,
        project: { id: PROJECT_ID, client: 'Acme', name: 'Аутрич' },
        comment: 'Для теста нового сегмента',
        expenseType: 'one_time',
        budgetScope: 'general',
        costCategory: null,
        status: 'approved',
        approvalReason: null,
        expectedPaymentOn: '2026-08-25',
        paidOn: null,
        paidOnSource: null,
        urgency: 'urgent',
        documentUrl: null,
        createdAt: '2026-08-18T10:00:00.000Z',
        updatedAt: '2026-08-18T10:00:00.000Z',
      }),
    ]);
    expect(mockRpc).toHaveBeenCalledWith('list_payment_requests_with_budget', {
      p_month: '2026-08-01',
    });
    expect(mockRpc).toHaveBeenCalledWith('payment_request_month_summary', {
      p_month: '2026-08-01',
    });
  });

  it.each([
    [REQUESTER_ID, false],
    [ANYA_ID, true],
  ])('shows documentUrl to its requester or Anya (%s)', async (userId, canManage) => {
    mockCurrentUser = { id: userId };
    mockCanManage = canManage;
    const { GET } = await loadRoute();

    const response = await GET(request('/api/payments?month=2026-08'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.requests[0].documentUrl).toBe('https://docs.example.com/invoice.pdf');
  });

  it.each([
    ['1000-01', '1000-01', '1000-02'],
    ['9999-12', '9999-11', '9999-12'],
  ])('keeps period navigation inside the supported year range for %s', async (
    month,
    previous,
    next,
  ) => {
    const { GET } = await loadRoute();

    const response = await GET(request(`/api/payments?month=${month}`));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.period).toEqual(expect.objectContaining({ key: month, previous, next }));
  });

  it.each(['0000-01', '0999-12', '2026-8', '2026-13', '08-2026', 'not-a-month']) (
    'rejects an invalid month before reading payment data: %s',
    async (month) => {
      const { GET } = await loadRoute();
      const response = await GET(request(`/api/payments?month=${month}`));

      expect(response.status).toBe(400);
      expect(mockRpc).not.toHaveBeenCalledWith('list_payment_requests_with_budget', expect.anything());
    },
  );

  it('fails closed when staff capability lookup errors', async () => {
    mockCapabilityError = { message: 'database unavailable' };
    const { GET } = await loadRoute();

    const response = await GET(request('/api/payments?month=2026-08'));

    expect(response.status).toBe(500);
    expect(mockRpc).not.toHaveBeenCalledWith('list_payment_requests_with_budget', expect.anything());
  });

  it('denies clients and demo/unknown users before reading any request', async () => {
    mockCanUse = false;
    const { GET } = await loadRoute();

    const response = await GET(request('/api/payments?month=2026-08'));

    expect(response.status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalledWith('list_payment_requests_with_budget', expect.anything());
    expect(mockMainDb.selects).toHaveLength(0);
  });

  it('requires a bearer session', async () => {
    const { GET } = await loadRoute();
    const withoutToken = await GET(request('/api/payments?month=2026-08', {
      authenticated: false,
    }));
    mockCurrentUser = null;
    const withoutUser = await GET(request('/api/payments?month=2026-08'));

    expect([withoutToken.status, withoutUser.status]).toEqual([401, 401]);
  });

  it.each([
    ['returned', 401],
    ['returned', 403],
    ['thrown', 401],
    ['thrown', 403],
  ] as const)(
    'treats an explicitly invalid bearer session as 401 without infrastructure logging (%s %s)',
    async (delivery, status) => {
      const authError = Object.assign(new Error('invalid session'), { status });
      if (delivery === 'returned') {
        mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: authError });
      } else {
        mockGetUser.mockRejectedValueOnce(authError);
      }
      const { GET } = await loadRoute();

      const response = await GET(request('/api/payments?month=2026-08'));

      expect(response.status).toBe(401);
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockMainDb.selects).toHaveLength(0);
      expect(mockLogError).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 503] as const)(
    'fails closed and logs an auth infrastructure error returned by getUser (%s)',
    async (status) => {
      const authError = status === undefined
        ? { message: 'auth unavailable' }
        : { message: 'auth unavailable', status };
      mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: authError });
      const { GET } = await loadRoute();

      const response = await GET(request('/api/payments?month=2026-08'));

      expect(response.status).toBe(500);
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockMainDb.selects).toHaveLength(0);
      expect(mockLogError).toHaveBeenCalledWith(
        'payments.auth.failed',
        authError,
        {},
        expect.objectContaining({ userId: null, route: '/api/payments' }),
      );
    },
  );

  it('fails closed and logs a thrown auth infrastructure error', async () => {
    const authError = new Error('auth transport unavailable');
    mockGetUser.mockRejectedValueOnce(authError);
    const { GET } = await loadRoute();

    const response = await GET(request('/api/payments?month=2026-08'));

    expect(response.status).toBe(500);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockMainDb.selects).toHaveLength(0);
    expect(mockLogError).toHaveBeenCalledWith(
      'payments.auth.failed',
      authError,
      {},
      expect.objectContaining({ userId: null, route: '/api/payments' }),
    );
  });
});

describe('POST /api/payments', () => {
  it('derives the actor server-side and submits a valid one-time expense through the atomic RPC', async () => {
    const { POST } = await loadRoute();
    const response = await POST(request('/api/payments', {
      method: 'POST',
      body: validPayload(),
    }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(mockRpc).toHaveBeenCalledWith('submit_payment_request_with_budget', {
      p_idempotency_key: IDEMPOTENCY_KEY,
      p_department: 'outreach',
      p_description: 'Разовая база контактов',
      p_amount: 10_000,
      p_project_id: PROJECT_ID,
      p_comment: 'Для теста нового сегмента',
      p_expense_type: 'one_time',
      p_budget_scope: 'general',
      p_cost_category: null,
      p_expected_payment_on: '2026-08-25',
      p_urgency: 'urgent',
      p_document_url: 'https://docs.example.com/invoice.pdf',
    });
    const submitCall = mockRpc.mock.calls.find(([fn]) => fn === 'submit_payment_request_with_budget');
    expect(submitCall?.[1]).not.toEqual(expect.objectContaining({
      p_user_id: expect.anything(),
      p_actor_id: expect.anything(),
      p_status: expect.anything(),
    }));
    expect(body).toEqual(expect.objectContaining({
      request: expect.objectContaining({
        expenseType: 'one_time',
        status: 'approved',
      }),
      summary: summary(),
      outcome: 'auto_approved',
    }));
    expect(mockRpc).not.toHaveBeenCalledWith('payment_request_month_summary', expect.anything());
  });

  it('preserves a caller-generated idempotency key across a safe retry', async () => {
    const { POST } = await loadRoute();
    const first = await POST(request('/api/payments', {
      method: 'POST',
      body: validPayload(),
      idempotencyKey: IDEMPOTENCY_KEY,
    }));
    const retry = await POST(request('/api/payments', {
      method: 'POST',
      body: validPayload(),
      idempotencyKey: IDEMPOTENCY_KEY,
    }));

    expect([first.status, retry.status]).toEqual([201, 201]);
    await expect(first.json()).resolves.toEqual(expect.objectContaining({
      request: expect.objectContaining({ id: REQUEST_ID }),
    }));
    await expect(retry.json()).resolves.toEqual(expect.objectContaining({
      request: expect.objectContaining({ id: REQUEST_ID }),
    }));
    const submitCalls = mockRpc.mock.calls.filter(([fn]) => fn === 'submit_payment_request_with_budget');
    expect(submitCalls).toHaveLength(2);
    expect(submitCalls.map(([, params]) => params)).toEqual([
      expect.objectContaining({ p_idempotency_key: IDEMPOTENCY_KEY }),
      expect.objectContaining({ p_idempotency_key: IDEMPOTENCY_KEY }),
    ]);
  });

  it.each([
    ['missing', null],
    ['blank', ''],
    ['not a UUID', 'retry-me'],
  ])('rejects a %s Idempotency-Key before the submit RPC', async (_case, idempotencyKey) => {
    const { POST } = await loadRoute();
    const response = await POST(request('/api/payments', {
      method: 'POST',
      body: validPayload(),
      idempotencyKey,
    }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe('invalid_idempotency_key');
    expect(mockRpc).not.toHaveBeenCalledWith('submit_payment_request_with_budget', expect.anything());
  });

  it('returns 409 when the same actor reuses a key for a different canonical payload', async () => {
    mockSubmitError = {
      message: 'payment_request_idempotency_conflict',
      code: '23505',
    };
    const { POST } = await loadRoute();

    const response = await POST(request('/api/payments', {
      method: 'POST',
      body: validPayload({ amount: 12_000 }),
      idempotencyKey: IDEMPOTENCY_KEY,
    }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe('idempotency_conflict');
    expect(mockRpc).toHaveBeenCalledWith('submit_payment_request_with_budget', expect.objectContaining({
      p_idempotency_key: IDEMPOTENCY_KEY,
      p_amount: 12_000,
    }));
    expect(mockLogAudit).not.toHaveBeenCalledWith(
      'payments.create.success',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('keeps every planned expense pending even when the month has room', async () => {
    const { POST } = await loadRoute();
    const response = await POST(request('/api/payments', {
      method: 'POST',
      body: validPayload({ expenseType: 'planned' }),
    }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual(expect.objectContaining({
      outcome: 'approval_required',
      request: expect.objectContaining({
        expenseType: 'planned',
        status: 'pending',
        approvalReason: 'planned',
      }),
    }));
  });

  it('returns approval_required when a one-time expense is over the signed remaining amount', async () => {
    const { POST } = await loadRoute();
    const response = await POST(request('/api/payments', {
      method: 'POST',
      body: validPayload({ amount: 60_000 }),
    }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual(expect.objectContaining({
      outcome: 'approval_required',
      request: expect.objectContaining({
        expenseType: 'one_time',
        status: 'pending',
        approvalReason: 'limit_exceeded',
      }),
    }));
  });

  it('submits a categorized cost through the independent 650,000 RUB budget', async () => {
    const { POST } = await loadRoute();
    const response = await POST(request('/api/payments', {
      method: 'POST',
      body: validPayload({
        amount: 120_000,
        budgetScope: 'costs',
        costCategory: 'domains',
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(mockRpc).toHaveBeenCalledWith('submit_payment_request_with_budget', expect.objectContaining({
      p_amount: 120_000,
      p_budget_scope: 'costs',
      p_cost_category: 'domains',
    }));
    expect(body).toEqual(expect.objectContaining({
      outcome: 'auto_approved',
      request: expect.objectContaining({
        budgetScope: 'costs',
        costCategory: 'domains',
        status: 'approved',
      }),
    }));
  });

  it.each([
    ['missing category', { budgetScope: 'costs', costCategory: null }],
    ['unknown category', { budgetScope: 'costs', costCategory: 'hosting' }],
    ['category on general expense', { budgetScope: 'general', costCategory: 'domains' }],
    ['unknown budget scope', { budgetScope: 'subscriptions', costCategory: null }],
  ])('rejects an inconsistent cost classification: %s', async (_case, overrides) => {
    const { POST } = await loadRoute();
    const response = await POST(request('/api/payments', {
      method: 'POST',
      body: validPayload(overrides),
    }));

    expect(response.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalledWith('submit_payment_request_with_budget', expect.anything());
  });

  it('fails closed when the 650,000 RUB cost limit would be exceeded', async () => {
    mockSubmitError = { message: 'payment_request_cost_limit_exceeded', code: 'P0001' };
    const { POST } = await loadRoute();
    const response = await POST(request('/api/payments', {
      method: 'POST',
      body: validPayload({ budgetScope: 'costs', costCategory: 'instantly' }),
    }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe('cost_limit_exceeded');
  });

  it('fails closed when the mail-calendar budget cannot be converted to RUB', async () => {
    mockSubmitError = { message: 'payment_request_cost_budget_incomplete', code: 'P0001' };
    const { POST } = await loadRoute();
    const response = await POST(request('/api/payments', {
      method: 'POST',
      body: validPayload({ budgetScope: 'costs', costCategory: 'bases' }),
    }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe('cost_budget_incomplete');
  });

  it.each([
    ['legacy type', { expenseType: 'legacy_unclassified' }],
    ['unknown type', { expenseType: 'subscription' }],
    ['unknown urgency', { urgency: 'asap' }],
    ['bad expected date', { expectedPaymentOn: '25.08.2026' }],
    ['non-http document URL', { documentUrl: 'javascript:alert(1)' }],
    ['nonpositive amount', { amount: 0 }],
    ['unknown department', { department: 'unknown' }],
  ])('rejects %s without calling the submit RPC', async (_case, overrides) => {
    const { POST } = await loadRoute();
    const response = await POST(request('/api/payments', {
      method: 'POST',
      body: validPayload(overrides),
    }));

    expect(response.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalledWith('submit_payment_request_with_budget', expect.anything());
  });

  it.each([
    { userId: ANYA_ID },
    { status: 'approved' },
    { paidOn: '2026-08-25' },
    { approvalReason: null },
    { decidedBy: ANYA_ID },
  ])('rejects caller-controlled lifecycle/identity fields: %o', async (privilegedField) => {
    const { POST } = await loadRoute();
    const response = await POST(request('/api/payments', {
      method: 'POST',
      body: validPayload(privilegedField),
    }));

    expect(response.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalledWith('submit_payment_request_with_budget', expect.anything());
  });

  it('denies a non-staff caller before the write RPC', async () => {
    mockCanUse = false;
    const { POST } = await loadRoute();
    const response = await POST(request('/api/payments', {
      method: 'POST',
      body: validPayload(),
    }));

    expect(response.status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalledWith('submit_payment_request_with_budget', expect.anything());
  });

  it('fails closed when the atomic submit RPC errors and never reports success', async () => {
    mockSubmitError = { message: 'payment budget unavailable', code: 'P0001' };
    const { POST } = await loadRoute();
    const response = await POST(request('/api/payments', {
      method: 'POST',
      body: validPayload(),
    }));

    expect(response.status).toBe(500);
    expect(mockLogAudit).not.toHaveBeenCalledWith(
      'payments.create.success',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('maps a removed or unknown project to a validation response', async () => {
    mockSubmitError = { message: 'payment_request_project_not_found', code: 'P0002' };
    const { POST } = await loadRoute();

    const response = await POST(request('/api/payments', {
      method: 'POST',
      body: validPayload(),
    }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe('invalid_project');
    expect(mockLogAudit).not.toHaveBeenCalledWith(
      'payments.create.success',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});
