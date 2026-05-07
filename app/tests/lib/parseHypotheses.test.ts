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

  /**
   * Regression (May 2026): the model started nesting bullets like:
   *
   *     - Конкретные фильтры/запросы:
   *       - ОКВЭД (основной или дополнительный): 46 (Оптовая торговля)
   *       - Регион: Москва
   *
   * Earlier the parser stripped indentation BEFORE the bullet check, so each
   * sub-bullet became a sibling top-level field with empty label/value pollution.
   * Sub-bullets must be appended to the value of the current field (joined by
   * ' • ' so multi-line bullets render readably as a list).
   */
  describe('nested sub-bullets (May 2026 regression)', () => {
    it('attaches single-level nested bullets to the parent field value', () => {
      const md = `### Гипотеза 1: Основная ЦА
- Конкретные фильтры/запросы:
  - ОКВЭД: 46 (Оптовая торговля)
  - Регион: Москва`;

      const blocks = parseHypotheses(md);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].fields).toEqual([
        {
          label: 'Конкретные фильтры/запросы',
          value: 'ОКВЭД: 46 (Оптовая торговля) • Регион: Москва',
        },
      ]);
    });

    it('handles multi-level nesting without producing empty-value fields', () => {
      const md = `### Гипотеза 1: T
- Конкретные фильтры/запросы:
  - ОКВЭД (основной или дополнительный):
    - 46 (Оптовая торговля, кроме автотранспорта)
    - 47 (Розничная торговля)
  - Выручка: 50-500 млн ₽`;

      const blocks = parseHypotheses(md);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].fields).toHaveLength(1);
      const field = blocks[0].fields[0];
      expect(field.label).toBe('Конкретные фильтры/запросы');
      expect(field.value).toContain('ОКВЭД');
      expect(field.value).toContain('46 (Оптовая торговля');
      expect(field.value).toContain('47 (Розничная');
      expect(field.value).toContain('Выручка: 50-500 млн ₽');
    });

    it('does not pollute fields list with empty-label entries from sub-bullets', () => {
      const md = `### Гипотеза 1: T
- Источник: Реестры
- Конкретные фильтры/запросы:
  - ОКВЭД: 46
  - Регион: Москва
- Ожидаемый объём: 1500 компаний`;

      const fields = parseHypotheses(md)[0].fields;
      expect(fields).toHaveLength(3);
      expect(fields.map((f) => f.label)).toEqual([
        'Источник',
        'Конкретные фильтры/запросы',
        'Ожидаемый объём',
      ]);
      // sub-bullets must NOT appear as separate fields
      expect(fields.find((f) => f.label === 'ОКВЭД')).toBeUndefined();
      expect(fields.find((f) => f.label === 'Регион')).toBeUndefined();
    });

    it('supports * and + as nested bullet markers (some models use them)', () => {
      const md = `### Гипотеза 1: T
- Фильтры:
  * Регион: Москва
  + Размер: 10-100 чел.`;

      const fields = parseHypotheses(md)[0].fields;
      expect(fields).toHaveLength(1);
      expect(fields[0].value).toContain('Регион: Москва');
      expect(fields[0].value).toContain('Размер: 10-100 чел.');
    });
  });

  /**
   * Some models drop `### ` and use `## ` or `**Гипотеза N: title**` instead.
   * Splitter must recognise both so we don't return a single mega-block.
   */
  describe('section splitting robustness (May 2026)', () => {
    it('splits on ## headings (not just ###)', () => {
      const md = `## Гипотеза 1: A
- Источник: HH

## Гипотеза 2: B
- Источник: Карты`;

      const blocks = parseHypotheses(md);
      expect(blocks).toHaveLength(2);
      expect(blocks[0].title).toBe('A');
      expect(blocks[1].title).toBe('B');
    });

    it('splits on bold-only "**Гипотеза N: …**" headings without #', () => {
      const md = `**Гипотеза 1: A**
- Источник: HH

**Гипотеза 2: B**
- Источник: Карты`;

      const blocks = parseHypotheses(md);
      expect(blocks).toHaveLength(2);
      expect(blocks[0].number).toBe('1');
      expect(blocks[0].title).toBe('A');
      expect(blocks[1].number).toBe('2');
      expect(blocks[1].title).toBe('B');
    });

    it('still parses 5+ hypotheses with mixed indentation styles', () => {
      const md = `### Гипотеза 1: A
- Источник: HH
- Фильтры:
  - Регион: Москва

### Гипотеза 2: B
- Источник: Карты

### Гипотеза 3: C
- Источник: Реестры

### Гипотеза 4: D
- Источник: export-base.ru

### Гипотеза 5: E
- Источник: Поиск`;

      expect(parseHypotheses(md)).toHaveLength(5);
    });
  });
});
