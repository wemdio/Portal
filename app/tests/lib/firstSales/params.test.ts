/** @jest-environment node */
import { parseFirstSalesParams, previousWindow } from '@/lib/firstSales/params';

const url = (qs: string) => new URL(`https://x.test/api?${qs}`);

describe('parseFirstSalesParams', () => {
  it('разбирает корректные параметры', () => {
    const p = parseFirstSalesParams(url('from=2026-07-01&to=2026-07-31&groupBy=week&source=11382049&source=none'));
    expect(p.error).toBeNull();
    expect(p.value?.groupBy).toBe('week');
    expect(p.value?.sources).toEqual(['11382049', 'none']);
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

  // Проверка «значение из справочника» умерла вместе со справочником: список
  // источников ведут продажи в AMO, и портал не вправе назвать чужое значение
  // недопустимым. Незнакомый источник — законный ввод, он просто ничего не
  // найдёт.
  it('незнакомый источник принимается как есть', () => {
    const p = parseFirstSalesParams(url('from=2026-07-01&to=2026-07-31&source=нечто'));
    expect(p.error).toBeNull();
    expect(p.value?.sources).toEqual(['нечто']);
  });

  it('слишком длинный список источников отвергается', () => {
    const many = Array.from({ length: 101 }, (_, i) => `source=${i}`).join('&');
    expect(parseFirstSalesParams(url(`from=2026-07-01&to=2026-07-31&${many}`)).error)
      .toMatch(/источник/i);
  });

  it('без параметра source фильтра нет', () => {
    expect(parseFirstSalesParams(url('from=2026-07-01&to=2026-07-31')).value?.sources).toBeNull();
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
    expect(prev.to.toISOString()).toBe('2026-06-30T23:59:59.999Z');
    expect(prev.from.toISOString()).toBe('2026-05-31T23:59:59.999Z');
  });

  it('работает на окне в один день', () => {
    const from = new Date('2026-07-15T00:00:00.000Z');
    const to = new Date('2026-07-15T23:59:59.999Z');
    const prev = previousWindow(from, to);
    expect(prev.to.toISOString()).toBe('2026-07-14T23:59:59.999Z');
    expect(prev.from.toISOString()).toBe('2026-07-14T00:00:00.000Z');
  });

  it('окна не пересекаются и равны по длине', () => {
    // Проверка попадания в окно включает обе границы, поэтому общая точка
    // означала бы двойной счёт сделки, случившейся ровно в полночь по Москве.
    const from = new Date('2026-07-01T00:00:00.000Z');
    const to = new Date('2026-07-31T20:59:59.999Z');
    const prev = previousWindow(from, to);
    expect(prev.to.getTime()).toBeLessThan(from.getTime());
    expect(prev.to.getTime() - prev.from.getTime()).toBe(to.getTime() - from.getTime());
  });
});
