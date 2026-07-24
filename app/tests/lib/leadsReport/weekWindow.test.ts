import {
  currentMskWeekWindow,
  shortMskDate,
} from '@/lib/leadsReport/weekWindow';

describe('currentMskWeekWindow', () => {
  // 14:10 UTC = 17:10 МСК пятница — штатный cron
  const fridayCron = new Date('2026-07-24T14:10:00.000Z');

  it('в пятницу закрывает окно текущей пт 17:15:59.999 МСК → прошлая пт 17:16:00.000 МСК', () => {
    expect(currentMskWeekWindow(fridayCron)).toEqual({
      start: new Date('2026-07-17T14:16:00.000Z'), // = пт 17.07 17:16 МСК
      end: new Date('2026-07-24T14:15:59.999Z'),   // = пт 24.07 17:15:59.999 МСК
    });
  });

  it('в понедельник закрывает окно ПОСЛЕДНЕЙ прошедшей пятницы', () => {
    // 2026-07-20 пн 15:00 UTC = 18:00 МСК пн
    const now = new Date('2026-07-20T15:00:00.000Z');
    expect(currentMskWeekWindow(now)).toEqual({
      start: new Date('2026-07-10T14:16:00.000Z'), // = пт 10.07 17:16 МСК
      end: new Date('2026-07-17T14:15:59.999Z'),   // = пт 17.07 17:15:59.999 МСК
    });
  });

  it('shortMskDate отражает MSK-дату', () => {
    expect(shortMskDate(fridayCron)).toBe('24.07');
  });
});
