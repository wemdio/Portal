/** @jest-environment node */

/**
 * Сторожевой таймер прогрева: лечим точечно и никогда не роняем процесс.
 *
 * Инцидент 05.08.2026: одна зависшая кампания = `process.exit(1)` = падение всех
 * остальных вместе с прогревом, 14 раз за ночь.
 *
 * Инцидент 28.08.2026: неубиваемая кампания всё равно роняла процесс, просто
 * через десять минут грации. TG_VBI зависала восемь раз за день и каждый раз
 * уносила четыре здоровые кампании; у ATOL-1 из-за этого не отрабатывал круг —
 * при паузе до десяти минут между аккаунтами процесс не доживал до второго.
 *
 * Ступени `exit` больше нет вовсе: боевые кампании переехали на аренду, и
 * падение процесса теперь роняет ЧУЖИЕ аренды — у здоровых соседей lease_until
 * остаётся живым, их не подберёт никто до конца срока, а перехват спишет это
 * как падение. Проверки ниже фиксируют границу: даже когда живых не осталось,
 * сторож изолирует и живёт дальше.
 */

import { planWatchdogActions, staleKillRequests, type WatchdogSnapshot } from '@/lib/tgOutreach/watchdog';

const MIN = 60_000;
const NOW = 1_000_000_000;

function snapshot(over: Partial<WatchdogSnapshot> = {}): WatchdogSnapshot {
  return {
    now: NOW,
    lastProgressAt: new Map(),
    killRequestedAt: new Map(),
    running: new Set(),
    stallMs: 15 * MIN,
    graceMs: 3 * MIN,
    ...over,
  };
}

