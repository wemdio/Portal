import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { getQualificationById, insertSkip } from '@/lib/replyPersonalization/db';

export const dynamic = 'force-dynamic';

export const POST = withAuth(async (req: NextRequest, user, params) => {
  const qualificationId = params?.qualificationId;
  if (!qualificationId) return NextResponse.json({ error: 'qualificationId is required' }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { projectId?: string } | null;
  if (!body?.projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  const qualification = await getQualificationById(qualificationId);
  if (!qualification) return NextResponse.json({ error: 'Письмо не найдено' }, { status: 404 });

  await insertSkip({
    projectId: body.projectId,
    qualificationId,
    campaignId: qualification.campaignId,
    threadId: qualification.threadId,
    leadEmail: qualification.leadEmail,
    createdBy: user.id,
  });

  return NextResponse.json({ ok: true });
});
