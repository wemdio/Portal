import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { getDraftById, insertDraft } from '@/lib/replyPersonalization/db';
import { resolveProjectReply } from '@/lib/replyPersonalization/projectReply';
import { sendDraft, SendDraftError } from '@/lib/replyPersonalization/sendDraft';

export const dynamic = 'force-dynamic';

/**
 * Отправка ответа лиду. Два пути:
 * - draftId — ответ на основе сгенерированного черновика (с правками);
 * - без draftId, с projectId — ответ, написанный вручную. Для него заводим
 *   черновик с model='manual': журнал отправленного один на оба пути, и
 *   повторная отправка того же письма так же отсекается статусом черновика.
 */
export const POST = withAuth(async (req: NextRequest, user, params) => {
  const qualificationId = params?.qualificationId;
  if (!qualificationId) return NextResponse.json({ error: 'qualificationId is required' }, { status: 400 });

  const body = (await req.json().catch(() => null)) as
    | { draftId?: string; projectId?: string; text?: string; toEmail?: string | null }
    | null;
  if (typeof body?.text !== 'string' || !body.text.trim()) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 });
  }

  let draftId = body.draftId;
  if (draftId) {
    // Черновик и адрес в URL должны совпадать — иначе фронт по ошибке (или
    // устаревшая вкладка) мог бы отправить черновик другого письма.
    const draft = await getDraftById(draftId);
    if (!draft || draft.qualificationId !== qualificationId) {
      return NextResponse.json({ error: 'Черновик не относится к этому письму' }, { status: 409 });
    }
  } else {
    if (!body.projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
    const reply = await resolveProjectReply(body.projectId, qualificationId);
    if (!reply) return NextResponse.json({ error: 'Письмо не найдено' }, { status: 404 });
    const { qualification } = reply;
    const draft = await insertDraft({
      projectId: body.projectId,
      qualificationId,
      campaignId: qualification.campaignId,
      threadId: qualification.threadId,
      leadEmail: qualification.leadEmail,
      generatedText: '',
      factsUsed: '',
      sources: [],
      contextComplete: true,
      model: 'manual',
      latencyMs: 0,
      createdBy: user.id,
    });
    draftId = draft.id;
  }

  try {
    await sendDraft(draftId, body.text, typeof body.toEmail === 'string' ? body.toEmail : null);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof SendDraftError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : 'Send failed';
    return NextResponse.json({ error: message }, { status: 502 });
  }
});
