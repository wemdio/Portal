import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { generateDraftForQualification, GenerateDraftError } from '@/lib/replyPersonalization/generateDraft';
import { getOpenDraft, setThreadLanguage } from '@/lib/replyPersonalization/db';
import type { ReplyLanguage } from '@/lib/replyPersonalization/types';

export const dynamic = 'force-dynamic';

export const POST = withAuth(async (req: NextRequest, user, params) => {
  const qualificationId = params?.qualificationId;
  if (!qualificationId) return NextResponse.json({ error: 'qualificationId is required' }, { status: 400 });

  const body = (await req.json().catch(() => null)) as {
    projectId?: string;
    recipientEmail?: string | null;
    language?: string;
  } | null;
  if (!body?.projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  const recipientEmail = typeof body.recipientEmail === 'string' ? body.recipientEmail : null;
  // Язык — то, что выбрано переключателем прямо сейчас; заодно запоминаем его
  // на переписке, чтобы при следующем открытии чата он не сбросился на русский.
  const language: ReplyLanguage = body.language === 'en' ? 'en' : 'ru';

  try {
    await setThreadLanguage(qualificationId, body.projectId, language, user.id);
    const result = await generateDraftForQualification(
      body.projectId,
      qualificationId,
      user.id,
      recipientEmail,
      language,
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof GenerateDraftError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : 'Generation failed';
    return NextResponse.json({ error: message }, { status: 502 });
  }
});

/** GET — последний неотправленный черновик ИИ по письму (или null). */
export const GET = withAuth(async (_req: NextRequest, _user, params) => {
  const qualificationId = params?.qualificationId;
  if (!qualificationId) return NextResponse.json({ error: 'qualificationId is required' }, { status: 400 });

  const draft = await getOpenDraft(qualificationId);
  return NextResponse.json({
    draft: draft
      ? {
          draftId: draft.id,
          text: draft.generatedText ?? '',
          factsUsed: draft.factsUsed ?? '',
          sources: draft.sources,
          contextComplete: draft.contextComplete,
          recipientEmail: draft.recipientEmail,
          createdAt: draft.createdAt,
        }
      : null,
  });
});
