import { EXPENSE_CATEGORY_VALUES, categoryLabel } from '@/lib/expenses/labels';
import { UNCLASSIFIED_CATEGORY_KEY, type VendorOption } from '@/lib/expenses/types';

/**
 * Раскладка выпадающего списка вендоров: фильтр по подстроке, группировка по
 * категориям и пункт «создать то, что напечатал».
 *
 * Чистые функции отдельно от компонента ровно потому, что здесь вся логика,
 * которую можно сломать незаметно: порядок групп, попадание вендора без
 * категории в хвост, момент появления «создать» и то, куда прыгает стрелка
 * через заголовок группы. Проверять это кликами по живому списку — значит не
 * проверять.
 */

/** Минимальная длина запроса, с которой предлагаем завести вендора. Столько же требует роут. */
export const MIN_VENDOR_NAME_LENGTH = 2;

export type VendorPickerItem =
  /** «Без вендора» — трата сохранится неразмеченной и уйдёт в очередь. */
  | { kind: 'empty'; key: string }
  | { kind: 'vendor'; key: string; option: VendorOption }
  /** «Создать „X“» — продолжение набора, а не отдельный режим. */
  | { kind: 'create'; key: string; name: string };

export interface VendorPickerGroup {
  /** Ключ категории либо `unclassified` для вендоров без неё. */
  key: string;
  label: string;
  items: Array<Extract<VendorPickerItem, { kind: 'vendor' }>>;
}

export interface VendorPickerModel {
  emptyItem: VendorPickerItem | null;
  groups: VendorPickerGroup[];
  createItem: VendorPickerItem | null;
  /**
   * Все выбираемые пункты в порядке отрисовки. По нему ходят стрелки —
   * заголовков групп в нём нет, поэтому фокус через них перепрыгивает сам.
   */
  items: VendorPickerItem[];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Модель списка для текущего запроса.
 *
 * Пункт «без вендора» показывается только при пустом запросе: набранный текст —
 * это намерение найти конкретного вендора, и держать «без вендора» первым
 * пунктом под стрелкой в этот момент значит подставлять его под Enter.
 */
export function buildVendorPicker({
  options,
  query,
  includeEmpty,
}: {
  options: VendorOption[];
  query: string;
  includeEmpty: boolean;
}): VendorPickerModel {
  const needle = normalize(query);

  const matched = needle
    ? options.filter((option) => option.name.toLowerCase().includes(needle))
    : [...options];

  const byCategory = new Map<string, Array<Extract<VendorPickerItem, { kind: 'vendor' }>>>();
  for (const option of matched) {
    const key = option.category ?? UNCLASSIFIED_CATEGORY_KEY;
    const bucket = byCategory.get(key) ?? [];
    bucket.push({ kind: 'vendor', key: `vendor:${option.id}`, option });
    byCategory.set(key, bucket);
  }

  // Порядок групп — тот же, что у фильтра по категории и у легенды графика.
  // Вендоры без категории идут последними: это не категория, а «пока не знаем».
  const orderedKeys = [...EXPENSE_CATEGORY_VALUES, UNCLASSIFIED_CATEGORY_KEY];
  const groups: VendorPickerGroup[] = [];
  for (const key of orderedKeys) {
    const items = byCategory.get(key);
    if (!items || items.length === 0) continue;
    items.sort((a, b) => a.option.name.localeCompare(b.option.name, 'ru'));
    groups.push({ key, label: categoryLabel(key), items });
  }

  const trimmed = query.trim();
  const duplicate = options.some((option) => option.name.toLowerCase() === needle);
  const createItem: VendorPickerItem | null =
    trimmed.length >= MIN_VENDOR_NAME_LENGTH && !duplicate
      ? { kind: 'create', key: 'create', name: trimmed }
      : null;

  const emptyItem: VendorPickerItem | null =
    includeEmpty && !needle ? { kind: 'empty', key: 'empty' } : null;

  const items: VendorPickerItem[] = [];
  if (emptyItem) items.push(emptyItem);
  for (const group of groups) items.push(...group.items);
  if (createItem) items.push(createItem);

  return { emptyItem, groups, createItem, items };
}

/**
 * Соседний пункт для стрелки. Список зациклен: с последнего вниз — на первый.
 *
 * `from === null` — фокуса в списке ещё нет (список только открылся): вниз даёт
 * первый пункт, вверх — последний, как в меню шапки.
 */
export function stepVendorItem(
  items: VendorPickerItem[],
  from: string | null,
  direction: 1 | -1,
): string | null {
  if (items.length === 0) return null;
  const current = from === null ? -1 : items.findIndex((item) => item.key === from);
  if (current === -1) return (direction === 1 ? items[0] : items[items.length - 1]).key;
  const next = (current + direction + items.length) % items.length;
  return items[next].key;
}
