/** @jest-environment node */
import { parseFirstSalesParams, previousWindow } from '@/lib/firstSales/params';

const url = (qs: string) => new URL(`https://x.test/api?${qs}`);

describe('parseFirstSalesParams', () => {
  it('разбирает корректные параметры', () => {
    const p = parseFirstSalesParams(url('from=2026-07-01&to=2026-07-31&groupBy=week&channel=outreach&channel=smm'));
    expect(p.error).toBeNull();
    expect(p.value?.groupBy).toBe('week');
    expect(p.value?.channels).toEqual(['outreach', 'smm']);
    expect(p.value?.from.toISOString()).toBe('2026-06-30T21:00:00.000Z'); // 1 июля 00:00 МСК
  });

  it('конец периода включает весь последний день по МСК', () => {
    const p = parseFirstSalesParams(url('from=2026-07-01&to=2026-07-31'));
    expect(p.value?.to.toISOString()).toBe('2026-07-31T20:59:59.999Z'); // 31 июля 23:59:59.999 МСК
  });

  it('groupBy по умолчанию — day', () => {
    expect(parseFirstSalesParams(url('from=2026-07-01&to=2026-07-31')).value?.groupBy).toBe('day');
  });

  it('неизвестный groupBy отвергается', () => {
    expect(parseFirstSalesParams(url('from=2026-07-01&to=2026-07-31&groupBy=hour')).error)
      .toMatch(/groupBy/);
  });

  it('неизвестный канал отвергается', () => {
    expect(parseFirstSalesParams(url('from=2026-07-01&to=2026-07-31&channel=нечто')).error)
      .toMatch(/channel/);
  });

  it('отсутствие дат отвергается', () => {
    expect(parseFirstSalesParams(url('groupBy=day')).error).toMatch(/from/);
  });

  it('конец раньше начала отвергается', () => {
    expect(parseFirstSalesParams(url('from=2026-07-31&to=2026-07-01')).error).toMatch(/раньше/);
  });

  it('слишком длинный период отвергается', () => {
    expect(parseFirstSalesParams(url('from=2020-01-01&to=2026-07-01')).error).toMatch(/период/i);
  });
});

describe('previousWindow', () => {
  it('сдвигает окно назад ровно на его длину', () => {
    const from = new Date('2026-07-01T00:00:00.000Z');
    const to = new Date('2026-07-31T00:00:00.000Z');
    const prev = previousWindow(from, to);
    expect(prev.to.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(prev.from.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('работает на окне в один день', () => {
    const from = new Date('2026-07-15T00:00:00.000Z');
    const to = new Date('2026-07-15T23:59:59.999Z');
    const prev = previousWindow(from, to);
    expect(prev.from.toISOString()).toBe('2026-07-14T00:00:00.001Z');
    expect(prev.to.toISOString()).toBe('2026-07-15T00:00:00.000Z');
  });
});
