import { parseHypotheses } from '@/lib/projectBriefHypotheses/parseHypotheses';

describe('parseHypotheses', () => {
  it('parses single hypothesis block', () => {
    const md = `### Гипотеза 1: Крупный ритейл
- Источник: Реестровые базы (Руспрофайл, Селеком, Сбис)
- Ожидаемый объём: 1500–2500 компаний`;

    expect(parseHypotheses(md)).toEqual([
      {
        number: '1',
        title: 'Крупный ритейл',
        fields: [
          { label: 'Источник', value: 'Реестровые базы (Руспрофайл, Селеком, Сбис)' },
          { label: 'Ожидаемый объём', value: '1500–2500 компаний' },
        ],
      },
    ]);
  });

  it('parses multiple hypotheses split by ###', () => {
    const md = `### Гипотеза 1: A
- Источник: HH

### Гипотеза 2: B
- Источник: Карты`;

    const result = parseHypotheses(md);
    expect(result).toHaveLength(2);
    expect(result[0].number).toBe('1');
    expect(result[0].title).toBe('A');
    expect(result[1].number).toBe('2');
    expect(result[1].title).toBe('B');
  });

  it('joins continuation lines into the previous field value', () => {
    const md = `### Гипотеза 1: Foo
- Конкретные фильтры/запросы: первая строка,
  вторая строка с https://example.com продолжение`;

    expect(parseHypotheses(md)[0].fields).toEqual([
      {
        label: 'Конкретные фильтры/запросы',
        value: 'первая строка, вторая строка с https://example.com продолжение',
      },
    ]);
  });

  it('strips bold markdown around labels (**Источник:**)', () => {
    const md = `### Гипотеза 1: Foo
- **Источник:** HH`;

    expect(parseHypotheses(md)[0].fields).toEqual([
      { label: 'Источник', value: 'HH' },
    ]);
  });

  it('returns empty array on empty / whitespace input', () => {
    expect(parseHypotheses('')).toEqual([]);
    expect(parseHypotheses('   \n  ')).toEqual([]);
  });

  it('falls back to plain title without "Гипотеза N:" prefix', () => {
    const md = `### Простой заголовок
- Источник: X`;

    const blocks = parseHypotheses(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].number).toBe('');
    expect(blocks[0].title).toBe('Простой заголовок');
  });

  it('survives output without ### headings (single block)', () => {
    const md = `Просто текст без структуры
- Источник: HH
- Ожидаемый объём: 100`;

    const blocks = parseHypotheses(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].title).toBe('Просто текст без структуры');
    expect(blocks[0].fields).toEqual([
      { label: 'Источник', value: 'HH' },
      { label: 'Ожидаемый объём', value: '100' },
    ]);
  });

  it('keeps an unlabeled bullet as a fields entry with empty label', () => {
    const md = `### Гипотеза 1: T
- Просто буллет без двоеточия`;

    expect(parseHypotheses(md)[0].fields).toEqual([
      { label: '', value: 'Просто буллет без двоеточия' },
    ]);
  });
});
