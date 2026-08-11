/** @jest-environment node */

/**
 * Разбор списка поисковых запросов.
 *
 * Реальный случай, с которого всё началось: булев запрос был написан в четыре
 * строки, старое `split(/[\n,]+/)` разрезало его на четыре обрывка, и последним
 * ушло `-site:ozon.ru …` — одни исключения без единого слова для поиска. Парсер
 * честно вернул ноль, а человек не понял, почему.
 */

import {
  findBrokenSearchQueries,
  hasPositiveTerms,
  splitSearchQueries,
} from '@/lib/parsers/searchQueryList';

describe('splitSearchQueries', () => {
  it('обычный список — по запросу на строку', () => {
    expect(splitSearchQueries('купить палатку\nтуристические печи\n\nмангалы')).toEqual([
      'купить палатку',
      'туристические печи',
      'мангалы',
    ]);
  });

  it('запятая тоже разделяет', () => {
    expect(splitSearchQueries('палатки, печи, мангалы')).toEqual(['палатки', 'печи', 'мангалы']);
  });

  it('запятая внутри кавычек фразу не разрывает', () => {
    expect(splitSearchQueries('"товары для дома, дачи и сада"')).toEqual([
      '"товары для дома, дачи и сада"',
    ]);
  });

  it('незакрытая скобка склеивает строку со следующей', () => {
    const text = 'site:.ru ("товары для кемпинга" OR "туристические печи"\nOR "мангалы")\nдругой запрос';
    expect(splitSearchQueries(text)).toEqual([
      'site:.ru ("товары для кемпинга" OR "туристические печи" OR "мангалы")',
      'другой запрос',
    ]);
  });

  it('незакрытая кавычка тоже склеивает', () => {
    expect(splitSearchQueries('"длинная фраза\nс переносом"')).toEqual(['"длинная фраза с переносом"']);
  });
});

describe('findBrokenSearchQueries', () => {
  it('запрос из одних исключений не найдёт ничего и должен быть отвергнут', () => {
    const issues = findBrokenSearchQueries([
      '-site:ozon.ru -site:wildberries.ru -site:market.yandex.ru',
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].reason).toContain('только исключения');
  });

  it('исключения рядом с обычными словами — нормальный запрос', () => {
    expect(findBrokenSearchQueries(['купить палатку -site:ozon.ru'])).toEqual([]);
  });

  it('скобочная группа со словами — нормальный запрос', () => {
    expect(findBrokenSearchQueries(['("купить" OR "интернет-магазин")'])).toEqual([]);
  });

  it('непарные кавычки — это обрывок', () => {
    const issues = findBrokenSearchQueries(['"товары для кемпинга']);
    expect(issues[0].reason).toContain('кавычки');
  });
});

describe('hasPositiveTerms', () => {
  it.each([
    ['-site:ozon.ru', false],
    ['-"плохая фраза"', false],
    ['OR AND', false],
    ['() ""', false],
    ['палатки', true],
    ['site:.ru палатки', true],
  ])('%s → %s', (query, expected) => {
    expect(hasPositiveTerms(query)).toBe(expected);
  });
});
