import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireDatabaseReviewAccess, requireAuth } from '@/lib/databaseReview/accessGuard';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/** GET: list review requests. Reviewer sees all; regular user sees own. */
export async function GET(req: NextRequest) {
  const reviewAuth = await requireDatabaseReviewAccess(req);
  const isReviewer = !('error' in reviewAuth);

  const auth = isReviewer ? reviewAuth : await requireAuth(req);
  if ('error' in auth) return auth.error;

  const statusFilter = new URL(req.url).searchParams.get('status');

  let query = auth.supabaseAdmin
    .from('database_review_requests')
    .select(`
      id, owner_user_id, tab_id, tab_name, project_id, specialist_comment,
      status, reviewer_user_id, reviewer_comment,
      telegram_chat_id, telegram_message_id,
      created_at, updated_at
    `)
    .order('created_at', { ascending: false })
    .limit(200);

  if (!isReviewer) {
    query = query.eq('owner_user_id', auth.user.id);
  }

  if (statusFilter) {
    query = query.eq('status', statusFilter);
  }

  const { data, error } = await query;

  if (error) {
    return jsonError(error.message || 'Failed to fetch requests', 500);
  }

  const rows = data ?? [];

  const ownerIds = [...new Set(rows.map((r) => r.owner_user_id))];
  const projectIds = [...new Set(rows.map((r) => r.project_id).filter(Boolean))] as string[];

  const [profilesRes, projectsRes] = await Promise.all([
    ownerIds.length > 0
      ? auth.supabaseAdmin.from('profiles').select('id, full_name, email').in('id', ownerIds)
      : Promise.resolve({ data: [] }),
    projectIds.length > 0
      ? auth.supabaseAdmin.from('projects').select('id, name').in('id', projectIds)
      : Promise.resolve({ data: [] }),
  ]);

  const profileMap = new Map((profilesRes.data ?? []).map((p: { id: string; full_name?: string; email?: string }) => [p.id, p.full_name || p.email || '']));
  const projectMap = new Map((projectsRes.data ?? []).map((p: { id: string; name?: string }) => [p.id, p.name || '']));

  const enriched = rows.map((r) => ({
    ...r,
    owner_name: profileMap.get(r.owner_user_id) || '',
    project_name: r.project_id ? (projectMap.get(r.project_id) || '') : '',
  }));

  return NextResponse.json({ requests: enriched });
}
