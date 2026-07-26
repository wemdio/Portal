/** @jest-environment node */

import { parseLettersFromModelOutput } from '@/lib/emailSequenceV2/letterParser';
import {
  extractPersonalizationOperators,
  extractSegmentVariants,
  mapOperatorsToColumns,
  validateOperatorMapping,
} from '@/lib/hypothesisEngine/stages/template';
import type { HeTemplatePlanOutput } from '@/lib/hypothesisEngine/schemas';

describe('extractPersonalizationOperators', () => {
  it('находит операторы в порядке появления, дедуплицирует регистронезависимо', () => {
    const text = 'Привет, {{firstName}}! Видел {{companyName}} и {{ firstName }} — тема: {{companyName}}?';
    expect(extractPersonalizationOperators(text)).toEqual(['firstName', 'companyName']);
  });

  it('поддерживает ru/en, подчёркивания и точки; игнорирует пустые скобки', () => {
    const text = '{{Имя}} {{lead.first_name}} {{}} {{ }} {{company.website}}';
    expect(extractPersonalizationOperators(text)).toEqual(['Имя', 'lead.first_name', 'company.website']);
  });

  it('пустой/безоператорный текст → []', () => {
    expect(extractPersonalizationOperators('просто текст без подстановок')).toEqual([]);
  });
});

describe('mapOperatorsToColumns', () => {
  const columns = ['Имя', 'Компания', 'Сайт', 'Должность', 'E-mail', 'Выручка'];

  it('маппит типовые операторы на русские колонки через словарь синонимов', () => {
    const mapping = mapOperatorsToColumns(['firstName', 'companyName', 'website', 'position', 'email'], columns);
    expect(mapping).toEqual([
      { operator: 'firstName', column: 'Имя', matched: true },
      { operator: 'companyName', column: 'Компания', matched: true },
      { operator: 'website', column: 'Сайт', matched: true },
      { operator: 'position', column: 'Должность', matched: true },
      { operator: 'email', column: 'E-mail', matched: true },
    ]);
  });

  it('точное совпадение колонки работает без словаря', () => {
    const mapping = mapOperatorsToColumns(['Выручка'], columns);
    expect(mapping).toEqual([{ operator: 'Выручка', column: 'Выручка', matched: true }]);
  });

  it('подстрока ловит «Название компании» для companyName', () => {
    const mapping = mapOperatorsToColumns(['companyName'], ['Название компании', 'Город']);
    expect(mapping[0]).toEqual({ operator: 'companyName', column: 'Название компании', matched: true });
  });

  it('неизвестный оператор → matched=false, column=null', () => {
    const mapping = mapOperatorsToColumns(['favouriteColor'], columns);
    expect(mapping).toEqual([{ operator: 'favouriteColor', column: null, matched: false }]);
  });

  it('пустой список колонок → все unmatched, без падений', () => {
    const mapping = mapOperatorsToColumns(['firstName'], []);
    expect(mapping).toEqual([{ operator: 'firstName', column: null, matched: false }]);
  });
});

describe('mapOperatorsToColumns — канонические Instantly-операторы (кейс name/area)', () => {
  // База с HH: name — название вакансии, area — город, company — компания.
  const hhColumns = ['name', 'area', 'position', 'company'];

  it('cityName → area, vacancyTitle → name', () => {
    const mapping = mapOperatorsToColumns(['cityName', 'vacancyTitle'], hhColumns);
    expect(mapping).toEqual([
      { operator: 'cityName', column: 'area', matched: true },
      { operator: 'vacancyTitle', column: 'name', matched: true },
    ]);
  });

  it('cityName НЕ цепляется к колонке name, когда area/city/города нет', () => {
    const mapping = mapOperatorsToColumns(['cityName'], ['name', 'company']);
    expect(mapping).toEqual([{ operator: 'cityName', column: null, matched: false }]);
  });

  it('firstName не маппится на name (это вакансия, а не имя контакта)', () => {
    const mapping = mapOperatorsToColumns(['firstName'], hhColumns);
    expect(mapping).toEqual([{ operator: 'firstName', column: null, matched: false }]);
  });

  it('маппинг никогда не указывает на колонку вне списка', () => {
    const mapping = mapOperatorsToColumns(['companyName', 'vacancyTitle', 'cityName', 'email'], hhColumns);
    for (const m of mapping) {
      if (m.matched) expect(hhColumns).toContain(m.column);
    }
  });
});

