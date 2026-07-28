/** @jest-environment node */

import {
  renderTemplatePreview,
  tokenizePreviewText,
} from '@/lib/hypothesisEngine/renderPreview';
import type { HeOperatorMapping } from '@/lib/hypothesisEngine/types';

const MAPPING: HeOperatorMapping[] = [
  { operator: 'firstName', column: 'Имя', matched: true },
  { operator: 'companyName', column: 'Компания', matched: true, fallback: 'ваша компания' },
  { operator: 'city', column: null, matched: false },
];

const LETTERS = [
  {
    subject: '{{firstName}}, идея для {{companyName}}',
    body: 'Здравствуйте, {{firstName}}! Видели {{companyName}} в {{city}}. С уважением, {{firstName}}.',
    wait_days: 0,
  },
  {
    subject: 'Re: {{companyName}}',
    body: 'Добрый день, {{firstName}}. Возвращаюсь к вопросу про {{companyName}}.',
    wait_days: 3,
    segment_variants: [{ when: 'компании вне Москвы', text: 'Текст для сегмента — НЕ показываем в превью.' }],
  },
];

const ROWS = [
  { 'Имя': ' Анна ', 'Компания': 'ООО Ромашка', companyName: 'ООО Ромашка' },
  { 'Имя': 'Иван', 'Компания': '  ', company: 'АО Вектор' },
  { 'Имя': '', 'Компания': '', 'компания': 'ИП Сидоров' },
  { 'Имя': 'Пётр', 'Компания': 'Завод' },
  { 'Имя': 'Мария', 'Компания': 'Строй' },
];

describe('renderTemplatePreview — подстановка', () => {
  it('подставляет значения matched-колонок (trim) в subject и body', () => {
    const result = renderTemplatePreview({
      letters: LETTERS,
      operatorMapping: MAPPING,
      rows: [ROWS[0]],
      columns: ['Имя', 'Компания'],
    });
    expect(result.rows).toHaveLength(1);
    const lead = result.rows[0].letters[0];
    expect(lead.subject).toBe('Анна, идея для ООО Ромашка');
    expect(lead.body).toBe('Здравствуйте, Анна! Видели ООО Ромашка в {{city}}. С уважением, Анна.');
    expect(lead.wait_days).toBe(0);
  });

  it('unmatched-оператор остаётся как есть и записывается в unresolved (один раз)', () => {
    const result = renderTemplatePreview({
      letters: LETTERS,
      operatorMapping: MAPPING,
      rows: [ROWS[0]],
      columns: [],
    });
    expect(result.rows[0].letters[0].unresolved).toEqual(['city']);
  });

  it('оператор вне маппинга → как есть + unresolved', () => {
    const result = renderTemplatePreview({
      letters: [{ subject: 'Тема', body: 'Привет, {{unknownVar}}!', wait_days: 0 }],
      operatorMapping: MAPPING,
      rows: [ROWS[0]],
      columns: [],
    });
    const lead = result.rows[0].letters[0];
    expect(lead.body).toBe('Привет, {{unknownVar}}!');
    expect(lead.unresolved).toEqual(['unknownVar']);
  });

  it('пустая ячейка → fallback matched-маппинга, без unresolved', () => {
    const result = renderTemplatePreview({
      letters: LETTERS,
      operatorMapping: MAPPING,
      rows: [ROWS[1]],
      columns: ['Имя', 'Компания'],
    });
    const lead = result.rows[0].letters[0];
    expect(lead.subject).toBe('Иван, идея для ваша компания');
    expect(lead.body).not.toContain('{{companyName}}');
    expect(lead.unresolved).toEqual(['city']);
  });

  it('пустая ячейка без fallback → оператор остаётся + unresolved', () => {
    const mapping: HeOperatorMapping[] = [{ operator: 'firstName', column: 'Имя', matched: true }];
    const result = renderTemplatePreview({
      letters: [{ subject: '{{firstName}}', body: 'Привет, {{firstName}}!', wait_days: 0 }],
      operatorMapping: mapping,
      rows: [{ 'Имя': '   ' }],
      columns: ['Имя'],
    });
    const lead = result.rows[0].letters[0];
    expect(lead.subject).toBe('{{firstName}}');
    expect(lead.body).toBe('Привет, {{firstName}}!');
    expect(lead.unresolved).toEqual(['firstName']);
  });

  it('unresolved собирается из subject и body с дедупликацией', () => {
    const result = renderTemplatePreview({
      letters: [{ subject: '{{a}} и {{b}}', body: '{{b}} и {{c}}', wait_days: 0 }],
      operatorMapping: [],
      rows: [{}],
      columns: [],
    });
    expect(result.rows[0].letters[0].unresolved).toEqual(['a', 'b', 'c']);
  });

  it('нестроковые значения ячеек строкифицируются', () => {
    const mapping: HeOperatorMapping[] = [
      { operator: 'seats', column: 'Мест', matched: true },
      { operator: 'active', column: 'Активен', matched: true },
    ];
    const result = renderTemplatePreview({
      letters: [{ subject: 'Тема', body: 'Мест: {{seats}}, активен: {{active}}.', wait_days: 0 }],
      operatorMapping: mapping,
      rows: [{ 'Мест': 42, 'Активен': true }],
      columns: ['Мест', 'Активен'],
    });
    expect(result.rows[0].letters[0].body).toBe('Мест: 42, активен: true.');
  });

  it('сегментные варианты не применяются — рендерится дефолтный body', () => {
    const result = renderTemplatePreview({
      letters: LETTERS,
      operatorMapping: MAPPING,
      rows: [ROWS[0]],
      columns: [],
    });
    const second = result.rows[0].letters[1];
    expect(second.body).toContain('Возвращаюсь к вопросу');
    expect(second.body).not.toContain('НЕ показываем');
    expect(second.wait_days).toBe(3);
  });
});

