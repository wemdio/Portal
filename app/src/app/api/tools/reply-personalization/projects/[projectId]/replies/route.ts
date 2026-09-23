import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { getKnowledgeBase, getLatestDraftStatuses, getProjectBrief, missingBriefReason } from '@/lib/replyPersonalization/db';
import { listProjectReplies } from '@/lib/replyPersonalization/projectReply';
import type { ReplyListItem } from '@/lib/replyPersonalization/types';

export const dynamic = 'force-dynamic';

/**
 * GET ?campaignId=&q=&limit= — письма проекта, свежие сверху. Все ответы,
 * включая отказы и пропущенные: пропуск только помечается, чтобы список
 * совпадал с Instantly и к письму можно было вернуться.
 */
export const GET = withAuth(async (req: NextRequest, _user, params) => {
  const projectId = params?.projectId;
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  const url = new URL(req.url);
  const campaignId = url.searchParams.get('campaignId') || null;
  const search = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
  const limitParam = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;

  // Письма не показываем, только если собрать ответ не из чего — нет брифа.
  const [projectBrief, kb] = await Promise.all([getProjectBrief(projectId), getKnowledgeBase(projectId)]);
  const missingReason = missingBriefReason(projectBrief, kb?.localBrief);
  if (missingReason) {
    return NextResponse.json({ replies: [], campaigns: [], total: 0, hasMore: false, missingReason });
  }

  const page = await listProjectReplies(projectId, { campaignId, search, limit });
  const statuses = await getLatestDraftStatuses(page.rows.map((q) => q.id));

  const replies: ReplyListItem[] = page.rows.map((q) => ({
    ...q,
    listStatus: statuses[q.id] === 'sent' ? 'sent' : statuses[q.id] === 'skipped' ? 'skipped' : 'new',
  }));

  return NextResponse.json({
    replies,
    campaigns: page.campaigns,
    total: page.total,
    hasMore: page.hasMore,
    missingReason: null,
  });
});
