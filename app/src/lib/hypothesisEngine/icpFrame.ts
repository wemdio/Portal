/**
 * Рамка ЦА клиента ENG-кабинета — `he_projects.brief.icp`: кого брать
 * (`include`), кого не брать никогда (`exclude`), размер компании (`size`) и
 * география (`geo`). Колонка brief — jsonb (20260724_0001), поэтому миграции
 * нет: рамка — ещё один ключ рядом с offer/style/signature/business_override.
 *
 * Кто пишет и кто читает — ровно три места:
 *  - пишут только клиентские роуты: PATCH (api/client/eng/projects/[id]) через
 *    patchHeProjectBrief и создание проекта (POST api/client/eng/projects)
 *    через buildHeEngCreateBrief (оба — projectBriefPatch.ts); staff-роут
 *    RU-инструмента этот ключ не пишет и не читает;
 *  - роут проекта (api/client/eng/projects/[id]) читает её, чтобы показать
 *    клиенту сохранённое (шаг «Brief»);
 *  - стадия hypotheses на рынке us кладёт её в EN-промпт гипотез
 *    (prompts/hypotheses.en.ts). RU-промпт её не получает.
 *
 * ЧЕМ РАМКА ЯВЛЯЕТСЯ И ЧЕМ НЕТ. Это указание модели в одном промпте и ничего
 * больше. Ни один код не сверяет с рамкой гипотезы, вертикали, план сбора или
 * строки баз: модель может её нарушить, и такая гипотеза дойдёт до клиента как
 * любая другая. Список «исключить» НЕ подключён к префильтру строк
 * (heOffTargetMarkersFor в relevanceGate.ts): жёсткий фильтр по подстроке —
 * отдельное решение владельца.
 *
 * Модуль чистый — ни БД, ни сети: его импортирует и форма кабинета (лимиты
 * полей), и воркер.
 */

/** Сколько пунктов в списке «кого брать» / «кого не брать». */
export const HE_ICP_LIST_MAX_ENTRIES = 10;
/** Длина одного пункта списка после чистки пробелов. */
export const HE_ICP_ENTRY_MAX_CHARS = 150;
/** Длина строки «размер» / «география» после чистки пробелов. */
export const HE_ICP_LINE_MAX_CHARS = 200;

/** Рамка в brief: все четыре ключа есть всегда, пустота — [] или ''. */
export interface HeIcpFrame {
  include: string[];
  exclude: string[];
  size: string;
  geo: string;
}

export type HeIcpListField = 'include' | 'exclude';
export type HeIcpLineField = 'size' | 'geo';
export type HeIcpField = HeIcpListField | HeIcpLineField;

/**
 * Частичная правка: присланный ключ заменяет подполе целиком (пустой список
 * или пустая строка — очистить), отсутствующий не трогает сохранённое.
 */
export type HeIcpFramePatch = Partial<HeIcpFrame>;

export type HeIcpFrameInputError =
  /** Не объект (и не null) либо объект без единого из четырёх ключей. */
  | { code: 'bad_shape' }
  /** Список не массивом строк, строка не строкой. */
  | { code: 'bad_type'; field: HeIcpField }
  /** Пунктов больше лимита — после чистки и снятия повторов. */
  | { code: 'too_many'; field: HeIcpListField; max: number }
  /** Пункт или строка длиннее лимита — после чистки пробелов. */
  | { code: 'too_long'; field: HeIcpField; max: number };

/**
 * Отказ по рамке для API клиентских роутов (PATCH и POST создания проекта):
 * имена — ключи тела запроса, лимит — из ошибки, а не цифрой. Формы кабинета
 * проверяют те же константы до отправки своими подписями полей, поэтому эти
 * тексты получает только запрос в обход формы.
 */
export function heIcpFrameInputErrorText(err: HeIcpFrameInputError): string {
  switch (err.code) {
    case 'bad_shape':
      return 'icp must be an object with include, exclude, size or geo, or null for none';
    case 'bad_type':
      return err.field === 'include' || err.field === 'exclude'
        ? `icp.${err.field} must be a list of strings`
        : `icp.${err.field} must be a string`;
    case 'too_many':
      return `icp.${err.field}: at most ${err.max} entries`;
    case 'too_long':
      return err.field === 'include' || err.field === 'exclude'
        ? `icp.${err.field}: each entry is at most ${err.max} characters`
        : `icp.${err.field}: maximum ${err.max} characters`;
  }
}

