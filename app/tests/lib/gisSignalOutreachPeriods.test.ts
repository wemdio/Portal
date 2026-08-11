/** @jest-environment node */

/**
 * Периоды/недели отчётности gis-signals (Europe/Moscow).
 * Календарные границы считаются по Москве, в БД уходят точные UTC-моменты;
 * дельты — к предыдущему равному интервалу (у 'all' дельт нет).
 */

import {
  resolveGisReportPeriod,
  previousGisPeriodRange,
  resolveGisWeek,
  moscowCalendarDate,
  GisReportPeriodError,
} from '@/lib/gisSignalOutreach/periods';

// Среда 2026-08-12 18:00 МСК.
const NOW = new Date('2026-08-12T15:00:00.000Z');

describe('resolveGisReportPeriod', () => {
  it('7d (дефолт): последние 7 календарных дней по Москве, границы в UTC', () => {
    const p = resolveGisReportPeriod({ preset: '7d' }, NOW);
    expect(p).toEqual({
      preset: '7d',
      from: '2026-08-06',
      to: '2026-08-12',
      fromUtc: new Date('2026-08-05T21:00:00.000Z'),
      toExclusiveUtc: new Date('2026-08-12T21:00:00.000Z'),
      days: 7,
    });
  });

  it('preset по умолчанию — 7d', () => {
    const p = resolveGisReportPeriod({}, NOW);
    expect(p.preset).toBe('7d');
    expect(p.days).toBe(7);
  });

  it('30d: from = today − 29', () => {
    const p = resolveGisReportPeriod({ preset: '30d' }, NOW);
    expect(p.from).toBe('2026-07-14');
    expect(p.to).toBe('2026-08-12');
    expect(p.days).toBe(30);
    expect(p.fromUtc?.toISOString()).toBe('2026-07-13T21:00:00.000Z');
  });

  it('all: без границ, дельт нет (days=null)', () => {
    const p = resolveGisReportPeriod({ preset: 'all' }, NOW);
    expect(p).toEqual({
      preset: 'all',
      from: null,
      to: null,
      fromUtc: null,
      toExclusiveUtc: null,
      days: null,
    });
  });

  it('custom: свои даты, days = inclusive span', () => {
    const p = resolveGisReportPeriod(
      { preset: 'custom', from: '2026-08-01', to: '2026-08-10' },
      NOW,
    );
    expect(p.days).toBe(10);
    expect(p.fromUtc?.toISOString()).toBe('2026-07-31T21:00:00.000Z');
    expect(p.toExclusiveUtc?.toISOString()).toBe('2026-08-10T21:00:00.000Z');
  });

  it('custom: ошибки валидации — не молчим и не расширяем до all', () => {
    expect(() => resolveGisReportPeriod({ preset: 'custom', from: '2026-08-10', to: '2026-08-01' }, NOW))
      .toThrow(GisReportPeriodError);
    expect(() => resolveGisReportPeriod({ preset: 'custom', from: '01.08.2026', to: '2026-08-10' }, NOW))
      .toThrow(GisReportPeriodError);
    expect(() => resolveGisReportPeriod({ preset: 'custom', from: '2026-02-30', to: '2026-08-10' }, NOW))
      .toThrow(GisReportPeriodError);
    expect(() => resolveGisReportPeriod({ preset: 'custom', from: '2026-08-01' }, NOW))
      .toThrow(GisReportPeriodError);
    expect(() => resolveGisReportPeriod({ preset: 'custom', from: '2025-01-01', to: '2026-08-12' }, NOW))
      .toThrow(/366/);
  });

  it('невалидный preset → throw', () => {
    expect(() => resolveGisReportPeriod({ preset: 'year' }, NOW)).toThrow(GisReportPeriodError);
  });

  it('полуночные границы переходят через полночь UTC по-московски', () => {
    // 00:30 МСК = 21:30 UTC предыдущего дня: «сегодня» уже наступило.
    const justAfterMidnightMsk = new Date('2026-08-11T21:30:00.000Z');
    expect(moscowCalendarDate(justAfterMidnightMsk)).toBe('2026-08-12');
    const p = resolveGisReportPeriod({ preset: '7d' }, justAfterMidnightMsk);
    expect(p.to).toBe('2026-08-12');
  });
});

describe('previousGisPeriodRange', () => {
  it('равный интервал непосредственно перед периодом', () => {
    const p = resolveGisReportPeriod({ preset: '7d' }, NOW);
    expect(previousGisPeriodRange(p)).toEqual({
      fromUtc: new Date('2026-07-29T21:00:00.000Z'),
      toExclusiveUtc: new Date('2026-08-05T21:00:00.000Z'),
    });
  });

  it('custom: предыдущие N дней той же длины', () => {
    const p = resolveGisReportPeriod({ preset: 'custom', from: '2026-08-06', to: '2026-08-12' }, NOW);
    expect(previousGisPeriodRange(p)).toEqual({
      fromUtc: new Date('2026-07-29T21:00:00.000Z'),
      toExclusiveUtc: new Date('2026-08-05T21:00:00.000Z'),
    });
  });

  it('all → null (дельт нет)', () => {
    const p = resolveGisReportPeriod({ preset: 'all' }, NOW);
    expect(previousGisPeriodRange(p)).toBeNull();
  });
});

describe('resolveGisWeek', () => {
  it('эта неделя: пн 00:00 – вс 23:59 МСК, границы в UTC', () => {
    const w = resolveGisWeek('current', NOW);
    expect(w).toEqual({
      weekId: 'current',
      weekStart: '2026-08-10',
      weekEnd: '2026-08-16',
      fromUtc: new Date('2026-08-09T21:00:00.000Z'),
      toExclusiveUtc: new Date('2026-08-16T21:00:00.000Z'),
      prevFromUtc: new Date('2026-08-02T21:00:00.000Z'),
      prevToExclusiveUtc: new Date('2026-08-09T21:00:00.000Z'),
    });
  });

  it('прошлая неделя — сдвиг на 7 дней, prev-поля — позапрошлая', () => {
    const w = resolveGisWeek('previous', NOW);
    expect(w.weekStart).toBe('2026-08-03');
    expect(w.weekEnd).toBe('2026-08-09');
    expect(w.fromUtc.toISOString()).toBe('2026-08-02T21:00:00.000Z');
    expect(w.toExclusiveUtc.toISOString()).toBe('2026-08-09T21:00:00.000Z');
    expect(w.prevFromUtc.toISOString()).toBe('2026-07-26T21:00:00.000Z');
    expect(w.prevToExclusiveUtc.toISOString()).toBe('2026-08-02T21:00:00.000Z');
  });

  it('week по умолчанию — current', () => {
    expect(resolveGisWeek(undefined, NOW).weekId).toBe('current');
  });

  it('понедельник 00:30 МСК — уже новая неделя', () => {
    const mondayEarlyUtc = new Date('2026-08-09T21:30:00.000Z'); // пн 00:30 МСК
    const w = resolveGisWeek('current', mondayEarlyUtc);
    expect(w.weekStart).toBe('2026-08-10');
  });

  it('воскресенье 23:59 МСК — ещё старая неделя', () => {
    const sundayLateUtc = new Date('2026-08-09T20:59:59.000Z'); // вс 23:59:59 МСК
    const w = resolveGisWeek('current', sundayLateUtc);
    expect(w.weekStart).toBe('2026-08-03');
    expect(w.weekEnd).toBe('2026-08-09');
  });

  it('невалидный week → throw', () => {
    expect(() => resolveGisWeek('last', NOW)).toThrow(GisReportPeriodError);
  });
});
