import {
  hasOwn,
  isValidIsoDate,
  isValidRfc3339Timestamp,
  isValidUuid,
} from '@/lib/apiValidation';
import type {
  PaymentBudgetScope,
  PaymentCostCategory,
  NewPaymentExpenseType,
  PaymentDepartment,
  PaymentRequestActionInput,
  PaymentUrgency,
  SubmitPaymentRequestInput,
} from './types';
import { PAYMENT_COST_CATEGORIES, PAYMENT_DEPARTMENTS } from './types';

const PAYMENT_MONTH_RE = /^(\d{4})-(\d{2})$/;
const MAX_AMOUNT = 9_999_999_999.99;
const MAX_DESCRIPTION = 500;
const MAX_COMMENT = 5_000;
const MAX_DECISION_COMMENT = 1_000;
const MAX_DOCUMENT_URL = 2_000;

type ValidationResult<T> = { value: T } | { error: string; code?: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(body).every((key) => keys.has(key));
}

function requiredText(value: unknown, field: string, max: number): ValidationResult<string> {
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    return { error: `${field} must contain between 1 and ${max} characters` };
  }
  return { value: normalized };
}

function optionalText(value: unknown, field: string, max: number): ValidationResult<string | null> {
  if (value === null || value === undefined) return { value: null };
  if (typeof value !== 'string') return { error: `${field} must be a string or null` };
  const normalized = value.trim();
  if (normalized.length > max) return { error: `${field} must be at most ${max} characters` };
  return { value: normalized || null };
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isPaymentMonth(value: string): boolean {
  const match = PAYMENT_MONTH_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return year >= 1000 && year <= 9999 && month >= 1 && month <= 12;
}

export function paymentMonthDatabaseDate(month: string): string {
  return `${month}-01`;
}

/**
 * Каждая отправка расхода обязана нести Idempotency-Key: потерянный ответ или
 * двойной клик должны повторно прочитать уже созданную заявку, а не завести
 * вторую и не занять лимит дважды.
 */
export function parsePaymentIdempotencyKey(value: string | null): ValidationResult<string> {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || !isValidUuid(normalized)) {
    return {
      error: 'Idempotency-Key header must be a UUID',
      code: 'invalid_idempotency_key',
    };
  }
  return { value: normalized };
}

export function parseSubmitPaymentRequest(
  value: unknown,
): ValidationResult<SubmitPaymentRequestInput> {
  if (!isObject(value)) return { error: 'Invalid body' };
  const body = value;
  if (!hasOnlyKeys(body, [
    'department',
    'description',
    'amount',
    'projectId',
    'comment',
    'expenseType',
    'budgetScope',
    'costCategory',
    'expectedPaymentOn',
    'urgency',
    'documentUrl',
  ])) {
    return { error: 'Body contains unsupported fields' };
  }

  if (!PAYMENT_DEPARTMENTS.includes(body.department as PaymentDepartment)) {
    return { error: 'department is invalid' };
  }
  const description = requiredText(body.description, 'description', MAX_DESCRIPTION);
  if ('error' in description) return description;
  if (
    typeof body.amount !== 'number'
    || !Number.isFinite(body.amount)
    || body.amount <= 0
    || body.amount > MAX_AMOUNT
    || Math.abs(body.amount * 100 - Math.round(body.amount * 100)) > 1e-8
  ) {
    return { error: 'amount must be a positive amount with at most 2 decimal places' };
  }

  let projectId: string | null = null;
  if (body.projectId !== null && body.projectId !== undefined) {
    if (typeof body.projectId !== 'string' || !isValidUuid(body.projectId)) {
      return { error: 'projectId must be a UUID or null' };
    }
    projectId = body.projectId;
  }
  const comment = optionalText(body.comment, 'comment', MAX_COMMENT);
  if ('error' in comment) return comment;
  if (body.expenseType !== 'one_time' && body.expenseType !== 'planned') {
    return { error: 'expenseType must be one_time or planned' };
  }
  const budgetScope = body.budgetScope ?? 'general';
  const costCategory = body.costCategory ?? null;
  if (budgetScope !== 'general' && budgetScope !== 'costs') {
    return { error: 'budgetScope must be general or costs' };
  }
  const isKnownCostCategory = PAYMENT_COST_CATEGORIES.includes(
    costCategory as PaymentCostCategory,
  );
  if (
    (budgetScope === 'costs' && !isKnownCostCategory)
    || (budgetScope === 'general' && costCategory !== null)
  ) {
    return { error: 'costCategory must be set only for cost expenses' };
  }
  if (typeof body.expectedPaymentOn !== 'string' || !isValidIsoDate(body.expectedPaymentOn)) {
    return { error: 'expectedPaymentOn must be a valid YYYY-MM-DD date' };
  }
  if (body.urgency !== 'normal' && body.urgency !== 'urgent' && body.urgency !== 'critical') {
    return { error: 'urgency must be normal, urgent or critical' };
  }
  const documentUrl = optionalText(body.documentUrl, 'documentUrl', MAX_DOCUMENT_URL);
  if ('error' in documentUrl) return documentUrl;
  if (documentUrl.value !== null && !isHttpUrl(documentUrl.value)) {
    return { error: 'documentUrl must be an HTTP(S) URL or null' };
  }

  return {
    value: {
      department: body.department as PaymentDepartment,
      description: description.value,
      amount: Math.round(body.amount * 100) / 100,
      projectId,
      comment: comment.value,
      expenseType: body.expenseType as NewPaymentExpenseType,
      budgetScope: budgetScope as PaymentBudgetScope,
      costCategory: costCategory as PaymentCostCategory | null,
      expectedPaymentOn: body.expectedPaymentOn,
      urgency: body.urgency as PaymentUrgency,
      documentUrl: documentUrl.value,
    },
  };
}

