import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { getKnowledgeBase, upsertKnowledgeBase } from '@/lib/replyPersonalization/db';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_req, _user, params) => {
  const projectId = params?.projectId;
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  const kb = await getKnowledgeBase(projectId);
  return NextResponse.json({ kb });
});

export const PUT = withAuth(async (req: NextRequest, user, params) => {
  const projectId = params?.projectId;
  if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  const body = (await req.json().catch(() => null)) as {
    brief?: string;
    productFacts?: string;
    toneNotes?: string;
    exampleCase?: string;
    instantlyAccountId?: string;
  } | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  await upsertKnowledgeBase(
    projectId,
    {
      brief: body.brief ?? '',
      productFacts: body.productFacts ?? '',
      toneNotes: body.toneNotes ?? '',
      exampleCase: body.exampleCase ?? '',
      instantlyAccountId: body.instantlyAccountId ?? 'main',
    },
    user.id,
  );

  const kb = await getKnowledgeBase(projectId);
  return NextResponse.json({ kb });
});
