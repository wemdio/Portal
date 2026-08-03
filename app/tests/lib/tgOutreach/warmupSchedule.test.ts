/**
 * @jest-environment node
 *
 * Планировщик прогрева — единственное место, где живёт вся арифметика фичи,
 * поэтому покрытие здесь плотное. Проверяем три вещи:
 *
 * 1. Кривая нагрузки: переписок на аккаунт и длина переписки растут от первого
 *    дня к последнему, границы держатся при любом числе дней.
 * 2. Подбор пар: каждый аккаунт получает свою дневную норму, пара не
 *    повторяется внутри дня, незнакомые партнёры имеют приоритет.
 * 3. Времена: попадают в активное окно суток и идут по возрастанию.
 *
 * Случайность инжектится (`random`), поэтому тесты детерминированы.
 */

import {
  conversationsPerAccount,
  messagesPerConversation,
  planDay,
} from '@/lib/tgOutreach/warmup/schedule';

const WINDOW = {
  start: new Date('2026-08-04T08:00:00Z'),
  end: new Date('2026-08-04T22:00:00Z'),
};

/** Детерминированный «рандом»: крутит переданную последовательность по кругу. */
const seq = (vals: number[]) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};

describe('warmup schedule — кривая нагрузки', () => {
  it('4 дня: переписок на аккаунт растёт 2 → 4 → 6 → 8', () => {
    expect([1, 2, 3, 4].map((d) => conversationsPerAccount(d, 4))).toEqual([2, 4, 6, 8]);
  });

  it('4 дня: длина переписки растёт от 3 до 10 сообщений', () => {
    const lens = [1, 2, 3, 4].map((d) => messagesPerConversation(d, 4));
    expect(lens[0]).toBe(3);
    expect(lens[3]).toBe(10);
    expect(lens[1]).toBeLessThan(lens[2]);
  });

  it('3 дня: границы те же, кривая сжимается', () => {
    expect(conversationsPerAccount(1, 3)).toBe(2);
    expect(conversationsPerAccount(3, 3)).toBe(8);
  });

  it('день вне диапазона зажимается в границы', () => {
    expect(conversationsPerAccount(0, 4)).toBe(2);
    expect(conversationsPerAccount(99, 4)).toBe(8);
  });

  it('прогрев в один день сразу идёт на полную мощность', () => {
    expect(conversationsPerAccount(1, 1)).toBe(8);
    expect(messagesPerConversation(1, 1)).toBe(10);
  });
});

describe('warmup schedule — подбор пар', () => {
  const ids = ['a', 'b', 'c', 'd'];

  const countPerAccount = (plan: ReturnType<typeof planDay>) => {
    const count = new Map<string, number>();
    for (const c of plan) {
      count.set(c.accountAId, (count.get(c.accountAId) ?? 0) + 1);
      count.set(c.accountBId, (count.get(c.accountBId) ?? 0) + 1);
    }
    return count;
  };

  it('каждый аккаунт получает свою дневную норму переписок', () => {
    const plan = planDay({
      accountIds: ids, day: 1, totalDays: 4,
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    });
    const count = countPerAccount(plan);
    for (const id of ids) expect(count.get(id)).toBe(2);
  });

  it('одна и та же пара не встречается дважды за день', () => {
    const plan = planDay({
      accountIds: ids, day: 4, totalDays: 4,
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    });
    const keys = plan.map((c) => `${c.accountAId}|${c.accountBId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('пара нормализована: accountAId всегда меньше accountBId', () => {
    const plan = planDay({
      accountIds: ids, day: 2, totalDays: 4,
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    });
    expect(plan.length).toBeGreaterThan(0);
    for (const c of plan) expect(c.accountAId < c.accountBId).toBe(true);
  });

  it('незнакомые партнёры имеют приоритет над уже знакомыми', () => {
    // a уже говорил с b и c; при норме в одну переписку он должен выбрать d.
    const plan = planDay({
      accountIds: ids, day: 1, totalDays: 1,
      previousPairs: [['a', 'b'], ['a', 'c']],
      window: WINDOW, random: seq([0.5]), targetOverride: 1,
    });
    const aPair = plan.find((c) => c.accountAId === 'a' || c.accountBId === 'a');
    expect(aPair).toBeDefined();
    const partner = aPair!.accountAId === 'a' ? aPair!.accountBId : aPair!.accountAId;
    expect(partner).toBe('d');
  });

  it('когда незнакомых не осталось, возвращаемся к знакомым, а не бросаем норму', () => {
    // Все пары уже знакомы — план всё равно должен закрыть дневную норму.
    const previousPairs: Array<[string, string]> = [
      ['a', 'b'], ['a', 'c'], ['a', 'd'], ['b', 'c'], ['b', 'd'], ['c', 'd'],
    ];
    const plan = planDay({
      accountIds: ids, day: 1, totalDays: 4,
      previousPairs, window: WINDOW, random: seq([0.5]),
    });
    const count = countPerAccount(plan);
    for (const id of ids) expect(count.get(id)).toBe(2);
  });

  it('нечётное число аккаунтов не роняет планировщик', () => {
    const plan = planDay({
      accountIds: ['a', 'b', 'c'], day: 1, totalDays: 4,
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    });
    expect(plan.length).toBeGreaterThan(0);
    for (const c of plan) expect(c.accountAId).not.toBe(c.accountBId);
  });

  it('меньше двух аккаунтов — пустой план, без исключения', () => {
    expect(planDay({
      accountIds: ['a'], day: 1, totalDays: 4,
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    })).toEqual([]);
    expect(planDay({
      accountIds: [], day: 1, totalDays: 4,
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    })).toEqual([]);
  });

  it('норма больше, чем есть партнёров: план конечен, зацикливания нет', () => {
    // Три аккаунта, норма 8 — каждый может поговорить максимум с двумя.
    const plan = planDay({
      accountIds: ['a', 'b', 'c'], day: 4, totalDays: 4,
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    });
    expect(plan).toHaveLength(3);
  });

  it('длина переписки в плане соответствует дню', () => {
    const plan = planDay({
      accountIds: ids, day: 4, totalDays: 4,
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    });
    for (const c of plan) expect(c.plannedMessages).toBe(10);
  });

  it('времена попадают в окно и идут по возрастанию', () => {
    const plan = planDay({
      accountIds: ids, day: 3, totalDays: 4,
      previousPairs: [], window: WINDOW,
      random: seq([0.1, 0.4, 0.7, 0.9, 0.2, 0.6, 0.35]),
    });
    const times = plan.map((c) => new Date(c.plannedAt).getTime());
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(WINDOW.start.getTime());
      expect(t).toBeLessThanOrEqual(WINDOW.end.getTime());
    }
    expect([...times].sort((x, y) => x - y)).toEqual(times);
  });

  it('инициатор — один из участников пары', () => {
    const plan = planDay({
      accountIds: ids, day: 1, totalDays: 4,
      previousPairs: [], window: WINDOW, random: seq([0.9, 0.1]),
    });
    for (const c of plan) {
      expect([c.accountAId, c.accountBId]).toContain(c.initiatorAccountId);
    }
  });
});
