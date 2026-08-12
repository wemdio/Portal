import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  authenticateReviewRequestInbox,
  jsonError,
  logMeta,
} from '../helpers';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await authenticateReviewRequestInbox(req, 'private');
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
  const { actor } = auth;

  const { data, count, error } = await supabaseAdmin
    .from('team_review_requests')
    .select('id', { count: 'exact', head: true })
    .eq('state', 'new');

  if (error) {
    await logError(
      'team.review_requests.summary.failed',
      error,
      {},
      logMeta(req, actor.userId),
    );
    return jsonError('Failed to load review request summary', 500);
  }

  return NextResponse.json({ newCount: count ?? data?.length ?? 0 });
}
