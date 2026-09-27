/**
 * Тексты ответов бота в ветке «Передача проектов» (спека
 * `docs/superpowers/specs/2026-09-25-handoff-card-check-design.md`, §7-9).
 * Обычный текст, без `parse_mode` — экранирование не нужно.
 */
import type { Problem } from './checkCard';

function problemLines(problems: Problem[]): string {
  return problems.map((problem) => `• ${problem.text}`).join('\n');
}

/** Строка со ссылкой на сделку; ссылки нет (не задан AMO_BASE_URL) — строку опускаем. */
function dealLine(amoUrl: string | null): string {
  return amoUrl ? `\n\nСделка: ${amoUrl}` : '';
}

export function problemsReply(problems: Problem[], amoUrl: string | null): string {
  return `⚠️ Сделка не попадёт в первичку / деньги не посчитаются:\n${problemLines(problems)}${dealLine(amoUrl)}`;
}

export function noLinkReply(): string {
  return '⚠️ В сообщении нет ссылки на сделку AMO — добавьте «Ссылка на амо: …», иначе проверить карточку нельзя.';
}

export function reminderReply(problems: Problem[], amoUrl: string | null): string {
  return `⏰ Напоминание: карточка всё ещё не заполнена:\n${problemLines(problems)}${dealLine(amoUrl)}`;
}

export function resolvedReply(): string {
  return '✅ Карточка дозаполнена';
}
