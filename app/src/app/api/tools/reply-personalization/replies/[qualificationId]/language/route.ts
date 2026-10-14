import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { setThreadLanguage } from '@/lib/replyPersonalization/db';
import { resolveProjectReply } from '@/lib/replyPersonalization/projectReply';
import type { ReplyLanguage } from '@/lib/replyPersonalization/types';

export const dynamic = 'force-dynamic';

/**
 * PUT — язык письма для этой переписки. Отдельно от генерации: сотрудник может
 * переключить язык и уйти, не нажав «Сгенерировать», — выбор всё равно должен
 * остаться на чате.
 */
export const PUT = withAuth(async (req: NextRequest, user, params) => {
  const qualificationId = params?.qualificationId;
  if (!qualificationId) return NextResponse.json({ error: 'qualificationId is required' }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { projectId?: string; language?: string } | null;
  if (!body?.projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  if (body.language !== 'ru' && body.language !== 'en') {
    return NextResponse.json({ error: 'language must be ru or en' }, { status: 400 });
  }
  const language: ReplyLanguage = body.language;

  // Чужую переписку через этот роут не пометить: письмо должно принадлежать
  // проекту, к которому у пользователя уже есть доступ (та же проверка, что и
  // у генерации).
  const reply = await resolveProjectReply(body.projectId, qualificationId);
  if (!reply) return NextResponse.json({ error: 'Письмо не найдено' }, { status: 404 });

  await setThreadLanguage(qualificationId, body.projectId, language, user.id);
  return NextResponse.json({ language });
});
