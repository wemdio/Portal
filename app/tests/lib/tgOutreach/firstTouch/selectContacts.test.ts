/** @jest-environment node */

/**
 * Чередование баз — не украшение, а условие сравнимости гипотез. Если брать
 * базы подряд, триста контактов первой уйдут за сутки, а вторая начнётся через
 * день, и сравнивать будет нечего: у баз окажется разное время на ответы.
 */

import { selectNextContacts, remainingDailyQuota } from '@/lib/tgOutreach/firstTouch/selectContacts';

const c = (baseId: string, n: number) => ({
  id: `${baseId}-${n}`,
  base_id: baseId,
  username: `user${baseId}${n}`,
  message: `сообщение ${baseId}${n}`,
});

describe('selectNextContacts', () => {
  it('берёт из баз по кругу, а не подряд', () => {
    const picked = selectNextContacts({
      perBase: [
        { baseId: 'A', contacts: [c('A', 1), c('A', 2), c('A', 3)] },
        { baseId: 'B', contacts: [c('B', 1), c('B', 2), c('B', 3)] },
      ],
      limit: 4,
    });
    expect(picked.map((p) => p.id)).toEqual(['A-1', 'B-1', 'A-2', 'B-2']);
  });

  it('кончилась одна база — добирает из оставшихся', () => {
    const picked = selectNextContacts({
      perBase: [
        { baseId: 'A', contacts: [c('A', 1)] },
        { baseId: 'B', contacts: [c('B', 1), c('B', 2), c('B', 3)] },
      ],
      limit: 4,
    });
    expect(picked.map((p) => p.id)).toEqual(['A-1', 'B-1', 'B-2', 'B-3']);
  });

  it('лимит соблюдается точно', () => {
    const picked = selectNextContacts({
      perBase: [{ baseId: 'A', contacts: [c('A', 1), c('A', 2), c('A', 3)] }],
      limit: 2,
    });
    expect(picked).toHaveLength(2);
  });

  it('лимит ноль или меньше — не берём ничего', () => {
    const perBase = [{ baseId: 'A', contacts: [c('A', 1)] }];
    expect(selectNextContacts({ perBase, limit: 0 })).toEqual([]);
    expect(selectNextContacts({ perBase, limit: -5 })).toEqual([]);
  });

  it('пустые базы не ломают чередование', () => {
    const picked = selectNextContacts({
      perBase: [
        { baseId: 'A', contacts: [] },
        { baseId: 'B', contacts: [c('B', 1), c('B', 2)] },
        { baseId: 'C', contacts: [] },
      ],
      limit: 5,
    });
    expect(picked.map((p) => p.id)).toEqual(['B-1', 'B-2']);
  });

  it('баз нет — пустой результат', () => {
    expect(selectNextContacts({ perBase: [], limit: 10 })).toEqual([]);
  });
});

describe('remainingDailyQuota', () => {
  it('остаток дневной нормы аккаунта', () => {
    expect(remainingDailyQuota({ perDay: 20, sentToday: 5 })).toBe(15);
  });

  it('норма выбрана — ноль, а не отрицательное число', () => {
    expect(remainingDailyQuota({ perDay: 20, sentToday: 20 })).toBe(0);
    expect(remainingDailyQuota({ perDay: 20, sentToday: 25 })).toBe(0);
  });

  it('норма не задана или нулевая — первое касание выключено', () => {
    expect(remainingDailyQuota({ perDay: 0, sentToday: 0 })).toBe(0);
    expect(remainingDailyQuota({ perDay: undefined, sentToday: 0 })).toBe(0);
  });
});
