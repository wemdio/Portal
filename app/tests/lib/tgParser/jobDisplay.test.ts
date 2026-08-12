/** @jest-environment node */

/**
 * Подписи к задаче парсинга: когда запустили и сколько уже идёт. По ним
 * оператор решает, ждать или вмешиваться, — обход трёх чатов законно идёт до
 * сорока минут, и отличить это от зависания можно только по ним.
 */

import { formatJobStart, formatElapsed } from '@/lib/tgParser/jobDisplay';

const T0 = new Date('2026-08-12T10:19:00.000Z').getTime();

describe('formatJobStart', () => {
  it('показывает дату и время: в списке лежат задачи за несколько дней', () => {
    // Часовой пояс раннера не фиксирован, поэтому проверяем форму, а не цифры.
    expect(formatJobStart(T0)).toMatch(/^\d{2}\.\d{2}, \d{2}:\d{2}$/);
  });

  it('мусорная метка не рисует «Invalid Date»', () => {
    expect(formatJobStart(NaN)).toBe('');
  });
});

describe('formatElapsed', () => {
  it('первые секунды — «меньше минуты», а не «0 мин»', () => {
    expect(formatElapsed(T0, T0)).toBe('меньше минуты');
    expect(formatElapsed(T0, T0 + 59_000)).toBe('меньше минуты');
  });

  it('минуты', () => {
    expect(formatElapsed(T0, T0 + 60_000)).toBe('1 мин');
    expect(formatElapsed(T0, T0 + 35 * 60_000)).toBe('35 мин');
    expect(formatElapsed(T0, T0 + 59 * 60_000)).toBe('59 мин');
  });

  it('часы', () => {
    expect(formatElapsed(T0, T0 + 60 * 60_000)).toBe('1 ч');
    expect(formatElapsed(T0, T0 + 65 * 60_000)).toBe('1 ч 5 мин');
    expect(formatElapsed(T0, T0 + 150 * 60_000)).toBe('2 ч 30 мин');
  });

  /** Часы клиента могут отставать от сервера — «-3 мин» выглядело бы поломкой. */
  it('отрицательную разницу не показывает', () => {
    expect(formatElapsed(T0, T0 - 120_000)).toBe('меньше минуты');
  });

  it('мусорные метки не ломают подпись', () => {
    expect(formatElapsed(NaN, T0)).toBe('');
    expect(formatElapsed(T0, NaN)).toBe('');
  });
});
