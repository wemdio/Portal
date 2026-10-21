import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { getProjectContactBlock, projectBlockDb } from '@/lib/instantly/projectContactBlocks';
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
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email)) {
    return NextResponse.json({ error: 'Некорректный email контакта' }, { status: 422 });
  }
  if (req.method === 'POST') {
    const { error } = await projectBlockDb().rpc('project_contact_block_enqueue', {
      p_project_id: projectId, p_email: email, p_created_by: user.id,
    });
    if (error) throw new Error(`Не удалось сохранить блокировку проекта: ${error.message}`);
    return NextResponse.json({ email, blocked: true, syncPending: true }, { status: 202 });
  }
  return NextResponse.json({ email, ...await getProjectContactBlock(projectId, email) });
}

export const GET = withAuth(handle);
export const POST = withAuth(handle);
