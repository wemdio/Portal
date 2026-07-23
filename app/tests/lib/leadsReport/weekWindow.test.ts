import {
  currentMskWeekWindow,
  shortMskDate,
} from '@/lib/leadsReport/weekWindow';

describe('currentMskWeekWindow', () => {
  it('строит окно с понедельника 00:00 МСК до пятницы 18:00 МСК', () => {
    const now = new Date('2026-07-24T15:00:00.000Z');
    expect(currentMskWeekWindow(now)).toEqual({
      start: new Date('2026-07-19T21:00:00.000Z'),
      end: now,
    });
    expect(shortMskDate(now)).toBe('24.07');
  });
});
