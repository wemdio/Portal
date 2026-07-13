/**
 * Извлечение ИНН из CSV старой выгрузки B2B-поиска (бэкфилл seen-журнала).
 *
 * Формат — наши же экспортные CSV (export/route.ts): заголовок с колонкой
 * «ИНН», значения в кавычках при необходимости. Парсер терпимый: если
 * колонка «ИНН» не найдена по заголовку, fallback — любые ячейки из 10/12
 * цифр (валидная длина ИНН юрлица/ИП).
 */

/** Разбирает одну CSV-строку с поддержкой кавычек ("" = экранированная кавычка). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const INN_RE = /^\d{10}$|^\d{12}$/;

/** Достаёт уникальные ИНН из текста CSV. */
export function parseInnColumn(csvText: string): string[] {
  const lines = csvText.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const innIdx = header.findIndex((h) => h === 'инн' || h === 'inn');

  const seen = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (innIdx >= 0) {
      const v = (cells[innIdx] ?? '').trim();
      if (INN_RE.test(v)) seen.add(v);
    } else {
      // Fallback: колонки «ИНН» нет — берём любые ячейки, похожие на ИНН.
      for (const cRaw of cells) {
        const v = cRaw.trim();
        if (INN_RE.test(v)) seen.add(v);
      }
    }
  }
  return [...seen];
}
