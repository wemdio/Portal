import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { generateDraftForQualification, GenerateDraftError } from '@/lib/replyPersonalization/generateDraft';

export const dynamic = 'force-dynamic';

export const POST = withAuth(async (req: NextRequest, user, params) => {
  const qualificationId = params?.qualificationId;
  if (!qualificationId) return NextResponse.json({ error: 'qualificationId is required' }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { projectId?: string } | null;
  if (!body?.projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

  try {
    const result = await generateDraftForQualification(body.projectId, qualificationId, user.id);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof GenerateDraftError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : 'Generation failed';
    return NextResponse.json({ error: message }, { status: 502 });
  }
});
