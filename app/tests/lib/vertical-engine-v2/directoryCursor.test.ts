/** @jest-environment node */

/**
 * Закладка выдачи реестра. Без неё каждый добор начинал листать свой срез с
 * первой страницы, перелистывал уже собранное и однажды упирался в потолок
 * сканирования, после чего сегмент становился недостижимым навсегда.
 */
jest.mock('@/lib/companiesSearch/rpcSearch', () => ({ searchRows: jest.fn(), searchCount: jest.fn() }));

import { fetchDirectoryRows, mapDirectoryRow } from '@/lib/verticalEngineV2/stages/baseCollect';
import { searchRows } from '@/lib/companiesSearch/rpcSearch';
import type { VeStageContext } from '@/lib/verticalEngineV2/stages/shared';

const ctx = {} as VeStageContext;
const empty = { inns: new Set<string>(), emails: new Set<string>(), receipts: new Set<string>(), websiteInns: new Map<string, Set<string>>() };
/** Полная страница выдачи: 1000 строк, как отдаёт RPC. */
const page = (from: number, size = 1000) => Array.from({ length: size }, (_, i) => ({
  name: `Компания ${from + i}`, inn: String(7700000000 + from + i), website: `https://c${from + i}.test/`, email: `mail@c${from + i}.test`,
}));

describe('закладка выдачи реестра', () => {
  beforeEach(() => jest.mocked(searchRows).mockReset());

  it('продолжает с сохранённого смещения, а не с первой страницы', async () => {
    jest.mocked(searchRows).mockImplementation(async (_f, limit, offset) => ({ rows: page(offset ?? 0, limit) }));
    const result = await fetchDirectoryRows(ctx, {}, 10, empty, 5_000);
    expect(jest.mocked(searchRows).mock.calls[0][2]).toBe(5_000);
    // Первая же страница даёт нужное: сканируем ровно 10 строк и на них встаём.
    expect(result.rows).toHaveLength(10);
    expect(result.nextOffset).toBe(5_010);
  });

  it('не перешагивает строки, которые не разобрал', async () => {
    // Страница на 1000 строк, а нужно всего 10: закладка обязана встать на
    // 10-й строке, иначе следующий заход потеряет 990 компаний.
    jest.mocked(searchRows).mockResolvedValue({ rows: page(0) });
    const first = await fetchDirectoryRows(ctx, {}, 10, empty);
    expect(first.nextOffset).toBe(10);

    const second = await fetchDirectoryRows(ctx, {}, 10, empty, first.nextOffset);
    expect(jest.mocked(searchRows).mock.calls[1][2]).toBe(10);
    expect(second.rows).toHaveLength(10);
  });

  it('пропущенные дубли двигают закладку наравне с взятыми', async () => {
    // Иначе уже собранные компании перечитывались бы вечно.
    jest.mocked(searchRows).mockResolvedValue({ rows: page(0, 5) });
    const excluded = { ...empty, emails: new Set(['mail@c0.test', 'mail@c1.test']) };
    const result = await fetchDirectoryRows(ctx, {}, 2, excluded);
    expect(result.excludedDuringFetch).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(result.nextOffset).toBe(4);
  });

  it('короткая страница означает исчерпание сегмента, а не потолок', async () => {
    jest.mocked(searchRows).mockResolvedValue({ rows: page(0, 3) });
    const result = await fetchDirectoryRows(ctx, {}, 50, empty);
    expect(result).toMatchObject({ exhausted: true, hitCeiling: false, nextOffset: 3 });
  });

  it('ошибка выдачи не двигает закладку', async () => {
    jest.mocked(searchRows).mockResolvedValue({ rows: [], error: 'rpc timeout' });
    const result = await fetchDirectoryRows(ctx, {}, 10, empty, 700);
    expect(result).toMatchObject({ error: 'rpc timeout', nextOffset: 700, exhausted: false, hitCeiling: false });
  });
});

describe('строка реестра', () => {
  it('отдаёт название вида деятельности и отрасль, а не только код', () => {
    // Классификатор и первичная проверка читают category как текст. Код
    // «28.30» не говорит им ничего, из-за чего компании из реестра массово
    // оставались без вердикта.
    const row = mapDirectoryRow({
      name: 'ООО "Ромашка"', inn: '7700000001', website: 'https://romashka.ru', email: 'info@romashka.ru',
      okved_code: '28.30', okved_name: 'Производство машин и оборудования для сельского и лесного хозяйства',
      activity_type: 'Сельхозтехника', address: 'Тула', employees_count: 120, revenue: 500000000, phones: '+7 999 000-00-00, +7 999 111-11-11',
    });
    expect(row.category.split('\n')).toEqual([
      'Производство машин и оборудования для сельского и лесного хозяйства',
      'Сельхозтехника',
      '28.30',
    ]);
    // Остальное разбирается как раньше: телефон — первый из списка.
    expect(row).toMatchObject({ company: 'ООО "Ромашка"', inn: '7700000001', phone: '+7 999 000-00-00', source_detail: 'реестр' });
  });

  it('обходится одним кодом, если справочник ничего не дал', () => {
    const row = mapDirectoryRow({ name: 'ООО "Пустышка"', okved_code: '62.01' });
    expect(row.category).toBe('62.01');
  });
});
