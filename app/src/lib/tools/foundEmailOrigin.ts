import { extractEmails, findColumnIndex } from './dfybUtils';
import { FOUND_EMAIL_ORIGIN_COL } from './baseConstructorCheckpoint';

/**
 * Происхождение адресов для validate_target 'original' | 'found'.
 *
 * Eager merge (baseConstructorWorker) сливает «Найденный Email» в исходную
 * email-колонку ДО split_emails — иначе в итоге остаются ячейки с несколькими
 * адресами (27.05.2026, 12843da52). После слияния stepValidateEmails видел
 * одну колонку: 'found' не проверял ничего, 'original' — всё. Колонка
 * FOUND_EMAIL_ORIGIN_COL хранит адреса строки, пришедшие ТОЛЬКО со скрейпа,
 * и доживает до валидации (как WEBSITE_EMAIL_PREFERENCE_COL у VE2).
 *
 * Пишется только если джоба просит проверить один источник — ручной
 * конструктор, где пользователь видел выбор «Что валидировать». 'found'
 * никогда не был значением по умолчанию — это всегда осознанный выбор.
 * 'original' старый UI слал по умолчанию всегда, поэтому он учитывается
 * только с validate_target_explicit (новый UI); без метки такие джобы
 * проверяют всё, как раньше. Автоматические пайплайны validate_target не
 * передают, колонки у них нет.
 */

/** Нужна ли колонка происхождения при eager merge перед шагом с этим конфигом. */
export function shouldTrackFoundEmailOrigin(stepConfig: {
  validate_target?: unknown;
  validate_target_explicit?: unknown;
  find_emails?: { merge_mode?: unknown };
}): boolean {
  const target = stepConfig.validate_target;
  const mode = stepConfig.find_emails?.merge_mode;
  return (target === 'found' || (target === 'original' && stepConfig.validate_target_explicit === true))
    && (mode === undefined || mode === 'all');
}

/** JSON-ячейка → множество адресов со скрейпа; null если ячейка битая. */
export function parseFoundEmailOrigin(cell: string | undefined): Set<string> | null {
  try {
    const value: unknown = JSON.parse(cell || 'null');
    if (!Array.isArray(value)) return null;
    return new Set(value.filter((e): e is string => typeof e === 'string').map((e) => e.toLowerCase()));
  } catch {
    return null;
  }
}

/**
 * После split_emails: у строки один адрес, копировать ей весь список
 * найденных адресов компании незачем — оставляем пересечение с ячейкой.
 */
export function compactFoundEmailOrigins(data: string[][]): string[][] {
  const header = data[0] ?? [];
  const originIdx = header.indexOf(FOUND_EMAIL_ORIGIN_COL);
  if (originIdx < 0) return data;
  const emailIdx = findColumnIndex(header, 'email', 'e-mail', 'почта', 'mail');
  if (emailIdx < 0) return data;
  return [header, ...data.slice(1).map((row) => {
    const origin = parseFoundEmailOrigin(row[originIdx]);
    if (!origin) return row;
    const out = [...row];
    out[originIdx] = JSON.stringify(extractEmails(row[emailIdx] || '').filter((e) => origin.has(e)));
    return out;
  })];
}
