/**
 * Название компании ДЛЯ ПИСЬМА у ENG-базы (he_projects.market = 'us').
 *
 * Исходная ячейка `company` остаётся как есть: по ней база узнаёт компанию
 * (ключи дедупа и исключений других баз, ключ компании у потолка запуска,
 * пометка доставки ночного долива), и её видит клиент в сетке и выгрузке.
 * Очищенное имя («ACME LOGISTICS, INC.» → «Acme Logistics») лежит рядом, в
 * скрытом поле строки HE_COMPANY_CLEAN_FIELD. Пишет его только сборка ENG-базы
 * (stages/baseCollect.ts через companyNameCleanup.ts), и только когда имя
 * действительно поменялось.
 *
 * Читатели — все, кто подставляет компанию в письмо, через heLetterCompanyName:
 *  - запуск и ночной долив с переносом (launchHandoff.ts, mapBaseRowsToLeads —
 *    единственное место, где строки базы становятся лидами);
 *  - превью писем staff-инструмента (renderPreview.ts).
 * Поля нет (RU-база, ручная загрузка, ENG-база, собранная до этой правки) —
 * читатель возвращает null, и вызывающий берёт исходную ячейку прежним
 * выражением: для таких строк результат байт-в-байт прежний.
 *
 * Гейта «имя не готово → лид не уходит» (как у verticalEngineV2) здесь НЕТ и
 * быть не должно: этот код общий с RU-инструментом, а отсутствие или негодность
 * очищенного имени — это просто исходное имя в письме, как было всегда.
 *
 * Модуль ЧИСТЫЙ: его тянут launchHandoff и renderPreview, а их — 'use client'
 * шаг 5 staff-инструмента.
 */

/**
 * Скрытое поле строки he_bases.data с очищенным именем. Префикс `_` — как у
 * `_email_status` / `_low_relevance` / `_hiring_seen_at`: в `columns` поле не
 * входит, поэтому сетка конструктора, CSV-выгрузка и разбор базы его не видят,
 * а клиентская проекция строк режет все ключи с `_` (clientEngProjection.ts,
 * toClientEngBaseDataRow).
 */
export const HE_COMPANY_CLEAN_FIELD = '_company_clean';

/**
 * Колонка компании авто-собранной базы (первая в HE_AUTO_COLLECT_COLUMNS,
 * stages/baseCollect.ts; не импортируется оттуда — модуль обязан остаться
 * чистым). Очищенное имя подменяет ТОЛЬКО её: колонки ручного CSV со своим
 * смыслом не трогаются.
 */
export const HE_COMPANY_COLUMN = 'company';

/** Строка базы, которой сборка могла дописать очищенное имя. */
export type HeCompanyCleanRow = { _company_clean?: string };

/** Потолок длины имени: длиннее — это уже не название, а описание. */
const MAX_NAME_LENGTH = 300;

/** Мягкий перенос и пробельные последовательности — не часть названия. */
export function displayCompanyName(value: string): string {
  return value.replace(/­/g, '').replace(/\s+/g, ' ').trim();
}

function nameWords(value: string): string[] {
  return displayCompanyName(value).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Очищенное имя ВЫВОДИТСЯ из исходного: его слова — непрерывный кусок слов
 * исходного названия в том же порядке (регистр и пунктуация могут отличаться).
 * Ни одного нового слова, ни переставленного, ни склеенного из двух мест.
 * Плюс то, что не должно попасть в письмо ни при каком исходном: пустота,
 * управляющие символы, угловые скобки и шаблонные `{{ }}`.
 *
 * Отличие от faithfulName verticalEngineV2 (companyNameCleanup.ts): там
 * достаточно подпоследовательности слов, здесь нужен непрерывный кусок — все
 * правила очистки (companyNameCleanup.ts) только срезают голову или хвост и
 * меняют регистр, и проверка не должна пропускать больше, чем они умеют.
 */
export function faithfulCompanyName(name: string, source: string): boolean {
  if (!name.trim() || name.length > MAX_NAME_LENGTH || /[\p{C}<>]|\{\{|\}\}/u.test(name)) return false;
  const original = nameWords(source);
  const candidate = nameWords(name);
  if (!candidate.length || candidate.length > original.length) return false;
  for (let start = 0; start + candidate.length <= original.length; start += 1) {
    let ok = true;
    for (let i = 0; i < candidate.length; i += 1) {
      if (original[start + i] !== candidate[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Имя компании для письма из ячейки `column` строки базы — или null, и тогда
 * вызывающий берёт исходную ячейку своим прежним выражением.
 *
 * Очищенное имя берётся, только если (1) это колонка компании авто-сборки,
 * (2) поле — непустая строка и (3) оно выводится из ТЕКУЩЕЙ ячейки company
 * (faithfulCompanyName). Третья проверка повторяется на каждом чтении, а не
 * только при записи: имя, которое разошлось со своей ячейкой, в письмо не
 * попадёт ни на одном пути отправки.
 */
export function heLetterCompanyName(row: Record<string, unknown>, column: string): string | null {
  if (column !== HE_COMPANY_COLUMN) return null;
  const clean = row[HE_COMPANY_CLEAN_FIELD];
  if (typeof clean !== 'string') return null;
  const value = displayCompanyName(clean);
  if (!value) return null;
  return faithfulCompanyName(value, String(row[HE_COMPANY_COLUMN] ?? '')) ? value : null;
}
