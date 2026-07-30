/** @jest-environment node */

import { parseRange, previousRange, bucketKey } from '@/lib/expenses/period';

describe('parseRange', () => {
  it('принимает корректный диапазон', () => {
    expect(parseRange('2026-07-01', '2026-07-31')).toEqual({ from: '2026-07-01', to: '2026-07-31' });
  });

  it('отвергает перевёрнутый диапазон', () => {
    expect(() => parseRange('2026-07-31', '2026-07-01')).toThrow();
  });

  it('отвергает мусор вместо даты', () => {
    expect(() => parseRange('вчера', '2026-07-01')).toThrow();
  });
});

describe('previousRange', () => {
  it('июль отдаёт предыдущий 31 день, вплотную до 1 июля', () => {
    expect(previousRange('2026-07-01', '2026-07-31')).toEqual({ from: '2026-05-31', to: '2026-06-30' });
  });

  it('один день отдаёт предыдущий день', () => {
    expect(previousRange('2026-07-15', '2026-07-15')).toEqual({ from: '2026-07-14', to: '2026-07-14' });
  });
});

describe('bucketKey', () => {
  it('день — сама дата', () => {
    expect(bucketKey('2026-07-15', 'day')).toBe('2026-07-15');
  });

  it('неделя — понедельник этой недели', () => {
    // 15 июля 2026 — среда.
    expect(bucketKey('2026-07-15', 'week')).toBe('2026-07-13');
  });

  it('неделя не уезжает через границу месяца', () => {
    // 1 августа 2026 — суббота, её неделя начинается 27 июля.
    expect(bucketKey('2026-08-01', 'week')).toBe('2026-07-27');
  });

  it('месяц — первое число', () => {
    expect(bucketKey('2026-07-15', 'month')).toBe('2026-07-01');
  });
});
