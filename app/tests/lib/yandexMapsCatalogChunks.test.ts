/** @jest-environment node */

/**
 * Сбор по каталогу порциями.
 *
 * Время сбора пропорционально объёму: на бою 14 699 организаций — 7 с,
 * 83 466 — 52 с. Одним запросом человек всё это время смотрит на пустой экран.
 * Порции нужны, чтобы первые тысячи легли за секунды и счётчик пошёл вверх.
 *
 * Каждый шаг — тот же `fill_job` с `limit`, а `on conflict do nothing` делает
 * повторы дешёвыми: шаг видит уже вставленное и добавляет только новое.
 */

jest.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: null }));
jest.mock('pg', () => ({ Pool: class { } }));

import { fillYandexMapsCatalogJobInChunks } from '@/lib/parsers/yandexMapsCatalog';

let mockFill: jest.Mock;

const FILTERS = { cities: ['Москва'], categories: ['Кафе'], countries: ['Россия'] };

/** Имитация базы: всего N подходящих организаций, шаг видит уже вставленные. */
function catalogWith(total: number) {
  let inserted = 0;
  return jest.fn(async (_jobId: string, _filters: unknown, limit: number | null) => {
    const target = limit === null ? total : Math.min(limit, total);
    const added = Math.max(0, target - inserted);
    inserted += added;
    return { organizations: added };
  });
}

describe('сбор по каталогу порциями', () => {
  it('крупная выдача идёт лесенкой и сообщает прогресс по дороге', async () => {
    mockFill = catalogWith(200_000);
    const progress: number[] = [];

    const result = await fillYandexMapsCatalogJobInChunks(
      'job-1', FILTERS, null, (collected) => { progress.push(collected); }, mockFill,
    );

    expect(result.organizations).toBe(200_000);
    // Первая порция мала намеренно: результаты должны появиться сразу.
    expect(progress[0]).toBe(5_000);
    // Счётчик растёт, а не прыгает сразу к финалу.
    expect(progress).toEqual([5_000, 20_000, 80_000, 200_000, 200_000]);
    expect(mockFill.mock.calls.map((c) => c[2])).toEqual([5_000, 20_000, 80_000, 320_000, null]);
  });

  it('маленькая выдача не гоняет всю лесенку', async () => {
    mockFill = catalogWith(1_200);

    const result = await fillYandexMapsCatalogJobInChunks(
      'job-2', FILTERS, null, undefined, mockFill,
    );

    expect(result.organizations).toBe(1_200);
    // Первая же порция не набралась до потолка — дальше по лесенке идти незачем.
    expect(mockFill.mock.calls.map((c) => c[2])).toEqual([5_000, null]);
  });

  it('последним всегда идёт вызов с настоящим потолком задачи', async () => {
    // Полноту нельзя выводить из «прибавка меньше порции»: одна карточка может
    // встретиться в каталоге дважды и вставиться один раз. Финальный вызов
    // закрывает этот случай.
    mockFill = catalogWith(50_000);
    await fillYandexMapsCatalogJobInChunks('job-3', FILTERS, null, undefined, mockFill);
    expect(mockFill.mock.calls.at(-1)?.[2]).toBeNull();
  });

  it('запрошенный потолок не превышается и не дробится сверх него', async () => {
    mockFill = catalogWith(500_000);
    const result = await fillYandexMapsCatalogJobInChunks('job-4', FILTERS, 30_000, undefined, mockFill);

    expect(result.organizations).toBe(30_000);
    // Порции крупнее запрошенного объёма пропущены — их доделает финальный вызов.
    expect(mockFill.mock.calls.map((c) => c[2])).toEqual([5_000, 20_000, 30_000]);
  });
});