describe('planWatchdogActions', () => {
  it('живую кампанию не трогает', () => {
    const s = snapshot({
      lastProgressAt: new Map([['a', NOW - 2 * MIN]]),
      running: new Set(['a']),
    });
    expect(planWatchdogActions(s)).toEqual([]);
  });

  it('первое зависание — просим умереть, процесс не роняем', () => {
    const s = snapshot({
      lastProgressAt: new Map([['a', NOW - 16 * MIN]]),
      running: new Set(['a']),
    });
    expect(planWatchdogActions(s)).toEqual([{ campaignId: 'a', action: 'kill', stallMin: 16 }]);
  });

  it('пока идёт грация после kill — ничего не делаем', () => {
    const s = snapshot({
      lastProgressAt: new Map([['a', NOW - 16 * MIN]]),
      killRequestedAt: new Map([['a', NOW - 1 * MIN]]),
      running: new Set(['a']),
    });
    expect(planWatchdogActions(s)).toEqual([]);
  });

  it('kill сработал, кампания ушла из реестра — процесс живёт', () => {
    const s = snapshot({
      lastProgressAt: new Map([['a', NOW - 60 * MIN]]),
      killRequestedAt: new Map([['a', NOW - 30 * MIN]]),
      running: new Set(),
    });
    expect(planWatchdogActions(s)).toEqual([]);
  });

  it('kill не помог, и прогон один — изолируем его, процесс не трогаем', () => {
    // Раньше здесь был process.exit(1). Под арендой он унёс бы аренды соседних
    // кампаний, которые в этот момент работают исправно.
    const s = snapshot({
      lastProgressAt: new Map([['a', NOW - 20 * MIN]]),
      killRequestedAt: new Map([['a', NOW - 4 * MIN]]),
      running: new Set(['a']),
    });
    expect(planWatchdogActions(s)).toEqual([{ campaignId: 'a', action: 'quarantine', stallMin: 20 }]);
  });

  it('kill не помог, но есть живые соседи — изолируем одну, процесс живёт', () => {
    /**
     * Ровно 28.08.2026: TG_VBI неубиваема, а ATOL-1 и три другие кампании
     * работают. Роняя процесс, мы чинили одну ценой четырёх.
     */
    const s = snapshot({
      lastProgressAt: new Map([
        ['stuck', NOW - 20 * MIN],
        ['ok', NOW - 1 * MIN],
      ]),
      killRequestedAt: new Map([['stuck', NOW - 4 * MIN]]),
      running: new Set(['stuck', 'ok']),
    });
    expect(planWatchdogActions(s)).toEqual([
      { campaignId: 'stuck', action: 'quarantine', stallMin: 20 },
    ]);
  });

  it('изолированную кампанию больше не трогаем', () => {
    // Иначе сторож жаловался бы на неё каждую минуту до конца жизни процесса.
    const s = snapshot({
      lastProgressAt: new Map([
        ['stuck', NOW - 60 * MIN],
        ['ok', NOW - 1 * MIN],
      ]),
      killRequestedAt: new Map([['stuck', NOW - 40 * MIN]]),
      running: new Set(['stuck', 'ok']),
      quarantined: new Set(['stuck']),
    });
    expect(planWatchdogActions(s)).toEqual([]);
  });

  it('когда изолированы все — всё равно только карантин, без падения процесса', () => {
    const s = snapshot({
      lastProgressAt: new Map([
        ['a', NOW - 60 * MIN],
        ['b', NOW - 20 * MIN],
      ]),
      killRequestedAt: new Map([['b', NOW - 4 * MIN]]),
      running: new Set(['a', 'b']),
      quarantined: new Set(['a']),
    });
    // Первый уже в карантине, второй туда уходит — и на этом всё: ронять
    // процесс нельзя, в нём живут аренды исправных кампаний.
    expect(planWatchdogActions(s)).toEqual([{ campaignId: 'b', action: 'quarantine', stallMin: 20 }]);
  });

  it('изолированная кампания не мешает работать здоровой', () => {
    const s = snapshot({
      lastProgressAt: new Map([
        ['stuck', NOW - 60 * MIN],
        ['ok', NOW - 1 * MIN],
      ]),
      running: new Set(['stuck', 'ok']),
      quarantined: new Set(['stuck']),
    });
    expect(planWatchdogActions(s)).toEqual([]);
  });

  /** Ровно тот случай, ради которого всё затевалось. */
  it('зависла одна из трёх — двум другим ничего не прилетает', () => {
    const s = snapshot({
      lastProgressAt: new Map([
        ['stuck', NOW - 16 * MIN],
        ['alive-1', NOW - 30_000],
        ['alive-2', NOW - MIN],
      ]),
      running: new Set(['stuck', 'alive-1', 'alive-2']),
    });
    expect(planWatchdogActions(s)).toEqual([
      { campaignId: 'stuck', action: 'kill', stallMin: 16 },
    ]);
  });

  it('зависли несколько — каждой своё решение, независимо', () => {
    const s = snapshot({
      lastProgressAt: new Map([
        ['fresh-stall', NOW - 16 * MIN],
        ['hopeless', NOW - 25 * MIN],
      ]),
      killRequestedAt: new Map([['hopeless', NOW - 5 * MIN]]),
      running: new Set(['fresh-stall', 'hopeless']),
    });
    expect(planWatchdogActions(s)).toEqual([
      { campaignId: 'fresh-stall', action: 'kill', stallMin: 16 },
      { campaignId: 'hopeless', action: 'quarantine', stallMin: 25 },
    ]);
  });
});

describe('staleKillRequests', () => {
  it('кампания ожила — отметку о killе снимаем', () => {
    const s = snapshot({
      lastProgressAt: new Map([['a', NOW - 10_000]]),
      killRequestedAt: new Map([['a', NOW - 5 * MIN]]),
      running: new Set(['a']),
    });
    expect(staleKillRequests(s)).toEqual(['a']);
  });

  it('кампания завершилась — отметку тоже снимаем, чтобы не копилась', () => {
    const s = snapshot({
      killRequestedAt: new Map([['a', NOW - 5 * MIN]]),
      running: new Set(),
    });
    expect(staleKillRequests(s)).toEqual(['a']);
  });

  it('всё ещё висит — отметку держим, иначе kill пойдёт по кругу вместо exit', () => {
    const s = snapshot({
      lastProgressAt: new Map([['a', NOW - 20 * MIN]]),
      killRequestedAt: new Map([['a', NOW - 1 * MIN]]),
      running: new Set(['a']),
    });
    expect(staleKillRequests(s)).toEqual([]);
  });
});
