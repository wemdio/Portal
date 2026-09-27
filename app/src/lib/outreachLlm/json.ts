/**
 * Разбор полей JSON-ответа ИИ-разбора — общий у русского и английского
 * аутричей.
 *
 * Модель отвечает строгим JSON, но типы в нём не гарантированы: да/нет
 * приходит строкой, список — не списком, пустое — null. Здесь только
 * приведение к типам, без зависимостей: модуль можно импортировать откуда
 * угодно, в том числе из клиентского кода. Раньше эти функции жили в русском
 * polzaRuOutreach/llm.ts, и английский разбор импортировал их оттуда.
 */

export function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function asBool(value: unknown): boolean {
  return value === true || value === 'true';
}

export function asStringArray(value: unknown, max = 20): string[] {
  return Array.isArray(value) ? value.map(asString).filter(Boolean).slice(0, max) : [];
}

/**
 * Да/нет из JSON-ответа: булево или строка "true"/"false" (как принимает
 * asBool). Проверка полноты ответа: у цитат есть законное «пусто», а поле
 * да/нет модель обязана решить в любом ответе — его отсутствие значит сбой
 * модели, а не «нет».
 */
export function isBoolLike(value: unknown): boolean {
  return typeof value === 'boolean' || value === 'true' || value === 'false';
}
