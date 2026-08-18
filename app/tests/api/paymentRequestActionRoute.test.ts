/** @jest-environment node */

import { NextRequest } from 'next/server';

const ACTION_ROUTE = '@/app/api/payments/[id]/route';
const ANYA_ID = '9e2c53fe-4b86-40b1-b464-757ffe0944dd';
const OTHER_ADMIN_ID = '00000000-0000-4000-8000-000000000002';
const REQUESTER_ID = '00000000-0000-4000-8000-000000000003';
const REQUEST_ID = '00000000-0000-4000-8000-000000000004';
const UPDATED_AT = '2026-08-18T10:00:00.000Z';

type ActionRouteModule = {
  PATCH: (
    request: NextRequest,
    context: { params: Promise<{ id: string }> },
  ) => Promise<Response>;
};

let mockCurrentUser: { id: string } | null = { id: ANYA_ID };
let mockCanManage = true;
let mockCapabilityError: { message: string } | null = null;
let mockTransitionError: { message: string; code?: string; details?: string } | null = null;
const mockRpc = jest.fn();
const mockLogAudit = jest.fn(async (..._args: unknown[]) => {});
const mockLogError = jest.fn(async (..._args: unknown[]) => {});

function rawRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    user_id: REQUESTER_ID,
    requester_name: 'Иван Петров',
    department: 'outreach',
    description: 'Исторический расход',
    amount: 10_000,
    project_id: null,
    project_name: null,
    project_client: null,
    comment: null,
    expense_type: 'legacy_unclassified',
    status: 'paid',
    approval_reason: null,
    expected_payment_on: '2026-08-01',
    paid_on: '2026-08-01',
    paid_on_source: 'legacy_created_at',
    urgency: 'normal',
    document_url: null,
    decided_by: null,
    decider_name: null,
    decided_at: null,
    decision_comment: null,
    paid_by: null,
    paid_by_name: null,
    paid_at: null,
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-18T10:00:01.000Z',
    ...overrides,
  };
}

function monthSummary(month: string) {
  return {
    limit: month.endsWith('-01') || month.endsWith('-05') || month.endsWith('-12')
      ? 40_000
      : 75_000,
    paidOneTime: 10_000,
    reservedOneTime: 0,
    usedOneTime: 10_000,
    remaining: 65_000,
    overage: 0,
    usagePct: 13.333333,
    level: 'normal',
    legacyCount: 0,
    legacyAmount: 0,
    paidAll: 10_000,
    pendingCount: 0,
    approvedCount: 0,
  };
}

