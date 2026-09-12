import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { getDraftById } from '@/lib/replyPersonalization/db';
import { sendDraft, SendDraftError } from '@/lib/replyPersonalization/sendDraft';

export const dynamic = 'force-dynamic';

export const POST = withAuth(async (req: NextRequest, _user, params) => {
  const qualificationId = params?.qualificationId;
  if (!qualificationId) return NextResponse.json({ error: 'qualificationId is required' }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { draftId?: string } | null;
  if (!body?.draftId) return NextResponse.json({ error: 'draftId is required' }, { status: 400 });

  // Черновик и адрес в URL должны совпадать — иначе фронт по ошибке (или
  // устаревшая вкладка) мог бы отправить черновик другого письма.
  const draft = await getDraftById(body.draftId);
  if (!draft || draft.qualificationId !== qualificationId) {
    return NextResponse.json({ error: 'Черновик не относится к этому письму' }, { status: 409 });
  }

  try {
    await sendDraft(body.draftId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof SendDraftError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : 'Send failed';
    return NextResponse.json({ error: message }, { status: 502 });
  }
});
