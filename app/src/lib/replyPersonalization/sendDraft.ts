// Отправка через уже существующие безопасные примитивы client.ts
// (replyToEmail / forwardEmail / sendTestEmail) — не через handoffSender.ts
// (это бизнес-логика квалификатора, её мы не трогаем).

import { textToReplyHtml } from '@/lib/clientCampaignReplies/bodyHtml';
import { extractBodyText } from '@/lib/clientCampaignReplies/mapEmail';
import {
  appendQuotedHistoryHtml,
  appendQuotedHistoryText,
  type QuoteSource,
} from '@/lib/clientCampaignReplies/quoteHistory';
import { forwardEmail, getEmail, replyToEmail, sendTestEmail } from '@/lib/instantly/client';
import { isNotPartOfCampaignError } from '@/lib/instantly/notPartOfCampaign';
import { getDraftById, markDraftSent, updateDraftText } from './db';
import { fetchFullThread } from './instantlyThread';
import { resolveProjectReply } from './projectReply';
import { findReferredEmails } from './referredContact';
import type { QualificationRow } from './types';

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

/**
 * Письмо лида для цитаты под нашим ответом. Без неё адресат видит ответ
 * отдельным письмом, без переписки, на которую он отвечает (то же, что чинили
 * в кабинете клиента, см. quoteHistory).
 *
 * Тело тянем живьём: reply_body у писем с живых аккаунтов — превью на 500
 * символов (liveReplyList), цитировать обрезок нельзя. Сбой запроса не должен
 * ронять отправку — откатываемся на сохранённые поля.
 */
async function buildQuoteSource(
  qualification: QualificationRow,
  accountId: string,
): Promise<QuoteSource> {
  const fallback: QuoteSource = {
    bodyText: qualification.replyBody,
    fromEmail: qualification.leadEmail,
    timestamp: qualification.replyTimestamp,
  };
  if (!qualification.instantlyEmailId) return fallback;
  try {
    const original = await getEmail(qualification.instantlyEmailId, {
      accountId,
      requestPriority: 'interactive',
      consumer: 'personalization_send',
    });
    if (!original) return fallback;
    return {
      bodyText: extractBodyText(original.body) ?? qualification.replyBody,
      fromName: original.from_address_json?.[0]?.name ?? null,
      fromEmail: original.from_address_email ?? qualification.leadEmail,
      timestamp: original.timestamp_email ?? original.timestamp_created ?? qualification.replyTimestamp,
    };
  } catch {
    return fallback;
  }
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

  // Instantly рендерит тело как HTML: голый { text } с \n схлопывается в один
  // сплошной абзац («простыня» в письме адресата). Шлём HTML с <br> и text как
  // fallback, к обоим — процитированное письмо лида.
  const quoteSrc = await buildQuoteSource(qualification, accountId);
  const bodyHtml = appendQuotedHistoryHtml(textToReplyHtml(finalText), quoteSrc);
  const bodyText = appendQuotedHistoryText(finalText, quoteSrc);

  if (!newContact) {
    await replyToEmail(
      {
        reply_to_uuid: qualification.instantlyEmailId,
        eaccount: qualification.eaccount,
        subject,
        body: { html: bodyHtml, text: bodyText },
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
          // Новому контакту цитату не подкладываем (include_original_body:
          // false выше — осознанное решение), но переносы строк сохраняем.
          body: { html: textToReplyHtml(finalText), text: finalText },
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
          body: { html: textToReplyHtml(finalText) },
        },
        { accountId },
      );
    }
  }

  await markDraftSent(draftId, newContact);
}
