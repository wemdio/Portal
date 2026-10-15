/**
 * Лид TG-аутрича → общий чат продаж («Продажи Polza», General).
 *
 * Тот же бот и тот же чат, что у лидов автоаутрича по почте
 * (`senderLeads/telegram.ts`, переменные `SENDER_LEADS_TELEGRAM_*`): продажи
 * смотрят одну ленту и видят всех лидов, откуда бы они ни пришли.
 *
 * Уходит после того, как сделка заведена в AMO, поэтому ссылка на неё лежит
 * сразу в сообщении, а не дописывается правкой.
 */
import {
  clip,
  escapeHtml,
  leadTelegramConfig,
  sendLeadMessage,
} from '@/lib/senderLeads/telegram';
import { TG_OUTREACH_TOOL_URL } from './leadMessage';

/** Переписка в сообщение не лезет целиком (предел Telegram 4096): оставляем конец, он свежее. */
const DIALOG_MAX = 2200;
const DIALOG_MARKER = '── Переписка ──';

/** Переписка из карточки менеджера — без её шапки: шапка здесь своя. */
export function dialogFromCard(card: string): string {
  const at = card.indexOf(DIALOG_MARKER);
  return (at >= 0 ? card.slice(at + DIALOG_MARKER.length) : card).trim();
}

export function buildGeneralLeadMessage(input: {
  campaignName: string;
  contact: string;
  offer: string | null;
  card: string;
  dealUrl: string;
}): string {
  const lines: string[] = ['✈️ <b>Новый лид из Telegram-аутрича</b>', ''];
  lines.push(`<b>Компания:</b> ${escapeHtml(clip(input.campaignName || '—', 200))}`);
  lines.push(`<b>Контакт:</b> ${escapeHtml(clip(input.contact, 120))}`);
  if (input.offer) lines.push(`<b>Оффер:</b> ${escapeHtml(clip(input.offer, 200))}`);
  lines.push(`<b>Инструмент:</b> ${escapeHtml(TG_OUTREACH_TOOL_URL)}`);

  const dialog = dialogFromCard(input.card);
  if (dialog) {
    const shown = dialog.length > DIALOG_MAX ? `…${dialog.slice(dialog.length - DIALOG_MAX)}` : dialog;
    lines.push('', '<b>Переписка:</b>', `<pre>${escapeHtml(shown)}</pre>`);
  }
  lines.push('', `🔗 <a href="${escapeHtml(input.dealUrl)}">Открыть сделку в amoCRM</a>`);
  return lines.join('\n');
}

/** Отправить лида в General. Бот не настроен — тихо ничего не делаем. */
export async function sendLeadToGeneral(input: Parameters<typeof buildGeneralLeadMessage>[0]): Promise<void> {
  const config = leadTelegramConfig();
  if (!config) return;
  await sendLeadMessage(config, buildGeneralLeadMessage(input));
}
