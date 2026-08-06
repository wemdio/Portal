/**
 * Проверка первого сообщения перед отправкой.
 *
 * Текст приходит готовым из файла и уже прочитан человеком, поэтому здесь не
 * про качество, а про мусор: пустую ячейку, съехавшую колонку, обрезанную
 * строку.
 *
 * 400 знаков — из фактических данных портала (1064 первых сообщения, медиана
 * 260, 99% в 400, максимум 573). Порог отсекает только то, что длиннее всего,
 * что вообще отправлялось за историю кампаний.
 */

export const MAX_MESSAGE_CHARS = Number(process.env.TG_FIRST_TOUCH_MAX_CHARS) || 400;

export type ValidationFailure = 'empty' | 'too_long' | 'multiline';

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: ValidationFailure };

export function validateFirstTouch(message: string): ValidationResult {
  if (typeof message !== 'string') return { ok: false, reason: 'empty' };

  const text = message.replace(/ /g, ' ').trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (/[\r\n]/.test(text)) return { ok: false, reason: 'multiline' };
  if (text.length > MAX_MESSAGE_CHARS) return { ok: false, reason: 'too_long' };

  return { ok: true };
}

/** Человекочитаемая причина для лога и отчёта по базе. */
export function describeFailure(reason: ValidationFailure): string {
  switch (reason) {
    case 'empty':
      return 'пустой текст сообщения';
    case 'too_long':
      return `текст длиннее ${MAX_MESSAGE_CHARS} знаков`;
    case 'multiline':
      return 'в тексте перенос строки — должно быть одно сообщение одним абзацем';
  }
}