describe('extractSegmentVariants', () => {
  const raw = `---LETTER 1---
Тема: {{vacancyTitle}} в {{cityName}}

Здравствуйте! Видим, что {{companyName}} расширяет найм.

---SEGMENT: компании вне Москвы/СПб---

В регионах найм идёт иначе, чем в столице, — есть разбор.

---LETTER 2---
Тема: Короткий кейс

Один из ваших коллег по вертикали закрывал ту же дыру.

---SEGMENT: региональные HR-команды---

Для региональных HR-команд у нас отдельный кейс — пришлю.`;

  it('вырезает ---SEGMENT--- блоки: основные письма парсятся как раньше', () => {
    const { cleaned, variants } = extractSegmentVariants(raw);
    expect(cleaned).not.toContain('SEGMENT');

    const parsed = parseLettersFromModelOutput(cleaned);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].subject).toBe('{{vacancyTitle}} в {{cityName}}');
    expect(parsed[0].body).toContain('расширяет найм');
    expect(parsed[0].body).not.toContain('В регионах');
    expect(parsed[1].body).not.toContain('региональных HR');

    expect(variants.get(1)).toEqual([
      { when: 'компании вне Москвы/СПб', text: 'В регионах найм идёт иначе, чем в столице, — есть разбор.' },
    ]);
    expect(variants.get(2)).toEqual([
      { when: 'региональные HR-команды', text: 'Для региональных HR-команд у нас отдельный кейс — пришлю.' },
    ]);
  });

  it('текст без ---SEGMENT--- блоков возвращается как есть', () => {
    const plain = `---LETTER 1---\nТема: Раз\n\nТело.\n\n---LETTER 2---\nТема: Два\n\nТело 2.`;
    const { cleaned, variants } = extractSegmentVariants(plain);
    expect(cleaned).toBe(plain);
    expect(variants.size).toBe(0);
  });
});

describe('validateOperatorMapping', () => {
  const columns = ['name', 'area'];
  const plan: HeTemplatePlanOutput = {
    fixed_block: 'костяк',
    personalization_plan: [
      {
        letter_index: 1,
        operators: [
          { var: 'vacancyTitle', column: 'name' },
          { var: 'cityName', column: 'area' },
        ],
      },
    ],
    segment_additions: [],
    letters: [],
  };

  it('оператор из плана обязан присутствовать в маппинге', () => {
    const issues = validateOperatorMapping(
      [{ operator: 'vacancyTitle', column: 'name', matched: true }],
      columns,
      plan,
    );
    expect(issues.some((i) => i.includes('cityName') && i.includes('отсутствует'))).toBe(true);
  });

  it('unmatched без fallback — проблема; unmatched с fallback — допустимо', () => {
    const withFallback = validateOperatorMapping(
      [
        { operator: 'vacancyTitle', column: 'name', matched: true },
        { operator: 'cityName', column: null, matched: false, fallback: 'ваш город' },
      ],
      columns,
      plan,
    );
    expect(withFallback).toEqual([]);

    const withoutFallback = validateOperatorMapping(
      [
        { operator: 'vacancyTitle', column: 'name', matched: true },
        { operator: 'cityName', column: null, matched: false },
      ],
      columns,
      plan,
    );
    expect(withoutFallback.some((i) => i.includes('cityName') && i.includes('fallback'))).toBe(true);
  });

  it('оператор в теме обязан быть matched (fallback в теме невозможен)', () => {
    const issues = validateOperatorMapping(
      [
        { operator: 'vacancyTitle', column: 'name', matched: true },
        { operator: 'cityName', column: null, matched: false, fallback: 'ваш город' },
      ],
      columns,
      plan,
      { subjectOperators: ['cityName'] },
    );
    expect(issues.some((i) => i.includes('cityName') && i.includes('теме'))).toBe(true);

    const clean = validateOperatorMapping(
      [
        { operator: 'vacancyTitle', column: 'name', matched: true },
        { operator: 'cityName', column: 'area', matched: true },
      ],
      columns,
      plan,
      { subjectOperators: ['vacancyTitle', 'cityName'] },
    );
    expect(clean).toEqual([]);
  });

  it('matched на колонку вне списка — проблема', () => {
    const issues = validateOperatorMapping(
      [
        { operator: 'vacancyTitle', column: 'name', matched: true },
        { operator: 'cityName', column: 'город', matched: true },
      ],
      columns,
      plan,
    );
    expect(issues.some((i) => i.includes('cityName') && i.includes('город'))).toBe(true);
  });
});
