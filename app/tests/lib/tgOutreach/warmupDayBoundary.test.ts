/** @jest-environment node */

/**
 * Граница суток прогрева.
 *
 * Раньше день отсчитывался ровно 24 часа от нажатия кнопки: запустили в 20:20 —
 * день менялся в 20:20, посреди вечера, и граница ползала по суткам вместе со
 * временем запуска. Теперь день начинается в 8 утра по времени кампании.
 */

import { dayNumber, planningWindow } from '@/lib/tgOutreach/warmup/loop';

const MSK = 3;
/** 04.08.2026, 20:20 по Москве — как реально запустили ATOL-1. */
const STARTED = '2026-08-04T17:20:44.000Z';
const run = { started_at: STARTED, days: 4 };

/** Момент по московскому времени в UTC. */
const msk = (iso: string) => new Date(new Date(`${iso}+03:00`).toISOString());

describe('dayNumber', () => {
  it('вечер запуска — день 1', () => {
    expect(dayNumber(run, msk('2026-08-04T20:21:00'), MSK)).toBe(1);
    expect(dayNumber(run, msk('2026-08-04T23:59:00'), MSK)).toBe(1);
  });

  it('ночь после запуска — всё ещё день 1, граница не в полночь', () => {
    expect(dayNumber(run, msk('2026-08-05T00:01:00'), MSK)).toBe(1);
    expect(dayNumber(run, msk('2026-08-05T07:59:00'), MSK)).toBe(1);
  });

  it('в 8 утра наступает день 2', () => {
    expect(dayNumber(run, msk('2026-08-05T08:00:00'), MSK)).toBe(2);
    expect(dayNumber(run, msk('2026-08-05T20:20:00'), MSK)).toBe(2);
  });

  it('дальше по одному дню на каждое утро', () => {
    expect(dayNumber(run, msk('2026-08-06T08:00:00'), MSK)).toBe(3);
    expect(dayNumber(run, msk('2026-08-07T08:00:00'), MSK)).toBe(4);
    expect(dayNumber(run, msk('2026-08-08T08:00:00'), MSK)).toBe(5);
  });

  /** Утренний запуск: первый день полный, а не обрезанный. */
  it('запуск в 9 утра — день 2 наступает следующим утром', () => {
    const morning = { started_at: msk('2026-08-04T09:00:00').toISOString(), days: 4 };
    expect(dayNumber(morning, msk('2026-08-04T23:00:00'), MSK)).toBe(1);
    expect(dayNumber(morning, msk('2026-08-05T07:59:00'), MSK)).toBe(1);
    expect(dayNumber(morning, msk('2026-08-05T08:00:00'), MSK)).toBe(2);
  });

  it('без started_at — день 1, а не отрицательный', () => {
    expect(dayNumber({ started_at: null, days: 4 }, msk('2026-08-09T12:00:00'), MSK)).toBe(1);
  });
});

describe('planningWindow', () => {
  const tg = { sleep_periods: ['00:00-08:00'], timezone_offset: MSK };

  it('планируем до начала окна — окно берётся целиком', () => {
    const w = planningWindow(msk('2026-08-05T06:00:00'), tg);
    expect(w.start.toISOString()).toBe(msk('2026-08-05T08:00:00').toISOString());
  });

  /**
   * Главное: воркер перезапустился днём, прогрев только сейчас дошёл до нового
   * дня. Если раскидать переписки по всему окну с 8 утра, прошедшие времена
   * окажутся просроченными и всё уедет одной пачкой.
   */
  it('планируем в середине дня — старт окна сдвигается на сейчас', () => {
    const now = msk('2026-08-05T14:30:00');
    const w = planningWindow(now, tg);
    expect(w.start.toISOString()).toBe(now.toISOString());
    expect(w.end.getTime()).toBeGreaterThan(now.getTime());
  });

  it('планируем после конца окна — окно не выворачивается наизнанку', () => {
    const w = planningWindow(msk('2026-08-05T23:30:00'), tg);
    expect(w.end.getTime()).toBeGreaterThan(w.start.getTime());
  });
});
