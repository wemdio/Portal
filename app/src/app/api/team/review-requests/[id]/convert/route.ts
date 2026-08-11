import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isValidUuid } from '@/lib/apiValidation';
import { logAudit, logError } from '@/lib/loggerServer';
import {
  authenticateReviewRequestInbox,
  jsonError,
  logMeta,
  parseReviewRequestConvertInput,
} from '../../helpers';

export const dynamic = 'force-dynamic';

type RouteContext = {
  params: Promise<{ id: string }>;
};

type ConversionResult = {
  request_id?: unknown;
  review_id?: unknown;
};

function conversionResult(value: unknown): ConversionResult | null {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === 'object' ? row as ConversionResult : null;
}

function conversionError(code: string | undefined) {
  switch (code) {
    case '40001':
    case '23514':
      return jsonError(
        'Review request was changed or already resolved',
        409,
        'review_request_conflict',
      );
    case 'P0002':
      return jsonError('Review request not found', 404);
    case '42501':
      return jsonError('Forbidden', 403);
    case '22023':
      return jsonError('Invalid conversion input', 400);
    default:
      return null;
  }
}

export async function POST(req: NextRequest, context: RouteContext) {
  const auth = await authenticateReviewRequestInbox(req, 'private');
  if ('error' in auth) return auth.error;
  const { actor } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid body', 400);
  }

  const parsed = parseReviewRequestConvertInput(body);
  if ('error' in parsed) return jsonError(parsed.error, parsed.status);

  const { id } = await context.params;
  if (!isValidUuid(id)) return jsonError('Invalid review request id', 400);

  const { data, error } = await actor.authedClient.rpc(
    'convert_team_review_request',
    {
      p_request_id: id,
      p_review_date: parsed.value.reviewDate,
      p_review_reason: parsed.value.reviewReason,
      p_expected_updated_at: parsed.value.expectedUpdatedAt,
    },
  );

  if (error) {
    const mapped = conversionError(error.code);
    if (mapped) return mapped;
    await logError(
      'team.review_requests.convert.failed',
      error,
      { requestId: id },
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to convert review request', 500);
  }

  const result = conversionResult(data);
  const requestId = typeof result?.request_id === 'string'
    ? result.request_id
    : id;
  const reviewId = typeof result?.review_id === 'string'
    ? result.review_id
    : null;
  if (!reviewId) {
    await logError(
      'team.review_requests.convert.invalid_result',
      new Error('Conversion RPC returned no review id'),
      { requestId },
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to load converted review request', 500);
  }

  await logAudit(
    'team.review_requests.convert.success',
    'Team review request converted to a scheduled review',
    { requestId, reviewId, reviewDate: parsed.value.reviewDate },
    logMeta(req, actor.userId),
  );

  return NextResponse.json({
    requestId,
    reviewId,
  });
}
