import 'server-only';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { currentMoscowDate } from '@/lib/calendarDate';
import { logError } from '@/lib/loggerServer';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import type {
  PaymentApprovalReason,
  PaymentBudgetScope,
  PaymentBudgetLevel,
  PaymentCostBudgetSummary,
  PaymentCostCategory,
  PaymentCostCategoryTotals,
  PaymentDepartment,
  PaymentExpenseType,
  PaymentMonthSummary,
  PaymentPaidOnSource,
  PaymentPerson,
  PaymentRequest,
  PaymentRequestStatus,
  PaymentUrgency,
} from './types';

type AuthedClient = ReturnType<typeof createAuthedSupabaseClient>;
type JsonError = NextResponse<{ error: string; code?: string }>;

export type PaymentsActor = {
  userId: string;
  canManage: boolean;
  client: AuthedClient;
};

export function jsonError(message: string, status: number, code?: string): JsonError {
  return NextResponse.json(code ? { error: message, code } : { error: message }, { status });
}

export function paymentLogMeta(req: NextRequest, userId: string | null) {
  return {
    userId,
    requestId: req.headers.get('x-request-id') ?? crypto.randomUUID(),
    route: req.nextUrl.pathname,
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  };
}

function isInvalidSessionAuthError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403;
}

async function readCapability(
  req: NextRequest,
  client: AuthedClient,
  functionName: 'can_use_payment_requests' | 'can_manage_payment_requests',
  userId: string,
): Promise<{ allowed: boolean } | { error: JsonError }> {
  const { data, error } = await client.rpc(functionName);
  if (!error) return { allowed: data === true };
  await logError(
    'payments.auth.failed',
    error,
    { capability: functionName },
    paymentLogMeta(req, userId),
  );
  return { error: jsonError('Failed to verify access', 500) };
}