export function parsePaymentRequestAction(
  value: unknown,
  moscowToday: string,
): ValidationResult<PaymentRequestActionInput> {
  if (!isObject(value)) return { error: 'Invalid body' };
  const body = value;
  if (!hasOwn(body, 'expectedUpdatedAt')) {
    return { error: 'expectedUpdatedAt is required', code: 'precondition_required' };
  }
  if (
    typeof body.expectedUpdatedAt !== 'string'
    || !isValidRfc3339Timestamp(body.expectedUpdatedAt)
  ) {
    return { error: 'expectedUpdatedAt must be an RFC3339 timestamp' };
  }

  const base = { expectedUpdatedAt: body.expectedUpdatedAt };
  if (body.action === 'approve') {
    if (!hasOnlyKeys(body, ['action', 'expectedUpdatedAt', 'decisionComment'])) {
      return { error: 'Body contains unsupported fields' };
    }
    const decision = optionalText(body.decisionComment, 'decisionComment', MAX_DECISION_COMMENT);
    if ('error' in decision) return decision;
    return {
      value: decision.value
        ? { action: 'approve', ...base, decisionComment: decision.value }
        : { action: 'approve', ...base },
    };
  }

  if (body.action === 'reject') {
    if (!hasOnlyKeys(body, ['action', 'expectedUpdatedAt', 'decisionComment'])) {
      return { error: 'Body contains unsupported fields' };
    }
    const decision = requiredText(body.decisionComment, 'decisionComment', MAX_DECISION_COMMENT);
    if ('error' in decision) return decision;
    return { value: { action: 'reject', ...base, decisionComment: decision.value } };
  }

  if (body.action === 'mark_paid') {
    if (!hasOnlyKeys(body, ['action', 'expectedUpdatedAt', 'paidOn'])) {
      return { error: 'Body contains unsupported fields' };
    }
    if (
      typeof body.paidOn !== 'string'
      || !isValidIsoDate(body.paidOn)
      || body.paidOn > moscowToday
    ) {
      return { error: 'paidOn must be a valid non-future YYYY-MM-DD date' };
    }
    return { value: { action: 'mark_paid', ...base, paidOn: body.paidOn } };
  }

  if (body.action === 'classify_legacy') {
    if (!hasOnlyKeys(body, ['action', 'expectedUpdatedAt', 'expenseType', 'paidOn'])) {
      return { error: 'Body contains unsupported fields' };
    }
    if (body.expenseType !== 'one_time' && body.expenseType !== 'planned') {
      return { error: 'expenseType must be one_time or planned' };
    }
    if (
      typeof body.paidOn !== 'string'
      || !isValidIsoDate(body.paidOn)
      || body.paidOn > moscowToday
    ) {
      return { error: 'paidOn must be a valid non-future YYYY-MM-DD date' };
    }
    return {
      value: {
        action: 'classify_legacy',
        ...base,
        expenseType: body.expenseType,
        paidOn: body.paidOn,
      },
    };
  }

  return { error: 'action is invalid' };
}
