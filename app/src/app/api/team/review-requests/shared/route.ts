import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { collectPages } from '@/lib/collectPages';
import { logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  authenticateReviewRequestInbox,
  jsonError,
  loadReviewRequestSupportData,
  logMeta,
  reviewRequestSummary,
  SHARED_REVIEW_REQUEST_PROJECTION,
  sharedReviewRequestToApi,
  type SharedReviewRequestRow,
} from '../helpers';

export const dynamic = 'force-dynamic';

/**
 * Общая очередь запросов на ревью — только чтение и только для лидов и
 * директоров.
 *
 * Приватные запросы отсекаются в SQL (`visibility = 'lead_shared'`), а не при
 * маппинге: фильтр в запросе нельзя случайно потерять рефакторингом ответа.
 * Управляющих действий здесь нет вовсе — обрабатывает запросы приватная
 * команда HR через свой инбокс, поэтому `canManage` всегда false.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateReviewRequestInbox(req, 'shared');
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
  const { actor } = auth;

  let requests: SharedReviewRequestRow[];
  try {
    requests = await collectPages(async (from, to) => {
      const page = await supabaseAdmin!
        .from('team_review_requests')
        .select(SHARED_REVIEW_REQUEST_PROJECTION)
        .eq('visibility', 'lead_shared')
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to);
      return {
        data: (page.data ?? []) as SharedReviewRequestRow[],
        error: page.error ? { message: page.error.message } : null,
      };
    });
  } catch (error) {
    await logError(
      'team.review_requests.shared.list.failed',
      error,
      {},
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to load review requests', 500);
  }

  const support = await loadReviewRequestSupportData();
  if ('error' in support) return support.error;

  return NextResponse.json({
    requests: requests.map((request) => sharedReviewRequestToApi(request, support.value)),
    summary: reviewRequestSummary(requests),
    canManage: false,
  });
}
