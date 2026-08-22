/**
 * CSV-выгрузка собранной базы (ve_bases) для GET …/bases/[id]/export.
 *
 * Формат — Excel-RU friendly: разделитель `;` (русская локаль Excel иначе
 * не разбирает запятую на колонки), BOM в начале (Excel без него читает
 * UTF-8 как windows-1251 и ломает кириллицу), поля с `"`/`;`/переводом строки
 * оборачиваются в кавычки, внутренние кавычки удваиваются.
 *
 * Отдельно от lib/tools/rowsToCsv.ts: тот хелпер держит байт-в-байт контракт
 * конструктора баз (запятая, ВСЕ ячейки в кавычках) и менять его нельзя.
 */

/** Ячейка CSV: null/undefined → пусто; кавычки удваиваются; поле с разделителем/кавычкой/переводом строки — в кавычках. */
export function csvField(value: unknown): string {
  let s = value == null ? '' : String(value);
  // Формульная инъекция: Excel/LibreOffice вычисляют ячейки, начинающиеся
  // с =,+,-,@ (значения приходят из парсеров, т.е. из недоверенного источника).
  // Нейтрализуем префиксом апострофа — до проверки на кавычки.
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV файла базы: BOM + строка заголовков (columns как есть) + строки data.
 * Значение ячейки — row[column]; колонки вне строки дают пустую ячейку.
 */
export function buildBaseCsv(
  columns: string[],
  rows: Array<Record<string, unknown>>,
): string {
  const lines = [columns.map(csvField).join(';')];
  for (const row of rows) {
    lines.push(columns.map((col) => csvField(row?.[col])).join(';'));
  }
  return '﻿' + lines.join('\r\n');
}

/* ─────────────────────── Имя файла для Content-Disposition ─────────────────────── */

/** Посимвольная транслитерация кириллицы (нижний регистр на входе). */
const CYRILLIC_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/**
 * Безопасное имя файла выгрузки: транслит + только [a-z0-9-_.] (ASCII-имя не
 * ломает Content-Disposition и старые даунлоад-менеджеры). Известное
 * табличное расширение исходного имени (.csv/.xlsx/.xls) срезаем, чтобы не
 * плодить двойное «podem.xlsx.csv». Пустой результат (напр. filename из
 * одних эмодзи) → fallback `base-<id>.csv`.
 */
export function safeBaseFilename(filename: string | null | undefined, id: string): string {
  const stem = (filename ?? '')
    .toLowerCase()
    .split('')
    .map((ch) => CYRILLIC_LATIN[ch] ?? ch)
    .join('')
    .replace(/\.(csv|xlsx|xls)$/, '')
    .replace(/[^a-z0-9-_.]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return `${stem || `base-${id}`}.csv`;
}
