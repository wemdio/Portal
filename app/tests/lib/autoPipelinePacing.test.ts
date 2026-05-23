import { describe, expect, test } from '@jest/globals';
import {
  calcPacing,
  isInsideWindow,
  msUntilNextUtcHour,
} from '@/lib/jobs/autoPipelinePacing';

describe('isInsideWindow', () => {
  test('window not crossing midnight: [2..6] UTC', () => {
    expect(isInsideWindow({ startHourUtc: 2, endHourUtc: 6 }, new Date('2026-05-22T01:30:00Z'))).toBe(false);
    expect(isInsideWindow({ startHourUtc: 2, endHourUtc: 6 }, new Date('2026-05-22T02:00:00Z'))).toBe(true);
    expect(isInsideWindow({ startHourUtc: 2, endHourUtc: 6 }, new Date('2026-05-22T05:59:00Z'))).toBe(true);
    expect(isInsideWindow({ startHourUtc: 2, endHourUtc: 6 }, new Date('2026-05-22T06:00:00Z'))).toBe(false);
  });

  test('window crossing midnight: [21..3] UTC (00-06 МСК)', () => {
    expect(isInsideWindow({ startHourUtc: 21, endHourUtc: 3 }, new Date('2026-05-22T20:30:00Z'))).toBe(false);
    expect(isInsideWindow({ startHourUtc: 21, endHourUtc: 3 }, new Date('2026-05-22T21:00:00Z'))).toBe(true);
    expect(isInsideWindow({ startHourUtc: 21, endHourUtc: 3 }, new Date('2026-05-22T23:59:00Z'))).toBe(true);
    expect(isInsideWindow({ startHourUtc: 21, endHourUtc: 3 }, new Date('2026-05-23T00:30:00Z'))).toBe(true);
    expect(isInsideWindow({ startHourUtc: 21, endHourUtc: 3 }, new Date('2026-05-23T02:59:00Z'))).toBe(true);
    expect(isInsideWindow({ startHourUtc: 21, endHourUtc: 3 }, new Date('2026-05-23T03:00:00Z'))).toBe(false);
  });

  test('degenerate window (start == end) treated as empty', () => {
    expect(isInsideWindow({ startHourUtc: 5, endHourUtc: 5 }, new Date('2026-05-22T05:00:00Z'))).toBe(false);
  });
});

describe('msUntilNextUtcHour', () => {
  test('same-day target later than now', () => {
    const now = new Date('2026-05-22T01:00:00Z');
    expect(msUntilNextUtcHour(3, now)).toBe(2 * 3600_000);
  });

  test('target already passed → tomorrow', () => {
    const now = new Date('2026-05-22T04:00:00Z');
    expect(msUntilNextUtcHour(3, now)).toBe(23 * 3600_000);
  });

  test('target == current hour at :00 → tomorrow (already passed)', () => {
    const now = new Date('2026-05-22T03:00:00Z');
    expect(msUntilNextUtcHour(3, now)).toBe(24 * 3600_000);
  });
});

describe('calcPacing — burst mode', () => {
  test('always inWindow=true, perItemPauseMs=0', () => {
    const d = calcPacing({
      pacing: 'burst',
      window: { startHourUtc: 21, endHourUtc: 3 },
      itemCount: 8000,
      concurrency: 5,
      now: new Date('2026-05-22T13:00:00Z'),
    });
    expect(d.inWindow).toBe(true);
    expect(d.perItemPauseMs).toBe(0);
    expect(d.windowEndsAt).toBeNull();
  });
});

describe('calcPacing — nightly mode', () => {
  test('outside window → inWindow=false, parsing skipped', () => {
    const d = calcPacing({
      pacing: 'nightly',
      window: { startHourUtc: 21, endHourUtc: 3 },
      itemCount: 8000,
      concurrency: 5,
      now: new Date('2026-05-22T13:00:00Z'), // полдень UTC, вне окна 21-03
    });
    expect(d.inWindow).toBe(false);
    expect(d.perItemPauseMs).toBe(0);
  });

  test('inside window at start → ровно растянуто на 6 часов', () => {
    const d = calcPacing({
      pacing: 'nightly',
      window: { startHourUtc: 21, endHourUtc: 3 },
      itemCount: 8000,
      concurrency: 5,
      now: new Date('2026-05-22T21:00:00Z'), // самое начало окна
      safetyMarginMs: 60_000,
    });
    expect(d.inWindow).toBe(true);
    expect(d.windowEndsAt).toBe('2026-05-23T03:00:00.000Z');
    // 6h - 1min safety = 21540000ms, * 5 workers / 8000 items = 13462ms - 3000ms avg = ~10462ms
    expect(d.perItemPauseMs).toBeGreaterThan(10_000);
    expect(d.perItemPauseMs).toBeLessThan(11_000);
  });

  test('inside window halfway → пауза в 2 раза меньше', () => {
    const d = calcPacing({
      pacing: 'nightly',
      window: { startHourUtc: 21, endHourUtc: 3 },
      itemCount: 8000,
      concurrency: 5,
      now: new Date('2026-05-23T00:00:00Z'), // середина окна (осталось 3h)
    });
    expect(d.inWindow).toBe(true);
    // 3h - 1min = 10740000ms * 5 / 8000 = 6712ms - 3000 = ~3712ms
    expect(d.perItemPauseMs).toBeGreaterThan(3_500);
    expect(d.perItemPauseMs).toBeLessThan(4_000);
  });

  test('inside window but only seconds left → perItemPauseMs = 0 (best-effort)', () => {
    const d = calcPacing({
      pacing: 'nightly',
      window: { startHourUtc: 21, endHourUtc: 3 },
      itemCount: 8000,
      concurrency: 5,
      now: new Date('2026-05-23T02:59:30Z'), // 30 сек до конца + safety 60s
    });
    expect(d.inWindow).toBe(true);
    expect(d.perItemPauseMs).toBe(0);
  });

  test('itemCount=0 → perItemPauseMs=0 безопасно', () => {
    const d = calcPacing({
      pacing: 'nightly',
      window: { startHourUtc: 21, endHourUtc: 3 },
      itemCount: 0,
      concurrency: 5,
      now: new Date('2026-05-22T21:00:00Z'),
    });
    expect(d.inWindow).toBe(true);
    expect(d.perItemPauseMs).toBe(0);
  });
});
