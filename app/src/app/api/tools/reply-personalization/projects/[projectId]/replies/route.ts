import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { getKnowledgeBase, getLatestDraftStatuses, getProjectBrief, missingBriefReason } from '@/lib/replyPersonalization/db';
import { listProjectReplies } from '@/lib/replyPersonalization/projectReply';
import type { ReplyListItem } from '@/lib/replyPersonalization/types';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, _user, params) => {
  const projectId = params?.projectId;
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  // Письма не показываем, только если собрать ответ не из чего — нет брифа.
  const [projectBrief, kb] = await Promise.all([getProjectBrief(projectId), getKnowledgeBase(projectId)]);
  const missingReason = missingBriefReason(projectBrief, kb?.localBrief);
  if (missingReason) return NextResponse.json({ replies: [], missingReason });

  const qualifications = await listProjectReplies(projectId);
  const statuses = await getLatestDraftStatuses(qualifications.map((q) => q.id));

  const replies: ReplyListItem[] = qualifications
    .filter((q) => statuses[q.id] !== 'skipped')
    .map((q) => ({ ...q, listStatus: statuses[q.id] === 'sent' ? 'sent' : 'new' }));

  return NextResponse.json({ replies, missingReason: null });
});
