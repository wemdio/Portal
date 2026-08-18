import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isValidUuid } from '@/lib/apiValidation';
import { currentMoscowDate } from '@/lib/calendarDate';
import { logAudit, logError } from '@/lib/loggerServer';
import {
  authenticatePaymentsRequest,
  jsonError,
  paymentLogMeta,
  paymentRequestToApi,
  paymentRpcError,
  paymentSummaryToApi,
} from '@/lib/payments/server';
import { parsePaymentRequestAction } from '@/lib/payments/validation';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!isValidUuid(id)) return jsonError('Invalid payment request id', 400);
  const auth = await authenticatePaymentsRequest(req, 'manage');
  if ('error' in auth) return auth.error;
  const { actor } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid body', 400);
  }
  const parsed = parsePaymentRequestAction(body, currentMoscowDate());
  if ('error' in parsed) {
    const status = parsed.code === 'precondition_required' ? 428 : 400;
    return jsonError(parsed.error, status, parsed.code);
  }
  const action = parsed.value;
  const decisionComment = 'decisionComment' in action ? action.decisionComment ?? null : null;
  const paidOn = 'paidOn' in action ? action.paidOn : null;
  const expenseType = 'expenseType' in action ? action.expenseType : null;

  const { data, error } = await actor.client.rpc('transition_payment_request', {
    p_request_id: id,
    p_action: action.action,
    p_expected_updated_at: action.expectedUpdatedAt,
    p_decision_comment: decisionComment,
    p_paid_on: paidOn,
    p_expense_type: expenseType,
  });
  if (error || !data || typeof data !== 'object') {
    const domain = paymentRpcError(error);
    if (domain) return jsonError(domain.message, domain.status, domain.code);
    await logError(
      'payments.transition.failed',
      error ?? new Error('Payment transition returned no data'),
      { requestId: id, action: action.action },
      paymentLogMeta(req, actor.userId),
    );
    return jsonError('Failed to update payment request', 500);
  }

  const rpc = data as Record<string, unknown>;
  const rawSummaries = Array.isArray(rpc.summaries) ? rpc.summaries : [];
  const summaries = rawSummaries
    .map((entry) => {
      const row = entry && typeof entry === 'object'
        ? entry as Record<string, unknown>
        : {};
      return {
        month: typeof row.month === 'string' ? row.month : '',
        summary: paymentSummaryToApi(row.summary),
      };
    })
    .filter((entry) => /^\d{4}-\d{2}$/.test(entry.month));
  const months = summaries.map((entry) => entry.month);

  await logAudit(
    'payments.transition.success',
    'Payment request transitioned',
    { requestId: id, action: action.action, months },
    paymentLogMeta(req, actor.userId),
  );
  return NextResponse.json({
    request: paymentRequestToApi(rpc.request, actor),
    summaries,
    outcome: rpc.outcome,
  });
}
