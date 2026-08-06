/** @jest-environment node */

jest.mock('server-only', () => ({}));

/**
 * Страж чанкинга seen-lookup'а: SELECT с .in() кладёт id в URL — 2GIS id длинные
 * (16-17 цифр), чанк 500 давал ~10 КБ URL и nginx резал запрос (414), а тихий
 * fail-closed превращал это в «отсеяны все кандидаты» (06.08.2026, первый
 * прод-прогон: 21122/21122 отсев). Теперь чанк 100 + warn с текстом ошибки.
 */

let inCalls: number[] = [];
let failOnCall: number | null = null;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return {
      from: () => ({
        select: () => ({
          in: (_col: string, ids: string[]) => {
            const callIdx = inCalls.length;
            inCalls.push(ids.length);
            if (failOnCall === callIdx) {
              return Promise.resolve({ data: null, error: { message: '414 URI Too Long' } });
            }
            return Promise.resolve({ data: [], error: null });
          },
        }),
      }),
    };
  },
}));

import { filterUnseenIds } from '@/lib/gisSignalOutreach/seenCompanies';

beforeEach(() => {
  inCalls = [];
  failOnCall = null;
});

describe('filterUnseenIds — чанкинг под лимит URL', () => {
  it('250 id идут чанками не больше 100 (URL остаётся коротким)', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `70000001000000${String(i).padStart(4, '0')}`);
    const unseen = await filterUnseenIds(ids);
    expect(unseen.size).toBe(250);
    expect(inCalls).toEqual([100, 100, 50]);
    expect(Math.max(...inCalls)).toBeLessThanOrEqual(100);
  });

  it('ошибка lookup → fail-closed (пустой Set) + warn с текстом ошибки', async () => {
    failOnCall = 0;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const unseen = await filterUnseenIds(['700000010000000001', '700000010000000002']);
    expect(unseen.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('414 URI Too Long'));
    warn.mockRestore();
  });
});
