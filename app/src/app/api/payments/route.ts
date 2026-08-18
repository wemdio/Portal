import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { logAudit, logError } from '@/lib/loggerServer';
import {
  authenticatePaymentsRequest,
  jsonError,
  paymentLogMeta,
  paymentPeriod,
  paymentRequestToApi,
  paymentRpcError,
  paymentSummaryToApi,
} from '@/lib/payments/server';
import {
  isPaymentMonth,
  parsePaymentIdempotencyKey,
  parseSubmitPaymentRequest,
  paymentMonthDatabaseDate,
} from '@/lib/payments/validation';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const month = req.nextUrl.searchParams.get('month');
  if (!month || !isPaymentMonth(month)) {
    return jsonError('month must be a valid YYYY-MM month', 400);
  }
  const auth = await authenticatePaymentsRequest(req, 'use');
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
  const { actor } = auth;
  const databaseMonth = paymentMonthDatabaseDate(month);

  const [listResult, summaryResult, projectsResult] = await Promise.all([
    actor.client.rpc('list_payment_requests', { p_month: databaseMonth }),
    actor.client.rpc('payment_request_month_summary', { p_month: databaseMonth }),
    supabaseAdmin.from('projects').select('id, client, name').order('client').order('name'),
  ]);
  const error = listResult.error ?? summaryResult.error ?? projectsResult.error;
  if (error) {
    await logError(
      'payments.list.failed',
      error,
      { month },
      paymentLogMeta(req, actor.userId),
    );
    return jsonError('Failed to load payments', 500);
  }

  const requests = Array.isArray(listResult.data) ? listResult.data : [];
  return NextResponse.json({
    period: paymentPeriod(month),
    summary: paymentSummaryToApi(summaryResult.data),
    requests: requests.map((row) => paymentRequestToApi(row, actor)),
    projects: (projectsResult.data ?? []).map((row) => ({
      id: String(row.id),
      client: String(row.client ?? ''),
      name: String(row.name ?? ''),
    })),
    canManage: actor.canManage,
  });
}

export async function POST(req: NextRequest) {
  const auth = await authenticatePaymentsRequest(req, 'use');
  if ('error' in auth) return auth.error;
  const { actor } = auth;
  const idempotency = parsePaymentIdempotencyKey(req.headers.get('idempotency-key'));
  if ('error' in idempotency) return jsonError(idempotency.error, 400, idempotency.code);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid body', 400);
  }
  const parsed = parseSubmitPaymentRequest(body);
  if ('error' in parsed) return jsonError(parsed.error, 400);
  const input = parsed.value;

  const { data, error } = await actor.client.rpc('submit_payment_request', {
    p_idempotency_key: idempotency.value,
    p_department: input.department,
    p_description: input.description,
    p_amount: input.amount,
    p_project_id: input.projectId,
    p_comment: input.comment,
    p_expense_type: input.expenseType,
    p_expected_payment_on: input.expectedPaymentOn,
    p_urgency: input.urgency,
    p_document_url: input.documentUrl,
  });
  if (error || !data || typeof data !== 'object') {
    const domain = paymentRpcError(error);
    if (domain) return jsonError(domain.message, domain.status, domain.code);
    await logError(
      'payments.create.failed',
      error ?? new Error('Payment submit returned no data'),
      {},
      paymentLogMeta(req, actor.userId),
    );
    return jsonError('Failed to submit payment request', 500);
  }

  const rpc = data as Record<string, unknown>;
  const month = input.expectedPaymentOn.slice(0, 7);

  await logAudit(
    'payments.create.success',
    'Payment request submitted',
    { requestId: (rpc.request as Record<string, unknown> | undefined)?.id ?? null, month },
    paymentLogMeta(req, actor.userId),
  );
  return NextResponse.json({
    request: paymentRequestToApi(rpc.request, actor),
    summary: paymentSummaryToApi(rpc.summary),
    outcome: rpc.outcome,
  }, { status: 201 });
}
