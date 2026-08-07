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

// Архив gis_signal_company_signals под контролем теста: twogis_id → checked_at (ISO).
let archivedCheckedAt: Record<string, string> = {};
let signalsInCalls: number[] = [];
let signalsFailOnCall: number | null = null;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return {
      from: (table: string) => ({
        select: () => ({
          in: (_col: string, ids: string[]) => {
            if (table === 'gis_signal_company_signals') {
              const callIdx = signalsInCalls.length;
              signalsInCalls.push(ids.length);
              return {
                // Мок честно применяет gt-фильтр: checked_at > cutoff (ISO-строки
                // одного формата сравниваются лексикографически).
                gt: (_col2: string, cutoff: string) => {
                  if (signalsFailOnCall === callIdx) {
                    return Promise.resolve({
                      data: null,
                      error: { message: 'connection reset by peer' },
                    });
                  }
                  const data = ids
                    .filter((id) => archivedCheckedAt[id] && archivedCheckedAt[id] > cutoff)
                    .map((twogis_id) => ({ twogis_id }));
                  return Promise.resolve({ data, error: null });
                },
              };
            }
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

import { filterUnseenIds, filterRecentlyCheckedIds } from '@/lib/gisSignalOutreach/seenCompanies';

beforeEach(() => {
  inCalls = [];
  failOnCall = null;
  archivedCheckedAt = {};
  signalsInCalls = [];
  signalsFailOnCall = null;
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

describe('filterRecentlyCheckedIds — дедуп по архиву проверок (окно 30 дней)', () => {
  it('свежие checked_at отсекаются, старые и отсутствующие в архиве проходят', async () => {
    const now = Date.now();
    archivedCheckedAt = {
      recent1: new Date(now - 2 * 86400e3).toISOString(), // 2 дня назад → отсев
      old1: new Date(now - 45 * 86400e3).toISOString(), // 45 дней назад → проходит (окно 30)
    };
    const out = await filterRecentlyCheckedIds(['recent1', 'old1', 'absent1']);
    expect([...out].sort()).toEqual(['absent1', 'old1']);
  });

  it('параметр days сдвигает окно: 45-дневная проверка свежая при days=60', async () => {
    archivedCheckedAt = { old1: new Date(Date.now() - 45 * 86400e3).toISOString() };
    const out = await filterRecentlyCheckedIds(['old1'], 60);
    expect(out.size).toBe(0);
  });

  it('250 id идут чанками не больше 100 (URL остаётся коротким)', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `70000001000000${String(i).padStart(4, '0')}`);
    const out = await filterRecentlyCheckedIds(ids);
    expect(out.size).toBe(250);
    expect(signalsInCalls).toEqual([100, 100, 50]);
    expect(Math.max(...signalsInCalls)).toBeLessThanOrEqual(100);
  });

  it('ошибка lookup → fail-closed (пустой Set) + warn с текстом ошибки', async () => {
    signalsFailOnCall = 0;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await filterRecentlyCheckedIds(['700000010000000001', '700000010000000002']);
    expect(out.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('connection reset by peer'));
    warn.mockRestore();
  });
});
