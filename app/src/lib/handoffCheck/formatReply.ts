/**
 * Тексты ответов бота в ветке «Передача проектов» (спека
 * `docs/superpowers/specs/2026-09-25-handoff-card-check-design.md`, §7-9).
 * Обычный текст, без `parse_mode` — экранирование не нужно.
 */
import type { Problem } from './checkCard';

function problemLines(problems: Problem[]): string {
  return problems.map((problem) => `• ${problem.text}`).join('\n');
}

/** Ссылка на сообщение в ветке супергруппы: `-1001852890744` → `t.me/c/1852890744/<ветка>/<сообщение>`. */
export function messageLink(chatId: number, threadId: number | null, messageId: number): string | null {
  const id = String(chatId);
  if (!id.startsWith('-100')) return null;
  return `https://t.me/c/${id.slice(4)}/${threadId != null ? `${threadId}/` : ''}${messageId}`;
}

/** Строка со ссылкой на сообщение, по которому проверка: без неё непонятно, о чём речь, когда его удалили. */
function messageLine(messageUrl: string | null): string {
  return messageUrl ? `\nСообщение: ${messageUrl}` : '';
}

/** Строка со ссылкой на сделку; ссылки нет (не задан AMO_BASE_URL) — строку опускаем. */
function dealLine(amoUrl: string | null): string {
  return amoUrl ? `\n\nСделка: ${amoUrl}` : '';
}

export function problemsReply(problems: Problem[], amoUrl: string | null, messageUrl: string | null = null): string {
  return `⚠️ Сделка не попадёт в первичку / деньги не посчитаются:\n${problemLines(problems)}${messageLine(messageUrl)}${dealLine(amoUrl)}`;
}

export function noLinkReply(): string {
  return '⚠️ В сообщении нет ссылки на сделку AMO — добавьте «Ссылка на амо: …», иначе проверить карточку нельзя.';
}

export function reminderReply(problems: Problem[], amoUrl: string | null, messageUrl: string | null = null): string {
  return `⏰ Напоминание: карточка всё ещё не заполнена:\n${problemLines(problems)}${messageLine(messageUrl)}${dealLine(amoUrl)}`;
}

export function resolvedReply(): string {
  return '✅ Карточка дозаполнена';
}

/** Сообщение переотправили, и новая версия прошла проверку. */
export function supersededReply(): string {
  return '✅ Исправлено в новом сообщении';
}
