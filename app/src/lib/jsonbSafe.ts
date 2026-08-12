/**
 * Единственный примитив «сделай значение пригодным для jsonb/text Postgres».
 *
 * Postgres отвергает ровно две вещи, которые валидны в JS-строке:
 *   1. NUL (кодпоинт 0) — не хранится ни в text, ни в jsonb;
 *   2. ОДИНОЧНЫЙ (непарный) UTF-16 суррогат из диапазона D800-DFFF.
 * JSON.stringify такого значения выдаёт escape без пары, и PostgREST получает
 * от PG «invalid input syntax for type json» — падает ВЕСЬ пакет, а не одна
 * строка.
 *
 * Откуда берутся одиночные суррогаты в этом коде:
 *   - String#slice/substring режет скрапленный текст посередине surrogate pair
 *     (эмодзи): сниппеты-evidence, обрезанные описания;
 *   - числовые HTML-энтити (&#xD83D;), декодированные без пары;
 *   - ответы LLM, оборванные по max_tokens ровно между половинами пары;
 *   - битые кодировки исходных страниц.
 *
 * Инциденты: ingest eng_hiring (jsonb `raw`); upsert архива gisSignalOutreach
 * 12.08.2026 — пакет из 2000 строк, потерянный день аутрича.
 *
 * Валидные пары (настоящие эмодзи) сохраняются. Обход рекурсивный — по
 * массивам и объектам, и по ключам, и по значениям.
 */

// NUL только через escape в RegExp-обёртке: литеральный символ в исходнике
// делает файл бинарным для git/грепа (та же причина, что у RegExp-констант
// в tools/baseConstructorWorker.ts).
const NUL_RE = new RegExp('\\u0000', 'g');
const LONE_HIGH_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g;
const LONE_LOW_RE = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function stripUnstorableJsonChars<T>(value: T): T {
  if (typeof value === 'string') {
    return value
      .replace(NUL_RE, '')
      .replace(LONE_HIGH_RE, '')
      .replace(LONE_LOW_RE, '') as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripUnstorableJsonChars(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[stripUnstorableJsonChars(key)] = stripUnstorableJsonChars(val);
    }
    return out as unknown as T;
  }
  return value;
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * Срез [start, end) с границами, сдвинутыми ПРОЧЬ от середины surrogate pair:
 * половинка эмодзи на краю просто не попадает в результат.
 *
 * Профилактика того же «invalid input syntax for type json» в источнике, а не
 * на границе записи: обрезанный сниппет уходит не только в БД, но и в сетку
 * конструктора, CSV-выгрузки и переменные писем — чинить его чисткой на
 * последнем шаге было бы поздно.
 */
export function sliceWholeChars(text: string, start: number, end: number): string {
  let s = Math.max(0, start);
  let e = Math.min(text.length, end);
  if (e <= s) return '';
  // Левый край упал на low-суррогат → его high остался за срезом, пропускаем.
  if (isLowSurrogate(text.charCodeAt(s))) s += 1;
  // Правый край оставил high-суррогат последним → его low за срезом, убираем.
  if (e > s && isHighSurrogate(text.charCodeAt(e - 1))) e -= 1;
  return text.slice(s, e);
}
