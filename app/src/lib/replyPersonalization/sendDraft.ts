// Отправка через уже существующий безопасный примитив replyToEmail
// (app/src/lib/instantly/client.ts) — не через handoffSender.ts (это
// бизнес-логика квалификатора, её мы не трогаем).

import { replyToEmail } from '@/lib/instantly/client';
import { getDraftById, markDraftSent, updateDraftText } from './db';
import { resolveProjectReply } from './projectReply';

/** Щедрый верхний предел тела письма: реальный ответ 90-170 слов, это защита от мусора, не лимит стиля. */
const MAX_SEND_TEXT_LENGTH = 100_000;

export class SendDraftError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/**
 * finalText — финальный текст из модалки подтверждения (с правками сотрудника),
 * а НЕ оригинал из БД: иначе молча улетала бы несгенерированная версия.
 * Текст сохраняется в черновик до отправки — журнал отражает ушедшее.
 */
export async function sendDraft(draftId: string, finalText: string): Promise<void> {
  if (typeof finalText !== 'string' || !finalText.trim()) {
    throw new SendDraftError('Пустой текст ответа', 422);
  }
  if (finalText.length > MAX_SEND_TEXT_LENGTH) {
    throw new SendDraftError('Текст ответа слишком длинный', 422);
  }

  const draft = await getDraftById(draftId);
  if (!draft) throw new SendDraftError('Черновик не найден', 404);
  if (draft.status === 'sent') return; // идемпотентно: повторный клик не шлёт письмо дважды

  const reply = await resolveProjectReply(draft.projectId, draft.qualificationId);
  if (!reply) throw new SendDraftError('Письмо не найдено', 404);
  const { qualification, accountId } = reply;
  if (!qualification.instantlyEmailId) throw new SendDraftError('Нет id письма для ответа в Instantly', 422);
  if (!qualification.eaccount) throw new SendDraftError('Не определён почтовый ящик отправителя (eaccount)', 422);

  await updateDraftText(draftId, finalText);

  await replyToEmail(
    {
      reply_to_uuid: qualification.instantlyEmailId,
      eaccount: qualification.eaccount,
      subject: qualification.replySubject ? `Re: ${qualification.replySubject}` : 'Re:',
      body: { text: finalText },
    },
    { accountId },
  );

  await markDraftSent(draftId);
}
