/** @jest-environment node */

/**
 * Файл готовит человек в таблице, поэтому в нём бывает всё: заголовок и без
 * заголовка, лишние колонки из выгрузки скрапера, пустые ячейки, один и тот же
 * человек дважды. Разбор обязан не падать и честно рассказать, что он выкинул,
 * — оператор увидит это до сохранения.
 */

import { parseBaseRows } from '@/lib/tgOutreach/firstTouch/parseBaseFile';

describe('parseBaseRows', () => {
  it('берёт первую колонку как юзернейм, вторую как сообщение', () => {
    const r = parseBaseRows([
      ['@ivanov', 'Иван, добрый день! Вопрос по outreach.'],
      ['@petrov', 'Пётр, добрый день! Вопрос по outreach.'],
    ]);
    expect(r.contacts).toEqual([
      { username: 'ivanov', message: 'Иван, добрый день! Вопрос по outreach.', raw: {} },
      { username: 'petrov', message: 'Пётр, добрый день! Вопрос по outreach.', raw: {} },
    ]);
    expect(r.stats).toMatchObject({ total: 2, accepted: 2, noUsername: 0, noMessage: 0, duplicates: 0 });
  });

  it('пропускает строку заголовка', () => {
    const r = parseBaseRows([
      ['Юзернейм Telegram', 'Персонализированное сообщение'],
      ['@ivanov', 'Иван, добрый день!'],
    ]);
    expect(r.contacts).toHaveLength(1);
    expect(r.contacts[0].username).toBe('ivanov');
    expect(r.stats.total).toBe(1);
  });

  it('лишние колонки сохраняет в raw, а не выбрасывает', () => {
    const r = parseBaseRows([
      ['Username', 'Сообщение', 'Биография', 'Источник'],
      ['@ivanov', 'Иван, привет!', 'CTO в стартапе', 'Чат MOST'],
    ]);
    expect(r.contacts[0].raw).toEqual({ 'Биография': 'CTO в стартапе', 'Источник': 'Чат MOST' });
  });

  it('строки без юзернейма и без текста не проходят, но попадают в статистику', () => {
    const r = parseBaseRows([
      ['@ivanov', 'Иван, привет!'],
      ['+79001234567', 'Телефон вместо юзернейма'],
      ['@petrov', '   '],
      ['', ''],
    ]);
    expect(r.contacts).toHaveLength(1);
    expect(r.stats).toMatchObject({ total: 4, accepted: 1, noUsername: 2, noMessage: 1 });
  });

  it('дубль внутри файла берётся один раз — первым', () => {
    const r = parseBaseRows([
      ['@ivanov', 'первое'],
      ['@Ivanov', 'второе'],
      ['https://t.me/ivanov', 'третье'],
    ]);
    expect(r.contacts).toHaveLength(1);
    expect(r.contacts[0].message).toBe('первое');
    expect(r.stats.duplicates).toBe(2);
  });

  it('пустой файл — пустой результат, без исключения', () => {
    expect(parseBaseRows([]).contacts).toEqual([]);
    expect(parseBaseRows([]).stats.total).toBe(0);
  });

  it('обрезает пробелы по краям сообщения, внутри не трогает', () => {
    const r = parseBaseRows([['@ivanov', '  Иван,  добрый  день!  ']]);
    expect(r.contacts[0].message).toBe('Иван,  добрый  день!');
  });
});