export async function authenticatePaymentsRequest(
  req: NextRequest,
  required: 'use' | 'manage' = 'use',
): Promise<{ actor: PaymentsActor } | { error: JsonError }> {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  let userId: string | null = null;
  try {
    const client = createAuthedSupabaseClient(token);
    const authResult = await (async () => {
      try {
        return await client.auth.getUser();
      } catch (error) {
        if (isInvalidSessionAuthError(error)) return null;
        throw error;
      }
    })();
    if (authResult === null) return { error: jsonError('Unauthorized', 401) };
    if (authResult.error) {
      if (isInvalidSessionAuthError(authResult.error)) {
        return { error: jsonError('Unauthorized', 401) };
      }
      await logError(
        'payments.auth.failed',
        authResult.error,
        {},
        paymentLogMeta(req, userId),
      );
      return { error: jsonError('Failed to verify access', 500) };
    }
    const user = authResult.data.user;
    if (!user) return { error: jsonError('Unauthorized', 401) };
    userId = user.id;

    if (required === 'manage') {
      const management = await readCapability(
        req,
        client,
        'can_manage_payment_requests',
        userId,
      );
      if ('error' in management) return management;
      if (!management.allowed) return { error: jsonError('Forbidden', 403) };
      return { actor: { userId, canManage: true, client } };
    }

    const usage = await readCapability(req, client, 'can_use_payment_requests', userId);
    if ('error' in usage) return usage;
    if (!usage.allowed) return { error: jsonError('Forbidden', 403) };
    const management = await readCapability(
      req,
      client,
      'can_manage_payment_requests',
      userId,
    );
    if ('error' in management) return management;
    return { actor: { userId, canManage: management.allowed, client } };
  } catch (error) {
    await logError(
      'payments.auth.failed',
      error,
      {},
      paymentLogMeta(req, userId),
    );
    return { error: jsonError('Failed to verify access', 500) };
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberOrZero(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function person(id: unknown, name: unknown): PaymentPerson | null {
  const normalizedId = stringOrNull(id);
  if (!normalizedId) return null;
  return { id: normalizedId, name: stringOrNull(name) ?? 'Неизвестно' };
}

export function paymentRequestToApi(
  value: unknown,
  viewer: { userId: string; canManage: boolean },
): PaymentRequest {
  const row = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const requester = person(row.user_id, row.requester_name) ?? { id: '', name: 'Неизвестно' };
  const projectId = stringOrNull(row.project_id);
  const documentUrl = viewer.canManage || viewer.userId === requester.id
    ? stringOrNull(row.document_url)
    : null;

  return {
    id: stringOrNull(row.id) ?? '',
    requester,
    department: row.department as PaymentDepartment,
    description: stringOrNull(row.description) ?? '',
    amount: numberOrZero(row.amount),
    project: projectId
      ? {
          id: projectId,
          client: stringOrNull(row.project_client) ?? '',
          name: stringOrNull(row.project_name) ?? '',
        }
      : null,
    comment: stringOrNull(row.comment),
    expenseType: row.expense_type as PaymentExpenseType,
    budgetScope: (stringOrNull(row.budget_scope) ?? 'general') as PaymentBudgetScope,
    costCategory: stringOrNull(row.cost_category) as PaymentCostCategory | null,
    expectedPaymentOn: stringOrNull(row.expected_payment_on) ?? '',
    urgency: row.urgency as PaymentUrgency,
    documentUrl,
    status: row.status as PaymentRequestStatus,
    approvalReason: (stringOrNull(row.approval_reason) ?? null) as PaymentApprovalReason,
    decisionComment: stringOrNull(row.decision_comment),
    decidedBy: person(row.decided_by, row.decider_name),
    decidedAt: stringOrNull(row.decided_at),
    paidOn: stringOrNull(row.paid_on),
    paidOnSource: (stringOrNull(row.paid_on_source) ?? null) as PaymentPaidOnSource,
    paidBy: person(row.paid_by, row.paid_by_name),
    paidAt: stringOrNull(row.paid_at),
    createdAt: stringOrNull(row.created_at) ?? '',
    updatedAt: stringOrNull(row.updated_at) ?? '',
  };
}

function readSummaryValue(
  row: Record<string, unknown>,
  camel: string,
  snake: string,
): unknown {
  return row[camel] ?? row[snake];
}

export function paymentSummaryToApi(value: unknown): PaymentMonthSummary {
  const row = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const rawCostBudget = readSummaryValue(row, 'costBudget', 'cost_budget');
  const costRow = (rawCostBudget && typeof rawCostBudget === 'object'
    ? rawCostBudget
    : {}) as Record<string, unknown>;
  const rawByCategory = readSummaryValue(costRow, 'byCategory', 'by_category');
  const categoryRow = (rawByCategory && typeof rawByCategory === 'object'
    ? rawByCategory
    : {}) as Record<string, unknown>;
  const categories: PaymentCostCategory[] = ['instantly', 'email', 'bases', 'domains', 'other'];
  const byCategory = Object.fromEntries(categories.map((category) => {
    const raw = categoryRow[category];
    const totals = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return [category, {
      paid: numberOrZero(totals.paid),
      reserved: numberOrZero(totals.reserved),
    }];
  })) as PaymentCostCategoryTotals;
  const costBudget: PaymentCostBudgetSummary = {
    limit: numberOrZero(costRow.limit),
    paid: numberOrZero(costRow.paid),
    reserved: numberOrZero(costRow.reserved),
    used: numberOrZero(costRow.used),
    remaining: numberOrZero(costRow.remaining),
    overage: numberOrZero(costRow.overage),
    usagePct: numberOrZero(readSummaryValue(costRow, 'usagePct', 'usage_pct')),
    level: (costRow.level ?? 'normal') as PaymentBudgetLevel,
    dataComplete: readSummaryValue(costRow, 'dataComplete', 'data_complete') !== false,
    missingFxCount: numberOrZero(readSummaryValue(costRow, 'missingFxCount', 'missing_fx_count')),
    mailPaid: numberOrZero(readSummaryValue(costRow, 'mailPaid', 'mail_paid')),
    mailReserved: numberOrZero(readSummaryValue(costRow, 'mailReserved', 'mail_reserved')),
    techPaid: numberOrZero(readSummaryValue(costRow, 'techPaid', 'tech_paid')),
    techReserved: numberOrZero(readSummaryValue(costRow, 'techReserved', 'tech_reserved')),
    manualPaid: numberOrZero(readSummaryValue(costRow, 'manualPaid', 'manual_paid')),
    manualReserved: numberOrZero(readSummaryValue(costRow, 'manualReserved', 'manual_reserved')),
    byCategory,
  };
  return {
    limit: numberOrZero(readSummaryValue(row, 'limit', 'limit')),
    paidOneTime: numberOrZero(readSummaryValue(row, 'paidOneTime', 'paid_one_time')),
    reservedOneTime: numberOrZero(readSummaryValue(row, 'reservedOneTime', 'reserved_one_time')),
    usedOneTime: numberOrZero(readSummaryValue(row, 'usedOneTime', 'used_one_time')),
    remaining: numberOrZero(readSummaryValue(row, 'remaining', 'remaining')),
    overage: numberOrZero(readSummaryValue(row, 'overage', 'overage')),
    usagePct: numberOrZero(readSummaryValue(row, 'usagePct', 'usage_pct')),
    level: (readSummaryValue(row, 'level', 'level') ?? 'normal') as PaymentBudgetLevel,
    legacyCount: numberOrZero(readSummaryValue(row, 'legacyCount', 'legacy_count')),
    legacyAmount: numberOrZero(readSummaryValue(row, 'legacyAmount', 'legacy_amount')),
    paidAll: numberOrZero(readSummaryValue(row, 'paidAll', 'paid_all')),
    pendingCount: numberOrZero(readSummaryValue(row, 'pendingCount', 'pending_count')),
    approvedCount: numberOrZero(readSummaryValue(row, 'approvedCount', 'approved_count')),
    costBudget,
  };
}

function shiftMonth(month: string, delta: number): string {
  const [year, number] = month.split('-').map(Number);
  const minimum = 1000 * 12;
  const maximum = (9999 * 12) + 11;
  const monthIndex = Math.min(
    maximum,
    Math.max(minimum, (year * 12) + number - 1 + delta),
  );
  const shiftedYear = Math.floor(monthIndex / 12);
  const shiftedMonth = (monthIndex % 12) + 1;
  return `${shiftedYear}-${String(shiftedMonth).padStart(2, '0')}`;
}

export function paymentPeriod(month: string) {
  const [year, number] = month.split('-').map(Number);
  const raw = new Intl.DateTimeFormat('ru-RU', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, number - 1, 1))).replace(/\s*г\.$/u, '');
  return {
    key: month,
    label: raw.charAt(0).toLocaleUpperCase('ru-RU') + raw.slice(1),
    previous: shiftMonth(month, -1),
    next: shiftMonth(month, 1),
    asOf: currentMoscowDate(),
  };
}

export function paymentRpcError(error: { message?: string } | null | undefined): {
  status: number;
  code: string;
  message: string;
} | null {
  const message = error?.message ?? '';
  if (message.includes('payment_request_idempotency_conflict')) {
    return {
      status: 409,
      code: 'idempotency_conflict',
      message: 'Заявка с этим ключом уже отправлена с другими данными. Обновите страницу.',
    };
  }
  if (message.includes('payment_request_conflict')) {
    return {
      status: 409,
      code: 'payment_request_conflict',
      message: 'Заявка уже изменилась. Обновите данные и повторите.',
    };
  }
  if (message.includes('payment_request_invalid_transition')) {
    return { status: 409, code: 'invalid_transition', message: 'Переход статуса недоступен.' };
  }
  if (message.includes('payment_request_not_found')) {
    return { status: 404, code: 'payment_request_not_found', message: 'Заявка не найдена.' };
  }
  if (message.includes('payment_request_forbidden')) {
    return { status: 403, code: 'payment_request_forbidden', message: 'Недостаточно прав.' };
  }
  if (message.includes('payment_request_project_not_found')) {
    return { status: 400, code: 'invalid_project', message: 'Выбранный проект не найден.' };
  }
  if (message.includes('payment_request_invalid_paid_date')) {
    return {
      status: 400,
      code: 'invalid_paid_date',
      message: 'Укажите фактическую дату оплаты коста, не позднее сегодняшнего дня.',
    };
  }
  if (message.includes('payment_request_cost_limit_exceeded')) {
    return {
      status: 409,
      code: 'cost_limit_exceeded',
      message: 'Лимит костов 650 000 ₽ на этот месяц будет превышен.',
    };
  }
  if (message.includes('payment_request_cost_budget_incomplete')) {
    return {
      status: 409,
      code: 'cost_budget_incomplete',
      message: 'Не удалось пересчитать календарные расходы в рубли. Обновите курсы и повторите.',
    };
  }
  return null;
}