const LIST_FIELDS: readonly HeIcpListField[] = ['include', 'exclude'];
const LINE_FIELDS: readonly HeIcpLineField[] = ['size', 'geo'];

/** Пробелы и переводы строк внутри пункта — в один пробел: пункт однострочный. */
function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Пункт без единой буквы или цифры («-», «—», «...») ничего не говорит модели. */
function meaningful(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

/** Чистка, выброс пустых и бессмысленных пунктов, повторы — без учёта регистра. */
function cleanList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const item = cleanText(raw);
    if (!item || !meaningful(item)) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function cleanLine(value: string): string {
  const line = cleanText(value);
  return meaningful(line) ? line : '';
}

export function isEmptyHeIcpFrame(frame: HeIcpFrame): boolean {
  return frame.include.length === 0 && frame.exclude.length === 0 && !frame.size && !frame.geo;
}

/**
 * Правка из тела запроса — строго: лишнее НЕ обрезается молча, а отклоняется,
 * чтобы клиент не потерял набранное, не узнав об этом. Чистка (пробелы,
 * пункты без букв и цифр, повторы) — не потеря: сохранённое приходит в ответе,
 * и форма показывает ровно его.
 *
 * `null` — снять рамку целиком. Незнакомые ключи объекта игнорируются (как
 * незнакомые поля верхнего уровня у patchHeProjectBrief).
 */
export function parseHeIcpFramePatch(
  raw: unknown,
): { ok: true; patch: HeIcpFramePatch | null } | { ok: false; error: HeIcpFrameInputError } {
  if (raw === null) return { ok: true, patch: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: { code: 'bad_shape' } };
  const source = raw as Record<string, unknown>;
  const patch: HeIcpFramePatch = {};
  for (const field of LIST_FIELDS) {
    const value = source[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      return { ok: false, error: { code: 'bad_type', field } };
    }
    const list = cleanList(value as string[]);
    if (list.length > HE_ICP_LIST_MAX_ENTRIES) {
      return { ok: false, error: { code: 'too_many', field, max: HE_ICP_LIST_MAX_ENTRIES } };
    }
    if (list.some((item) => item.length > HE_ICP_ENTRY_MAX_CHARS)) {
      return { ok: false, error: { code: 'too_long', field, max: HE_ICP_ENTRY_MAX_CHARS } };
    }
    patch[field] = list;
  }
  for (const field of LINE_FIELDS) {
    const value = source[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') return { ok: false, error: { code: 'bad_type', field } };
    const line = cleanLine(value);
    if (line.length > HE_ICP_LINE_MAX_CHARS) {
      return { ok: false, error: { code: 'too_long', field, max: HE_ICP_LINE_MAX_CHARS } };
    }
    patch[field] = line;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: { code: 'bad_shape' } };
  return { ok: true, patch };
}

/**
 * Сохранённая рамка — мягко: что бы ни лежало в jsonb (ручная правка SQL'ем,
 * лимиты, ужатые после записи), наружу выходит только рамка нужной формы или
 * null. Нестроки выбрасываются, лишнее обрезается до лимита. Пустая рамка —
 * null, а не объект из пустот.
 */
export function readHeIcpFrame(raw: unknown): HeIcpFrame | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const list = (value: unknown): string[] =>
    Array.isArray(value)
      ? cleanList(value.filter((item): item is string => typeof item === 'string'))
          .slice(0, HE_ICP_LIST_MAX_ENTRIES)
          .map((item) => item.slice(0, HE_ICP_ENTRY_MAX_CHARS))
      : [];
  const line = (value: unknown): string =>
    typeof value === 'string' ? cleanLine(value).slice(0, HE_ICP_LINE_MAX_CHARS) : '';
  const frame: HeIcpFrame = {
    include: list(source.include),
    exclude: list(source.exclude),
    size: line(source.size),
    geo: line(source.geo),
  };
  return isEmptyHeIcpFrame(frame) ? null : frame;
}

/**
 * Сохранённая рамка + правка → что записать. null — ключ `icp` из brief
 * удалить (правка null или всё вычистилось в пустоту).
 */
export function mergeHeIcpFrame(stored: unknown, patch: HeIcpFramePatch | null): HeIcpFrame | null {
  if (patch === null) return null;
  const base = readHeIcpFrame(stored) ?? { include: [], exclude: [], size: '', geo: '' };
  const next: HeIcpFrame = { ...base, ...patch };
  return isEmptyHeIcpFrame(next) ? null : next;
}
