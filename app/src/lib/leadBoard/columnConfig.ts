import { BOARD_COLUMN_LABELS } from './boardColumns';
import { DEFAULT_COLUMN_CONFIG, type BoardColumnConfigEntry } from '@/lib/instantly/leadBoardWriter';

/**
 * Модель колонок гостевой таблицы: 12 builtin-ключей (из BOARD_COLUMN_LABELS) +
 * кастомные колонки {key: 'c_<slug>', label, visible, custom: true}. Кастомные
 * значения лидов хранятся в project_lead_board_rows.custom (jsonb по ключу).
 * Нормализация едина для staff manage API и гостевого config API.
 */

export type BoardColumn = BoardColumnConfigEntry;

export const CUSTOM_COLUMN_KEY_RE = /^c_[a-z0-9_]{1,30}$/;

export function isBuiltinColumnKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(BOARD_COLUMN_LABELS, key);
}

export function columnLabel(c: BoardColumn): string {
  return c.label ?? BOARD_COLUMN_LABELS[c.key] ?? c.key;
}

/**
 * Нормализация присланного конфига:
 * - присланный порядок builtin и кастомных ключей сохраняется;
 * - отсутствующие builtin дополняются в конце с дефолтной видимостью;
 * - кастомные — строгий формат ключа c_<slug>, обязательный label ≤60 симв.,
 *   без дублей;
 * - неизвестные ключи / битые записи / все скрытые → error.
 */
export function normalizeColumnConfig(raw: unknown): { config?: BoardColumn[]; error?: string } {
  if (!Array.isArray(raw)) return { error: 'columnConfig must be an array' };
  const config: BoardColumn[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { error: 'columnConfig entries must be objects' };
    const key = (item as { key?: unknown }).key;
    if (typeof key !== 'string' || !key) return { error: 'columnConfig entry without key' };
    if (seen.has(key)) return { error: `duplicate column key: ${key}` };
    seen.add(key);
    const visible = (item as { visible?: unknown }).visible !== false;
    if (isBuiltinColumnKey(key)) {
      config.push({ key, visible });
      continue;
    }
    if (!CUSTOM_COLUMN_KEY_RE.test(key)) return { error: `unknown column key: ${key}` };
    const label = (item as { label?: unknown }).label;
    if (typeof label !== 'string' || !label.trim()) {
      return { error: `custom column ${key} requires a label` };
    }
    if (label.trim().length > 60) return { error: 'label too long (max 60 chars)' };
    config.push({ key, label: label.trim(), visible, custom: true });
  }
  config.push(...DEFAULT_COLUMN_CONFIG.filter((c) => !seen.has(c.key)).map((c) => ({ ...c })));
  if (!config.some((c) => c.visible)) return { error: 'at least one column must stay visible' };
  return { config };
}

/** Change positions only: stable keys keep cell values and visibility attached. */
export function moveBoardColumn(columns: BoardColumn[], key: string, targetKey: string): BoardColumn[] {
  const from = columns.findIndex((c) => c.key === key);
  const to = columns.findIndex((c) => c.key === targetKey);
  if (from < 0 || to < 0 || from === to) return columns;
  const next = [...columns];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** Order-only API: never accept deletion, new keys or client-supplied metadata. */
export function reorderColumnConfig(columns: BoardColumn[], order: unknown): { config?: BoardColumn[]; error?: string } {
  if (!Array.isArray(order) || order.length !== columns.length ||
      order.some((key) => typeof key !== 'string') || new Set(order).size !== order.length) {
    return { error: 'Порядок должен содержать каждую колонку ровно один раз.' };
  }
  const byKey = new Map(columns.map((column) => [column.key, column]));
  if (order.some((key) => !byKey.has(key))) {
    return { error: 'Набор колонок изменился. Обновите страницу и повторите.' };
  }
  return { config: order.map((key) => byKey.get(key)!) };
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Ключ новой кастомной колонки из лейбла: c_<slug>, уникальный в конфиге. */
export function makeCustomColumnKey(label: string, existing: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[а-яё]/g, (ch) => TRANSLIT[ch] ?? '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24) || 'col';
  let key = `c_${base}`;
  for (let i = 2; existing.has(key); i++) key = `c_${base}_${i}`;
  return key;
}
