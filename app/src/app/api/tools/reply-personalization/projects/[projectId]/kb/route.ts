import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import {
  getGlobalKnowledgeBase,
  getKnowledgeBase,
  getProjectBrief,
  upsertKnowledgeBase,
} from '@/lib/replyPersonalization/db';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, _user, params) => {
  const projectId = params?.projectId;
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  const [kb, projectBrief, global] = await Promise.all([
    getKnowledgeBase(projectId),
    getProjectBrief(projectId),
    getGlobalKnowledgeBase(),
  ]);
  return NextResponse.json({ kb, projectBrief, global });
});

export const PUT = withAuth(async (req: NextRequest, user, params) => {
  const projectId = params?.projectId;
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  const body = (await req.json().catch(() => null)) as {
    productFacts?: string;
    toneNotes?: string;
    exampleCase?: string;
  } | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  await upsertKnowledgeBase(
    projectId,
    {
      productFacts: body.productFacts ?? '',
      toneNotes: body.toneNotes ?? '',
      exampleCase: body.exampleCase ?? '',
    },
    user.id,
  );

  const [kb, projectBrief, global] = await Promise.all([
    getKnowledgeBase(projectId),
    getProjectBrief(projectId),
    getGlobalKnowledgeBase(),
  ]);
  return NextResponse.json({ kb, projectBrief, global });
});
