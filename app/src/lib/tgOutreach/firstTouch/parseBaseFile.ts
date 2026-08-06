/**
 * Разбор загруженной таблицы контактов.
 *
 * Формат ровно тот, в котором база сейчас грузится в TG Ninja: первая колонка —
 * юзернейм, вторая — готовое персонализированное сообщение. Всё остальное из
 * выгрузки скрапера складывается в `raw` — выбрасывать чужие данные не наше
 * дело, а повторно собирать базу дорого.
 *
 * Чтение самого XLSX/CSV живёт в роуте: здесь чистая функция над массивом
 * строк, поэтому её поведение целиком покрыто тестами.
 */
import { normalizeUsername } from './normalizeUsername';

export interface ParsedContact {
  username: string;
  message: string;
  /** Колонки помимо первых двух: ключ — заголовок или «Колонка N». */
  raw: Record<string, string>;
}

export interface ParseStats {
  /** Строк с данными, без строки заголовка. */
  total: number;
  accepted: number;
  noUsername: number;
  noMessage: number;
  duplicates: number;
}

export interface ParseResult {
  contacts: ParsedContact[];
  stats: ParseStats;
  headers: string[] | null;
}

function cell(row: unknown[], i: number): string {
  const v = row[i];
  if (typeof v === 'string') return v.replace(/ /g, ' ').trim();
  if (typeof v === 'number') return String(v);
  return '';
}

/**
 * Заголовок отличаем по первой ячейке: в строке с данными там юзернейм, а он
 * обязан нормализоваться. «Юзернейм Telegram» — не нормализуется, значит
 * заголовок.
 *
 * Отдельно ловим короткие ярлыки вроде «Username»: они, в отличие от «Юзернейм
 * Telegram», сами по себе проходят как валидный юзернейм (5-32 латинских
 * символа — ровно формат `normalizeUsername`), и первой проверки недостаточно.
 */
const HEADER_FIRST_WORDS = new Set(['username', 'юзернейм']);

function looksLikeHeader(row: unknown[]): boolean {
  const first = cell(row, 0);
  if (cell(row, 1) === '') return false;
  if (normalizeUsername(first) === null) return true;
  const firstWord = first.trim().toLowerCase().split(/\s+/)[0];
  return HEADER_FIRST_WORDS.has(firstWord);
}

export function parseBaseRows(rows: unknown[][]): ParseResult {
  const stats: ParseStats = { total: 0, accepted: 0, noUsername: 0, noMessage: 0, duplicates: 0 };
  const contacts: ParsedContact[] = [];
  const seen = new Set<string>();

  if (rows.length === 0) return { contacts, stats, headers: null };

  const hasHeader = looksLikeHeader(rows[0]);
  const headers = hasHeader ? rows[0].map((_, i) => cell(rows[0], i)) : null;
  const dataRows = hasHeader ? rows.slice(1) : rows;

  for (const row of dataRows) {
    // Строки нулевой длины — хвост массива без данных вообще, в статистику
    // не идут. Строка с пустыми ячейками (например, из файла) — уже реальные
    // данные и обязана попасть в статистику как noUsername/noMessage.
    if (row.length === 0) continue;
    stats.total++;

    const username = normalizeUsername(cell(row, 0));
    if (!username) {
      stats.noUsername++;
      continue;
    }

    const message = cell(row, 1);
    if (!message) {
      stats.noMessage++;
      continue;
    }

    if (seen.has(username)) {
      stats.duplicates++;
      continue;
    }
    seen.add(username);

    const raw: Record<string, string> = {};
    for (let i = 2; i < row.length; i++) {
      const value = cell(row, i);
      if (!value) continue;
      raw[headers?.[i] || `Колонка ${i + 1}`] = value;
    }

    contacts.push({ username, message, raw });
    stats.accepted++;
  }

  return { contacts, stats, headers };
}