describe('renderTemplatePreview — rowLabel', () => {
  const letters = [{ subject: 's', body: 'b', wait_days: 0 }];

  it('приоритет companyName > company > компания, регистронезависимо', () => {
    const result = renderTemplatePreview({ letters, operatorMapping: [], rows: ROWS.slice(0, 3), columns: [] });
    expect(result.rows[0].rowLabel).toBe('ООО Ромашка');
    expect(result.rows[1].rowLabel).toBe('АО Вектор');
    expect(result.rows[2].rowLabel).toBe('ИП Сидоров');
  });

  it('колонка «Компания» матчится по lowercase-кандидату «компания»', () => {
    const result = renderTemplatePreview({
      letters,
      operatorMapping: [],
      rows: [{ 'Компания': 'ООО Только Колонка' }],
      columns: ['Компания'],
    });
    expect(result.rows[0].rowLabel).toBe('ООО Только Колонка');
  });

  it('без колонок-кандидатов → «Лид N»', () => {
    const result = renderTemplatePreview({ letters, operatorMapping: [], rows: [{ 'Имя': 'Пётр' }, {}], columns: [] });
    expect(result.rows[0].rowLabel).toBe('Лид 1');
    expect(result.rows[1].rowLabel).toBe('Лид 2');
  });
});

describe('renderTemplatePreview — maxRows', () => {
  const letters = [{ subject: 's', body: 'b', wait_days: 0 }];

  it('по умолчанию рендерит первые 3 строки', () => {
    const result = renderTemplatePreview({ letters, operatorMapping: [], rows: ROWS, columns: [] });
    expect(result.rows).toHaveLength(3);
  });

  it('явный maxRows ограничивает выдачу', () => {
    const result = renderTemplatePreview({ letters, operatorMapping: [], rows: ROWS, columns: [], maxRows: 2 });
    expect(result.rows).toHaveLength(2);
  });

  it('maxRows больше числа строк → все строки', () => {
    const result = renderTemplatePreview({ letters, operatorMapping: [], rows: ROWS.slice(0, 1), columns: [], maxRows: 10 });
    expect(result.rows).toHaveLength(1);
  });
});

describe('tokenizePreviewText — токены для UI-подсветки', () => {
  it('подставленные значения → kind=value, неразрешённые → kind=unresolved с маркером', () => {
    const { tokens, unresolved } = tokenizePreviewText(
      'Привет, {{firstName}} из {{city}}!',
      MAPPING,
      { 'Имя': 'Анна' },
    );
    expect(tokens).toEqual([
      { text: 'Привет, ', kind: 'text' },
      { text: 'Анна', kind: 'value', operator: 'firstName' },
      { text: ' из ', kind: 'text' },
      { text: '{{city}}', kind: 'unresolved', operator: 'city' },
      { text: '!', kind: 'text' },
    ]);
    expect(unresolved).toEqual(['city']);
  });

  it('пустой текст → пустые токены', () => {
    expect(tokenizePreviewText('', MAPPING, {})).toEqual({ tokens: [], unresolved: [] });
  });
});
