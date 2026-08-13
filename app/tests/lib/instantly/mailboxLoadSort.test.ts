/** @jest-environment node */

/**
 * Сортировка «Нагрузки почт». Таблица приходит отсортированной по потолку —
 * это ответ ровно на один вопрос, а оператору нужны и «кто больше всех
 * недогружен», и «чьи теги встали».
 *
 * Два свойства держим тестами, потому что оба ломаются незаметно: прочерки не
 * должны всплывать наверх, а статус обязан сортироваться по смыслу, а не по
 * алфавиту.
 */

import {
  sortTags,
  sortSpecialists,
  nextSort,
  defaultDirFor,
  specialistLabel,
} from '@/lib/instantly/mailboxLoadSort';
import type { TagLoad, SpecialistLoad } from '@/lib/instantly/mailboxLoad';

const tag = (over: Partial<TagLoad>): TagLoad => ({
  tagId: over.tag ?? 'id',
  tag: 'tag',
  activeMailboxes: 10,
  totalMailboxes: 10,
  capacity: 300,
  sent: 150,
  utilization: 0.5,
  status: 'ok',
  specialist: 'Иван',
  client: null,
  otherSpecialists: [],
  projectCount: 1,
  ...over,
});

const names = (rows: Array<{ tag: string }>) => rows.map((r) => r.tag);

describe('sortTags', () => {
  const rows = [
    tag({ tag: 'Бета', capacity: 100, sent: 90, utilization: 0.9, status: 'full', specialist: 'Пётр' }),
    tag({ tag: 'Альфа', capacity: 300, sent: 30, utilization: 0.1, status: 'low', specialist: 'Иван' }),
    tag({ tag: 'Гамма', capacity: 200, sent: 0, utilization: 0, status: 'idle', specialist: null }),
  ];

  it('без сортировки порядок сервера не трогаем', () => {
    expect(names(sortTags(rows, null))).toEqual(['Бета', 'Альфа', 'Гамма']);
  });

  it('исходный массив не мутируется', () => {
    const before = names(rows);
    sortTags(rows, { key: 'capacity', dir: 'asc' });
    expect(names(rows)).toEqual(before);
  });

  it('по числам в обе стороны', () => {
    expect(names(sortTags(rows, { key: 'capacity', dir: 'desc' }))).toEqual(['Альфа', 'Гамма', 'Бета']);
    expect(names(sortTags(rows, { key: 'sent', dir: 'asc' }))).toEqual(['Гамма', 'Альфа', 'Бета']);
  });

  it('по названию — по-русски', () => {
    expect(names(sortTags(rows, { key: 'tag', dir: 'asc' }))).toEqual(['Альфа', 'Бета', 'Гамма']);
  });

  it('специалист сортируется по видимой подписи, а не по «__unassigned__»', () => {
    const sorted = sortTags(rows, { key: 'specialist', dir: 'asc' });
    // «Иван» < «Не привязано» < «Пётр»
    expect(names(sorted)).toEqual(['Альфа', 'Гамма', 'Бета']);
  });

  /** Главное свойство: тег без потолка не должен занимать верх таблицы. */
  it('пустая утилизация всегда внизу — в обе стороны', () => {
    const withNulls = [
      tag({ tag: 'Пусто1', capacity: 0, utilization: null, status: 'no_capacity' }),
      tag({ tag: 'Мало', utilization: 0.2 }),
      tag({ tag: 'Пусто2', capacity: 0, utilization: null, status: 'no_capacity' }),
      tag({ tag: 'Много', utilization: 0.95 }),
    ];

    expect(names(sortTags(withNulls, { key: 'utilization', dir: 'desc' })))
      .toEqual(['Много', 'Мало', 'Пусто1', 'Пусто2']);
    expect(names(sortTags(withNulls, { key: 'utilization', dir: 'asc' })))
      .toEqual(['Мало', 'Много', 'Пусто1', 'Пусто2']);
  });

  /**
   * По алфавиту «Норма» встала бы между «Недогруз» и «Перебор». Сортируем по
   * смыслу — тем же порядком, что и утилизация.
   */
  it('статус — по выбранности потолка, а не по алфавиту', () => {
    const byStatus = [
      tag({ tag: 'Перебор', status: 'over' }),
      tag({ tag: 'Простой', status: 'idle' }),
      tag({ tag: 'Норма', status: 'ok' }),
      tag({ tag: 'Недогруз', status: 'low' }),
      tag({ tag: 'Потолок', status: 'full' }),
    ];
    expect(names(sortTags(byStatus, { key: 'status', dir: 'asc' })))
      .toEqual(['Простой', 'Недогруз', 'Норма', 'Потолок', 'Перебор']);
  });
});

describe('sortSpecialists', () => {
  const spec = (over: Partial<SpecialistLoad>): SpecialistLoad => ({
    specialist: 'Иван',
    tagCount: 2,
    activeMailboxes: 20,
    capacity: 600,
    sent: 300,
    utilization: 0.5,
    status: 'ok',
    clients: [],
    tags: [],
    ...over,
  });

  it('сортирует по своим столбцам и держит «Не привязано» по подписи', () => {
    const rows = [
      spec({ specialist: 'Пётр', sent: 10 }),
      spec({ specialist: '__unassigned__', sent: 50 }),
      spec({ specialist: 'Иван', sent: 30 }),
    ];
    expect(sortSpecialists(rows, { key: 'sent', dir: 'desc' }).map((r) => r.specialist))
      .toEqual(['__unassigned__', 'Иван', 'Пётр']);
    expect(sortSpecialists(rows, { key: 'specialist', dir: 'asc' }).map((r) => r.specialist))
      .toEqual(['Иван', '__unassigned__', 'Пётр']);
  });

  it('пустая утилизация внизу и здесь', () => {
    const rows = [
      spec({ specialist: 'Без потолка', utilization: null }),
      spec({ specialist: 'С данными', utilization: 0.3 }),
    ];
    expect(sortSpecialists(rows, { key: 'utilization', dir: 'desc' })[0].specialist).toBe('С данными');
    expect(sortSpecialists(rows, { key: 'utilization', dir: 'asc' })[0].specialist).toBe('С данными');
  });
});

describe('nextSort', () => {
  it('первый клик: числа от большего, текст от «А»', () => {
    expect(nextSort(null, 'capacity')).toEqual({ key: 'capacity', dir: 'desc' });
    expect(nextSort(null, 'tag')).toEqual({ key: 'tag', dir: 'asc' });
    expect(defaultDirFor('utilization')).toBe('desc');
  });

  it('повторный клик по тому же столбцу переворачивает', () => {
    expect(nextSort({ key: 'sent', dir: 'desc' }, 'sent')).toEqual({ key: 'sent', dir: 'asc' });
    expect(nextSort({ key: 'sent', dir: 'asc' }, 'sent')).toEqual({ key: 'sent', dir: 'desc' });
  });

  it('клик по другому столбцу берёт его направление по умолчанию', () => {
    expect(nextSort({ key: 'sent', dir: 'asc' }, 'tag')).toEqual({ key: 'tag', dir: 'asc' });
  });
});

describe('specialistLabel', () => {
  it('технический маркер превращается в человеческую подпись', () => {
    expect(specialistLabel('__unassigned__')).toBe('Не привязано');
    expect(specialistLabel(null)).toBe('Не привязано');
    expect(specialistLabel('Иван')).toBe('Иван');
  });
});
