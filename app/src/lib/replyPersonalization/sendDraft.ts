// Отправка через уже существующий безопасный примитив replyToEmail
// (app/src/lib/instantly/client.ts) — не через handoffSender.ts (это
// бизнес-логика квалификатора, её мы не трогаем).

import { replyToEmail } from '@/lib/instantly/client';
import { getDraftById, getKnowledgeBase, getQualificationById, markDraftSent } from './db';

export class SendDraftError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export async function sendDraft(draftId: string): Promise<void> {
  const draft = await getDraftById(draftId);
  if (!draft) throw new SendDraftError('Черновик не найден', 404);
  if (draft.status === 'sent') return; // идемпотентно: повторный клик не шлёт письмо дважды
  if (!draft.generatedText) throw new SendDraftError('У черновика нет текста', 422);

  const qualification = await getQualificationById(draft.qualificationId);
  if (!qualification) throw new SendDraftError('Письмо не найдено', 404);
  if (!qualification.instantlyEmailId) throw new SendDraftError('Нет id письма для ответа в Instantly', 422);
  if (!qualification.eaccount) throw new SendDraftError('Не определён почтовый ящик отправителя (eaccount)', 422);

  const kb = await getKnowledgeBase(draft.projectId);
  if (!kb) throw new SendDraftError('У проекта не заполнена база знаний', 409);

  await replyToEmail(
    {
      reply_to_uuid: qualification.instantlyEmailId,
      eaccount: qualification.eaccount,
      subject: qualification.replySubject ? `Re: ${qualification.replySubject}` : 'Re:',
      body: { text: draft.generatedText },
    },
    { accountId: kb.instantlyAccountId },
  );

  await markDraftSent(draftId);
}
