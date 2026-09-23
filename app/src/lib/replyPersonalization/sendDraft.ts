// Отправка через уже существующие безопасные примитивы client.ts
// (replyToEmail / forwardEmail / sendTestEmail) — не через handoffSender.ts
// (это бизнес-логика квалификатора, её мы не трогаем).

import { forwardEmail, replyToEmail, sendTestEmail } from '@/lib/instantly/client';
import { isNotPartOfCampaignError } from '@/lib/instantly/notPartOfCampaign';
import { getDraftById, markDraftSent, updateDraftText } from './db';
import { fetchFullThread } from './instantlyThread';
import { resolveProjectReply } from './projectReply';
import { findReferredEmails } from './referredContact';

/** Щедрый верхний предел тела письма: реальный ответ 90-170 слов, это защита от мусора, не лимит стиля. */
const MAX_SEND_TEXT_LENGTH = 100_000;

export class SendDraftError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/** «Re: Тема» без наслоения «Re: RE: Fwd:» из предыдущих ответов. */
export function replySubject(subject: string | null): string {
  const base = (subject ?? '').replace(/^\s*((re|fwd?|fw|ответ|пересл)\s*(\[\d+\])?\s*:\s*)+/i, '').trim();
  return base ? `Re: ${base}` : 'Re:';
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * finalText — финальный текст из модалки подтверждения (с правками сотрудника),
 * а НЕ оригинал из БД: иначе молча улетала бы несгенерированная версия.
 * Текст сохраняется в черновик до отправки — журнал отражает ушедшее.
 *
 * toEmail — новый контакт, на которого перенаправил адресат. Принимается,
 * только если этот адрес есть в его ответе; письмо уходит с того же ящика,
 * что вёл переписку. Пусто или тот же адрес — ответ в ту же переписку.
 */
export async function sendDraft(draftId: string, finalText: string, toEmail: string | null = null): Promise<void> {
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

  const target = toEmail?.trim().toLowerCase() || null;
  const newContact = target && target !== qualification.leadEmail.toLowerCase() ? target : null;
  const subject = replySubject(qualification.replySubject);

  if (newContact) {
    const thread = qualification.threadId
      ? await fetchFullThread({
          campaignId: qualification.campaignId,
          leadEmail: qualification.leadEmail,
          threadId: qualification.threadId,
          accountId,
        })
      : null;
    const lastInbound = [...(thread ?? [])].reverse().find((m) => !m.fromUs)?.text ?? qualification.replyBody ?? '';
    const referred = findReferredEmails(lastInbound, [qualification.leadEmail, qualification.eaccount]);
    if (!referred.includes(newContact)) {
      throw new SendDraftError('Этого адреса нет в ответе адресата — отправить на него нельзя', 422);
    }
  }

  await updateDraftText(draftId, finalText);

  if (!newContact) {
    await replyToEmail(
      {
        reply_to_uuid: qualification.instantlyEmailId,
        eaccount: qualification.eaccount,
        subject,
        body: { text: finalText },
      },
      { accountId },
    );
  } else {
    // Новому контакту — пересылкой без исходного письма: оно уходит с того же
    // ящика и остаётся в той же ветке Instantly. Письмо вне кампании Instantly
    // пересылать не даёт — тогда отправляем отдельным письмом (как в кабинете
    // клиента, api/client/.../forward).
    try {
      await forwardEmail(
        {
          reply_to_uuid: qualification.instantlyEmailId,
          eaccount: qualification.eaccount,
          to_address_email_list: newContact,
          subject,
          body: { text: finalText },
          include_original_body: false,
        },
        { accountId },
      );
    } catch (err) {
      if (!isNotPartOfCampaignError(err)) throw err;
      await sendTestEmail(
        {
          eaccount: qualification.eaccount,
          to_address_email_list: newContact,
          subject,
          body: { html: escapeHtml(finalText).replace(/\r?\n/g, '<br>\n') },
        },
        { accountId },
      );
    }
  }

  await markDraftSent(draftId, newContact);
}
