import {
  currentMskWeekWindow,
  shortMskDate,
} from '@/lib/leadsReport/weekWindow';

describe('currentMskWeekWindow', () => {
  it('окно = последние 7 суток до момента запуска (штатный cron пт 17:00 МСК → неделя пт-пт)', () => {
    // 14:00 UTC = 17:00 МСК пятница
    const now = new Date('2026-07-24T14:00:00.000Z');
    expect(currentMskWeekWindow(now)).toEqual({
      start: new Date('2026-07-17T14:00:00.000Z'),
      end: now,
    });
    expect(shortMskDate(now)).toBe('24.07');
  });
});
