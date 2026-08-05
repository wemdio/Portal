/** @jest-environment node */

/**
 * Сторожевой таймер: лечим точечно, роняем процесс только как последнее средство.
 *
 * Инцидент 05.08.2026: одна зависшая кампания = `process.exit(1)` = падение всех
 * остальных вместе с прогревом, 14 раз за ночь. Тесты фиксируют новое поведение
 * и, главное, границу — когда падение процесса всё же остаётся правильным.
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

  it('kill не помог за отведённое время — роняем процесс', () => {
    const s = snapshot({
      lastProgressAt: new Map([['a', NOW - 20 * MIN]]),
      killRequestedAt: new Map([['a', NOW - 4 * MIN]]),
      running: new Set(['a']),
    });
    expect(planWatchdogActions(s)).toEqual([{ campaignId: 'a', action: 'exit', stallMin: 20 }]);
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
      { campaignId: 'hopeless', action: 'exit', stallMin: 25 },
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
