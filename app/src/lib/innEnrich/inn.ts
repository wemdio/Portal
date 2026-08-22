/**
 * Общие константы и pure-хелперы тула /tools/inn-enrich (обогащение файла
 * по ИНН из companies_directory). Используются и API-роутом, и страницей —
 * держим их free of I/O, чтобы покрывались node-тестами.
 */

/** Сколько уникальных ИНН принимает один POST /api/tools/inn-enrich/match. */
export const MAX_INNS_PER_REQUEST = 2000;

/** Потолок одной джобы воркера (как email-validation). */
export const MAX_INNS_PER_JOB = 100_000;

/** Размер одного вызова inn_enrich_fetch внутри match-роута / воркера. */
export const RPC_BATCH_SIZE = 500;

/** Сколько ИНН страница шлёт за один match-запрос (legacy UI-чанк). */
export const UI_CHUNK_SIZE = 1000;

export const INN_ENRICH_BUCKET = 'inn-enrich-exports';
export const MAX_SOURCE_FILE_BYTES = 80 * 1024 * 1024;

const INN_LENGTHS = new Set([10, 12]);

/**
 * Нормализует значение ячейки к ИНН или null. Оставляет только цифры —
 * xlsx может отдать число, CSV — строку с пробелами/кавычками/дефисами.
 * 10 цифр = юрлицо, 12 = ИП; всё остальное (ОГРН 13/15, КПП 9, телефоны
 * 11) отбраковывается, чтобы не раздувать RPC-пейлоад мусором.
 */
export function normalizeInn(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/\D/g, '');
  return INN_LENGTHS.has(digits.length) ? digits : null;
}

/** Дедуп с сохранением порядка первого вхождения. */
export function dedupeInns(inns: readonly string[]): string[] {
  return Array.from(new Set(inns));
}

/** Разбивка на батчи фиксированного размера; пустой вход → пустой выход. */
export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunkArray: size must be positive');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
