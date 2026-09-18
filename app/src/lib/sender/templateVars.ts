/**
 * Правила имён переменных письма — общие для сервера (импорт базы, отправка)
 * и для формы кампании (подсказки, проверка текста). Держим в одном месте:
 * если форма и отправка назовут колонку по-разному, подсказка предложит
 * переменную, которая при отправке окажется пустой.
 *
 * Имя переменной получается из заголовка колонки одинаково, как бы его ни
 * записали в базе или в письме: «companyName», «Company Name», «company_name»
 * и «COMPANY-NAME» — это одна переменная {{company_name}}.
 */

/** Ключ переменной из заголовка колонки или из текста между {{ }}. */
export function varKey(header: string): string {
  return header
    .trim()
    // companyName / CompanyName → company Name: граница «строчная → заглавная»
    .replace(/([a-zа-яё0-9])([A-ZА-ЯЁ])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '_')
    .replace(/^_+|_+$/g, '');
}

/** {{ что угодно, кроме фигурных скобок }} — нормализация имени через varKey. */
export const PLACEHOLDER_RE = /\{\{([^{}]+?)\}\}/g;

/** Все переменные, упомянутые в тексте, — уже приведённые к ключам. */
export function placeholderKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const key = varKey(match[1]);
    if (key) keys.add(key);
  }
  return [...keys];
}

/** Переменные, которые есть у любого получателя, независимо от колонок базы. */
export const EMAIL_VAR = 'email';
export const NAME_VARS = ['name', 'first_name'] as const;
