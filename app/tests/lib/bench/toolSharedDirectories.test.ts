/** @jest-environment node */

const searchTwoGisCards = jest.fn(
  async (_f: unknown, _o: unknown): Promise<{ rows: unknown[]; nextCursor: string | null }> => ({
    rows: [],
    nextCursor: null,
  }),
);
const searchRows = jest.fn(
  async (
    _f: unknown,
    _l: number,
    _o: number,
  ): Promise<{ rows: Record<string, unknown>[]; error?: string }> => ({ rows: [] }),
);

jest.mock('@/lib/twoGis/repository', () => ({
  searchTwoGisCards: (f: unknown, o: unknown) => searchTwoGisCards(f, o),
}));
jest.mock('@/lib/companiesSearch/rpcSearch', () => ({
  searchRows: (f: unknown, l: number, o: number) => searchRows(f, l, o),
}));

import { ourBasesTool, twoGisTool } from '@/lib/bench/tools/sharedDirectories';

beforeEach(() => {
  searchTwoGisCards.mockClear();
  searchRows.mockClear();
});

describe('общие справочники', () => {
  it('помечены как читаемые мимо клиента робота — осознанно', () => {
    // Признак существует, чтобы обход был виден в контракте, а не всплыл
    // через полгода как сюрприз.
    expect(twoGisTool.access).toBe('shared-reference');
    expect(ourBasesTool.access).toBe('shared-reference');
  });

  it('не пропускают лишние фильтры', () => {
    expect(twoGisTool.filtersSchema.safeParse({ drop: 1 }).success).toBe(false);
    expect(ourBasesTool.filtersSchema.safeParse({ drop: 1 }).success).toBe(false);
  });
});

describe('2GIS', () => {
  it('переводит фильтры во внутренние имена', async () => {
    const filters = twoGisTool.filtersSchema.parse({ cities: ['Москва'], has_email: true });
    await twoGisTool.run({ db: {} as never, filters, limit: 50, cursor: null });
    expect(searchTwoGisCards).toHaveBeenCalledWith(
      expect.objectContaining({ cities: ['Москва'], hasEmail: true }),
      { limit: 50, cursor: undefined },
    );
  });

  it('has_more выводится из курсора репозитория', async () => {
    searchTwoGisCards.mockResolvedValueOnce({ rows: [{ id: 'a' }], nextCursor: 'a' });
    const page = await twoGisTool.run({
      db: {} as never,
      filters: {},
      limit: 1,
      cursor: null,
    });
    expect(page.cursor).toBe('a');
    expect(page.has_more).toBe(true);
  });

  it('последняя страница не обещает продолжения', async () => {
    searchTwoGisCards.mockResolvedValueOnce({ rows: [{ id: 'a' }], nextCursor: null });
    const page = await twoGisTool.run({ db: {} as never, filters: {}, limit: 10, cursor: null });
    expect(page.has_more).toBe(false);
  });
});

describe('наша база баз', () => {
  it('листает смещением, спрятанным за строковым курсором', async () => {
    searchRows.mockResolvedValueOnce({ rows: [{ a: 1 }, { a: 2 }] });
    const page = await ourBasesTool.run({
      db: {} as never,
      filters: {},
      limit: 2,
      cursor: null,
    });
    expect(searchRows).toHaveBeenCalledWith(expect.anything(), 2, 0);
    expect(page.cursor).toBe('2');
    expect(page.has_more).toBe(true);
  });

  it('продолжает с переданного места', async () => {
    searchRows.mockResolvedValueOnce({ rows: [] });
    await ourBasesTool.run({ db: {} as never, filters: {}, limit: 2, cursor: '2' });
    expect(searchRows).toHaveBeenCalledWith(expect.anything(), 2, 2);
  });

  it('сбой каталога не выглядит как «ничего не нашлось»', async () => {
    searchRows.mockResolvedValueOnce({ rows: [], error: 'RPC timeout' });
    await expect(
      ourBasesTool.run({ db: {} as never, filters: {}, limit: 10, cursor: null }),
    ).rejects.toThrow('RPC timeout');
  });
});
