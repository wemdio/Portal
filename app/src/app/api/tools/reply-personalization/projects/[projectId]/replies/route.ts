import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { getKnowledgeBase, getLatestDraftStatuses, getProjectCampaignIds, listSyncedQualifications } from '@/lib/replyPersonalization/db';
import { listLiveReplies } from '@/lib/replyPersonalization/liveReplyList';
import type { ReplyListItem } from '@/lib/replyPersonalization/types';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, _user, params) => {
  const projectId = params?.projectId;
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  const kb = await getKnowledgeBase(projectId);
  if (!kb) return NextResponse.json({ replies: [], needsKnowledgeBase: true });

  const campaignIds = await getProjectCampaignIds(projectId);
  const qualifications =
    kb.instantlyAccountId === 'main'
      ? await listSyncedQualifications(campaignIds)
      : await listLiveReplies({ campaignIds, accountId: kb.instantlyAccountId });

  const statuses = await getLatestDraftStatuses(qualifications.map((q) => q.id));

  const replies: ReplyListItem[] = qualifications
    .filter((q) => statuses[q.id] !== 'skipped')
    .map((q) => ({ ...q, listStatus: statuses[q.id] === 'sent' ? 'sent' : 'new' }));

  return NextResponse.json({ replies, needsKnowledgeBase: false });
});
