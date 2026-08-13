/**
 * @jest-environment node
 *
 * Планировщик переписок между своими. Кривая нагрузки живёт в `settings.ts` и
 * проверяется в `warmupSettings.test.ts` — сюда нормы приходят готовым числом,
 * поэтому здесь остаётся только подбор пар и раскладка по времени:
 *
 * 1. Каждый аккаунт получает свою дневную норму, пара не повторяется внутри
 *    дня, незнакомые партнёры имеют приоритет.
 * 2. Времена попадают в активное окно суток и идут по возрастанию.
 *
 * Случайность инжектится (`random`), поэтому тесты детерминированы.
 */

import { planDay } from '@/lib/tgOutreach/warmup/schedule';

const WINDOW = {
  start: new Date('2026-08-04T08:00:00Z'),
  end: new Date('2026-08-04T22:00:00Z'),
};

/** Детерминированный «рандом»: крутит переданную последовательность по кругу. */
const seq = (vals: number[]) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};

/** Нормы дня, которые в бою приходят из `dailyLimits`. */
const limits = (conversations: number, messages = 3) => ({
  conversationsPerAccount: conversations,
  messagesPerConversation: messages,
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
      accountIds: ids, ...limits(2),
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    });
    const count = countPerAccount(plan);
    for (const id of ids) expect(count.get(id)).toBe(2);
  });

  it('одна и та же пара не встречается дважды за день', () => {
    const plan = planDay({
      accountIds: ids, ...limits(5),
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    });
    const keys = plan.map((c) => `${c.accountAId}|${c.accountBId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('пара нормализована: accountAId всегда меньше accountBId', () => {
    const plan = planDay({
      accountIds: ids, ...limits(3),
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    });
    expect(plan.length).toBeGreaterThan(0);
    for (const c of plan) expect(c.accountAId < c.accountBId).toBe(true);
  });

  it('незнакомые партнёры имеют приоритет над уже знакомыми', () => {
    // a уже говорил с b и c; при норме в одну переписку он должен выбрать d.
    const plan = planDay({
      accountIds: ids, ...limits(1),
      previousPairs: [['a', 'b'], ['a', 'c']],
      window: WINDOW, random: seq([0.5]),
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
      accountIds: ids, ...limits(2),
      previousPairs, window: WINDOW, random: seq([0.5]),
    });
    const count = countPerAccount(plan);
    for (const id of ids) expect(count.get(id)).toBe(2);
  });

  it('нечётное число аккаунтов не роняет планировщик', () => {
    const plan = planDay({
      accountIds: ['a', 'b', 'c'], ...limits(2),
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    });
    expect(plan.length).toBeGreaterThan(0);
    for (const c of plan) expect(c.accountAId).not.toBe(c.accountBId);
  });

  it('меньше двух аккаунтов — пустой план, без исключения', () => {
    expect(planDay({
      accountIds: ['a'], ...limits(2),
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    })).toEqual([]);
    expect(planDay({
      accountIds: [], ...limits(2),
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    })).toEqual([]);
  });

  it('нулевая норма даёт пустой план: день без переписок допустим', () => {
    expect(planDay({
      accountIds: ids, ...limits(0),
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    })).toEqual([]);
  });

  it('норма больше, чем есть партнёров: план конечен, зацикливания нет', () => {
    // Три аккаунта, норма восьми переписок — каждый может поговорить максимум
    // с двумя, значит пар всего три и планировщик обязан на этом остановиться.
    const plan = planDay({
      accountIds: ['a', 'b', 'c'], ...limits(8),
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    });
    expect(plan).toHaveLength(3);
  });

  it('длина переписки в плане берётся из норм дня', () => {
    const plan = planDay({
      accountIds: ids, ...limits(8, 10),
      previousPairs: [], window: WINDOW, random: seq([0.5]),
    });
    expect(plan.length).toBeGreaterThan(0);
    for (const c of plan) expect(c.plannedMessages).toBe(10);
  });

  it('времена попадают в окно и идут по возрастанию', () => {
    const plan = planDay({
      accountIds: ids, ...limits(4),
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
      accountIds: ids, ...limits(2),
      previousPairs: [], window: WINDOW, random: seq([0.9, 0.1]),
    });
    for (const c of plan) {
      expect([c.accountAId, c.accountBId]).toContain(c.initiatorAccountId);
    }
  });
});
