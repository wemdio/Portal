import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { blockContact, isContactBlocked } from '@/lib/instantly/contactBlocklist';
import { getProjectCampaignIds, listVisibleProjects } from '@/lib/replyPersonalization/db';
import { resolveProjectReply } from '@/lib/replyPersonalization/projectReply';

export const dynamic = 'force-dynamic';

async function handle(req: NextRequest, user: { id: string }, params?: Record<string, string>) {
  const qualificationId = params?.qualificationId;
  const body = req.method === 'POST' ? await req.json().catch(() => null) : null;
  const projectId = req.method === 'POST' ? body?.projectId : req.nextUrl.searchParams.get('projectId');
  if (!qualificationId || typeof projectId !== 'string' || !projectId) {
    return NextResponse.json({ error: 'projectId и qualificationId обязательны' }, { status: 400 });
  }
  const { projects } = await listVisibleProjects(user.id);
  if (!projects.some((project) => project.id === projectId)) {
    return NextResponse.json({ error: 'Нет доступа к проекту' }, { status: 403 });
  }
  const reply = await resolveProjectReply(projectId, qualificationId);
  const campaigns = await getProjectCampaignIds(projectId);
  if (!reply || !campaigns.includes(reply.qualification.campaignId)) {
    return NextResponse.json({ error: 'Письмо не найдено в проекте' }, { status: 404 });
  }
  // Only the actual correspondent; body.email/accountId cannot change the target.
  const email = reply.qualification.leadEmail.trim().toLowerCase();
  if (req.method === 'POST') {
    await blockContact(email, reply.accountId);
    return NextResponse.json({ email, blocked: true });
  }
  return NextResponse.json({ email, blocked: await isContactBlocked(email, reply.accountId) });
}

export const GET = withAuth(handle);
export const POST = withAuth(handle);