function request(body: unknown, authenticated = true) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (authenticated) headers.set('authorization', 'Bearer test-token');
  return new NextRequest(`http://portal.local/api/payments/${REQUEST_ID}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
}

async function loadRoute(): Promise<ActionRouteModule> {
  return import(ACTION_ROUTE) as Promise<ActionRouteModule>;
}

async function patch(body: unknown) {
  const { PATCH } = await loadRoute();
  return PATCH(request(body), { params: Promise.resolve({ id: REQUEST_ID }) });
}

jest.mock('@/lib/supabaseRouteClient', () => ({
  getBearerToken: (header: string | null) => header?.replace(/^Bearer\s+/i, '') || null,
  createAuthedSupabaseClient: () => ({
    auth: {
      getUser: jest.fn(async () => ({ data: { user: mockCurrentUser }, error: null })),
    },
    rpc: (...args: unknown[]) => mockRpc(...args),
  }),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
  logError: (...args: unknown[]) => mockLogError(...args),
}));

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-08-18T09:00:00.000Z'));
  jest.resetModules();
  mockCurrentUser = { id: ANYA_ID };
  mockCanManage = true;
  mockCapabilityError = null;
  mockTransitionError = null;
  mockLogAudit.mockClear();
  mockLogError.mockClear();
  mockRpc.mockReset();
  mockRpc.mockImplementation(async (fn: string, params: Record<string, unknown> = {}) => {
    if (fn === 'can_manage_payment_requests') {
      return { data: mockCanManage, error: mockCapabilityError };
    }
    if (fn === 'payment_request_month_summary') {
      const month = String(params.p_month).slice(0, 7);
      return { data: monthSummary(month), error: null };
    }
    if (fn !== 'transition_payment_request') {
      return { data: null, error: { message: `Unexpected RPC ${fn}` } };
    }
    if (mockTransitionError) return { data: null, error: mockTransitionError };

    const action = String(params.p_action);
    const outcomeByAction: Record<string, string> = {
      approve: 'approved',
      reject: 'rejected',
      mark_paid: 'paid',
      classify_legacy: 'legacy_classified',
    };
    const affectedMonths = action === 'classify_legacy'
      ? ['2026-07', '2026-08']
      : ['2026-08'];
    return {
      data: {
        request: rawRequest({
          status: action === 'reject'
            ? 'rejected'
            : action === 'approve'
              ? 'approved'
              : 'paid',
          expense_type: action === 'classify_legacy'
            ? params.p_expense_type
            : 'one_time',
          paid_on: params.p_paid_on ?? null,
          expected_payment_on: action === 'classify_legacy'
            ? params.p_paid_on
            : '2026-08-25',
          paid_on_source: action === 'mark_paid' || action === 'classify_legacy'
            ? 'entered'
            : null,
          decision_comment: params.p_decision_comment ?? null,
        }),
        affectedMonths,
        summaries: affectedMonths.map((month) => ({ month, summary: monthSummary(month) })),
        outcome: outcomeByAction[action],
      },
      error: null,
    };
  });
});

afterAll(() => {
  jest.useRealTimers();
});

describe('PATCH /api/payments/[id]', () => {
  it.each([
    ['approve', { decisionComment: 'Согласовано' }, 'approved'],
    ['reject', { decisionComment: 'Не относится к расходам компании' }, 'rejected'],
    ['mark_paid', { paidOn: '2026-08-18' }, 'paid'],
  ])('runs the closed %s transition through the manager RPC', async (
    action,
    actionFields,
    outcome,
  ) => {
    const response = await patch({
      action,
      expectedUpdatedAt: UPDATED_AT,
      ...actionFields,
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('transition_payment_request', {
      p_request_id: REQUEST_ID,
      p_action: action,
      p_expected_updated_at: UPDATED_AT,
      p_decision_comment: 'decisionComment' in actionFields
        ? actionFields.decisionComment
        : null,
      p_paid_on: 'paidOn' in actionFields ? actionFields.paidOn : null,
      p_expense_type: null,
    });
    expect(body).toEqual(expect.objectContaining({
      request: expect.objectContaining({ status: outcome }),
      summaries: [{ month: '2026-08', summary: monthSummary('2026-08') }],
      outcome,
    }));
    expect(mockRpc).not.toHaveBeenCalledWith('payment_request_month_summary', expect.anything());
  });

  it('classifies legacy only with the real paid date and returns old plus new month summaries', async () => {
    const response = await patch({
      action: 'classify_legacy',
      expectedUpdatedAt: UPDATED_AT,
      expenseType: 'planned',
      paidOn: '2026-07-31',
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('transition_payment_request', {
      p_request_id: REQUEST_ID,
      p_action: 'classify_legacy',
      p_expected_updated_at: UPDATED_AT,
      p_decision_comment: null,
      p_paid_on: '2026-07-31',
      p_expense_type: 'planned',
    });
    expect(body.request).toEqual(expect.objectContaining({
      expenseType: 'planned',
      status: 'paid',
      paidOn: '2026-07-31',
      expectedPaymentOn: '2026-07-31',
      paidOnSource: 'entered',
    }));
    expect(body.summaries).toEqual([
      { month: '2026-07', summary: monthSummary('2026-07') },
      { month: '2026-08', summary: monthSummary('2026-08') },
    ]);
    expect(body.outcome).toBe('legacy_classified');
  });

  it('allows only the capability holder, not a generic admin', async () => {
    mockCurrentUser = { id: OTHER_ADMIN_ID };
    mockCanManage = false;

    const response = await patch({
      action: 'approve',
      expectedUpdatedAt: UPDATED_AT,
    });

    expect(response.status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalledWith('transition_payment_request', expect.anything());
  });

  it('fails closed if the manager capability cannot be checked', async () => {
    mockCapabilityError = { message: 'database unavailable' };

    const response = await patch({
      action: 'approve',
      expectedUpdatedAt: UPDATED_AT,
    });

    expect(response.status).toBe(500);
    expect(mockRpc).not.toHaveBeenCalledWith('transition_payment_request', expect.anything());
  });

  it('requires a bearer-backed user session', async () => {
    const { PATCH } = await loadRoute();
    const noToken = await PATCH(request({
      action: 'approve',
      expectedUpdatedAt: UPDATED_AT,
    }, false), { params: Promise.resolve({ id: REQUEST_ID }) });
    mockCurrentUser = null;
    const noUser = await PATCH(request({
      action: 'approve',
      expectedUpdatedAt: UPDATED_AT,
    }), { params: Promise.resolve({ id: REQUEST_ID }) });

    expect([noToken.status, noUser.status]).toEqual([401, 401]);
  });

  it('requires CAS before attempting any mutation', async () => {
    const response = await patch({ action: 'approve' });
    const body = await response.json();

    expect(response.status).toBe(428);
    expect(body).toEqual(expect.objectContaining({ code: 'precondition_required' }));
    expect(mockRpc).not.toHaveBeenCalledWith('transition_payment_request', expect.anything());
  });

  it.each([
    ['invalid CAS timestamp', { action: 'approve', expectedUpdatedAt: '2026-08-18 10:00' }],
    ['unknown action', { action: 'delete', expectedUpdatedAt: UPDATED_AT }],
    ['reject without a reason', { action: 'reject', expectedUpdatedAt: UPDATED_AT }],
    ['mark paid without paidOn', { action: 'mark_paid', expectedUpdatedAt: UPDATED_AT }],
    [
      'mark paid with a future Moscow date',
      { action: 'mark_paid', expectedUpdatedAt: UPDATED_AT, paidOn: '2026-08-19' },
    ],
    [
      'classify legacy without an expense type',
      { action: 'classify_legacy', expectedUpdatedAt: UPDATED_AT, paidOn: '2026-08-01' },
    ],
    [
      'classify legacy without the real paid date',
      { action: 'classify_legacy', expectedUpdatedAt: UPDATED_AT, expenseType: 'one_time' },
    ],
    [
      'classify legacy to an internal-only legacy type',
      {
        action: 'classify_legacy',
        expectedUpdatedAt: UPDATED_AT,
        expenseType: 'legacy_unclassified',
        paidOn: '2026-08-01',
      },
    ],
    [
      'approve with paid fields',
      { action: 'approve', expectedUpdatedAt: UPDATED_AT, paidOn: '2026-08-01' },
    ],
    [
      'caller-controlled status',
      { action: 'approve', expectedUpdatedAt: UPDATED_AT, status: 'paid' },
    ],
  ])('rejects %s before calling the transition RPC', async (_case, payload) => {
    const response = await patch(payload);

    expect(response.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalledWith('transition_payment_request', expect.anything());
  });

  it.each([
    ['payment_request_conflict', 409, 'payment_request_conflict'],
    ['payment_request_invalid_transition', 409, 'invalid_transition'],
    ['payment_request_not_found', 404, 'payment_request_not_found'],
    ['payment_request_forbidden', 403, 'payment_request_forbidden'],
  ])('maps the RPC domain error %s to HTTP %d', async (message, status, code) => {
    mockTransitionError = { message, code: 'P0001' };

    const response = await patch({
      action: 'approve',
      expectedUpdatedAt: UPDATED_AT,
    });
    const body = await response.json();

    expect(response.status).toBe(status);
    expect(body.code).toBe(code);
    expect(mockLogAudit).not.toHaveBeenCalledWith(
      'payments.transition.success',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('fails closed on an unknown database error', async () => {
    mockTransitionError = { message: 'unexpected database failure' };

    const response = await patch({
      action: 'approve',
      expectedUpdatedAt: UPDATED_AT,
    });

    expect(response.status).toBe(500);
    expect(mockLogError).toHaveBeenCalled();
  });
});
