/**
 * Сортировка таблиц дашборда «Нагрузка почт».
 *
 * Таблица приходит с сервера отсортированной по потолку — это разумный вид по
 * умолчанию, но отвечает он ровно на один вопрос. Оператору нужны и другие:
 * «кто больше всех недогружен», «у кого простаивает больше всего ящиков», «чьи
 * теги встали». Поэтому сортировка по любому столбцу.
 *
 * Два правила, ради которых это вынесено в отдельный модуль с тестами:
 *
 * 1. Пустая утилизация всегда внизу, в обе стороны. У тега без потолка она
 *    null, и «отсортировать по утилизации» не должно означать «показать
 *    сначала стену прочерков» — ни по возрастанию, ни по убыванию.
 *
 * 2. Статус сортируется по смыслу, а не по алфавиту: «Норма» между «Недогруз»
 *    и «Потолок» — по алфавиту она оказалась бы между «Недогруз» и «Перебор»,
 *    что читается как случайность. Порядок совпадает с ростом утилизации.
 */

import type { TagLoad, SpecialistLoad, TagStatus } from './mailboxLoad';

export type SortDir = 'asc' | 'desc';

export type TagSortKey =
  | 'tag' | 'specialist' | 'mailboxes' | 'capacity' | 'sent' | 'utilization' | 'status';

export type SpecialistSortKey =
  | 'specialist' | 'tagCount' | 'mailboxes' | 'capacity' | 'sent' | 'utilization' | 'status';

export interface SortState<K> {
  key: K;
  dir: SortDir;
}

/**
 * Ранг статуса = насколько выбран потолок. Совпадает с порядком по
 * утилизации, поэтому переключение между «сортировать по статусу» и
 * «сортировать по утилизации» не переворачивает картину с ног на голову.
 */
const STATUS_RANK: Record<TagStatus, number> = {
  no_capacity: 0,
  stopped: 1,
  idle: 2,
  low: 3,
  ok: 4,
  full: 5,
  over: 6,
};

/** Имя специалиста как оно показано на экране — по нему и сортируем. */
export function specialistLabel(value: string | null): string {
  if (!value || value === '__unassigned__') return 'Не привязано';
  return value;
}

/** Первый клик по столбцу: числа — от большего, текст — от «А». */
export function defaultDirFor(key: TagSortKey | SpecialistSortKey): SortDir {
  return key === 'tag' || key === 'specialist' ? 'asc' : 'desc';
}

function cmpText(a: string, b: string): number {
  return a.localeCompare(b, 'ru');
}

function cmpNum(a: number, b: number): number {
  return a - b;
}

/**
 * Сравнение с «пусто всегда вниз».
 *
 * Знак направления к таким строкам не применяется — иначе прочерки всплывали
 * бы наверх при одном из двух кликов.
 */
function withNullsLast(
  a: number | null,
  b: number | null,
  dir: SortDir,
): number | null {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return dir === 'asc' ? cmpNum(a, b) : cmpNum(b, a);
}

export function sortTags(rows: TagLoad[], sort: SortState<TagSortKey> | null): TagLoad[] {
  if (!sort) return rows;
  const { key, dir } = sort;
  const sign = dir === 'asc' ? 1 : -1;

  return [...rows].sort((a, b) => {
    switch (key) {
      case 'tag':
        return sign * cmpText(a.tag, b.tag);
      case 'specialist':
        return sign * cmpText(specialistLabel(a.specialist), specialistLabel(b.specialist));
      case 'mailboxes':
        return sign * cmpNum(a.activeMailboxes, b.activeMailboxes);
      case 'capacity':
        return sign * cmpNum(a.capacity, b.capacity);
      case 'sent':
        return sign * cmpNum(a.sent, b.sent);
      case 'utilization':
        return withNullsLast(a.utilization, b.utilization, dir) ?? 0;
      case 'status':
        return sign * cmpNum(STATUS_RANK[a.status] ?? 0, STATUS_RANK[b.status] ?? 0);
      default:
        return 0;
    }
  });
}

export function sortSpecialists(
  rows: SpecialistLoad[],
  sort: SortState<SpecialistSortKey> | null,
): SpecialistLoad[] {
  if (!sort) return rows;
  const { key, dir } = sort;
  const sign = dir === 'asc' ? 1 : -1;

  return [...rows].sort((a, b) => {
    switch (key) {
      case 'specialist':
        return sign * cmpText(specialistLabel(a.specialist), specialistLabel(b.specialist));
      case 'tagCount':
        return sign * cmpNum(a.tagCount, b.tagCount);
      case 'mailboxes':
        return sign * cmpNum(a.activeMailboxes, b.activeMailboxes);
      case 'capacity':
        return sign * cmpNum(a.capacity, b.capacity);
      case 'sent':
        return sign * cmpNum(a.sent, b.sent);
      case 'utilization':
        return withNullsLast(a.utilization, b.utilization, dir) ?? 0;
      case 'status':
        return sign * cmpNum(STATUS_RANK[a.status] ?? 0, STATUS_RANK[b.status] ?? 0);
      default:
        return 0;
    }
  });
}

/**
 * Клик по заголовку: тот же столбец — переворачиваем, новый — берём его
 * направление по умолчанию.
 */
export function nextSort<K extends TagSortKey | SpecialistSortKey>(
  current: SortState<K> | null,
  key: K,
): SortState<K> {
  if (current?.key === key) {
    return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  }
  return { key, dir: defaultDirFor(key) };
}
