/**
 * Проверка первого сообщения перед отправкой.
 *
 * Текст приходит готовым из файла и уже прочитан человеком, поэтому здесь не
 * про качество, а про мусор: пустую ячейку, съехавшую колонку, обрезанную
 * строку.
 *
 * Дефолтные 400 знаков — из фактических данных портала (1064 первых сообщения,
 * медиана 260, 99% в 400, максимум 573). Порог отсекает только то, что длиннее
 * всего, что вообще отправлялось за историю кампаний.
 *
 * Но 400 — статистика прошлых кампаний, а не правило Telegram, и на базе с
 * ровными текстами по 430–460 знаков этот порог останавливает рассылку целиком:
 * ни одно сообщение не уходит никогда. Поэтому порог задаётся на кампанию
 * (`telegram_settings.first_touch_max_chars`), а здесь остаётся значение по
 * умолчанию для кампаний, где его не трогали.
 */

export const DEFAULT_MAX_MESSAGE_CHARS = Number(process.env.TG_FIRST_TOUCH_MAX_CHARS) || 400;

/**
 * Жёсткий предел Telegram на одно текстовое сообщение. Выше него настройка
 * бессмысленна: отправка упадёт уже на стороне Telegram, и контакт сгорит на
 * сетевой ошибке вместо честного «текст слишком длинный».
 */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

/**
 * Порог кампании → фактический порог проверки.
 *
 * Ноль, отсутствие поля и мусор означают «настройку не трогали» — берём дефолт.
 * Кампании, заведённые до настройки, поля не имеют и продолжают работать ровно
 * как раньше.
 */
export function resolveMaxChars(configured?: number | null): number {
  const n = Number(configured);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_MESSAGE_CHARS;
  return Math.min(Math.floor(n), TELEGRAM_MAX_MESSAGE_CHARS);
}

export type ValidationFailure = 'empty' | 'too_long' | 'multiline';

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: ValidationFailure };

export function validateFirstTouch(message: string, maxChars?: number | null): ValidationResult {
  if (typeof message !== 'string') return { ok: false, reason: 'empty' };

  const limit = resolveMaxChars(maxChars);
  const text = message.replace(/ /g, ' ').trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (/[\r\n]/.test(text)) return { ok: false, reason: 'multiline' };
  if (text.length > limit) return { ok: false, reason: 'too_long' };

  return { ok: true };
}

/** Человекочитаемая причина для лога и отчёта по базе. */
export function describeFailure(reason: ValidationFailure, maxChars?: number | null): string {
  switch (reason) {
    case 'empty':
      return 'пустой текст сообщения';
    case 'too_long':
      return `текст длиннее ${resolveMaxChars(maxChars)} знаков`;
    case 'multiline':
      return 'в тексте перенос строки — должно быть одно сообщение одним абзацем';
  }
}
