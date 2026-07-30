/** @jest-environment node */

import {
  OPERATOR_RE,
  renderTemplatePreview,
  tokenizePreviewText,
} from '@/lib/hypothesisEngine/renderPreview';
import type { HeOperatorMapping } from '@/lib/hypothesisEngine/types';

const MAPPING: HeOperatorMapping[] = [
  { operator: 'firstName', column: 'Имя', matched: true },
  // Fallback у matched-маппинга — проверка, что ветка «matched+empty→fallback»
  // удалена: боевой пайплайн fallback сюда не ставит, превью его игнорирует.
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
    expect(lead.emptyVars).toEqual([]);
  });

  it('unmatched без fallback остаётся как есть и записывается в unresolved (один раз)', () => {
    const result = renderTemplatePreview({
      letters: LETTERS,
      operatorMapping: MAPPING,
      rows: [ROWS[0]],
      columns: [],
    });
    expect(result.rows[0].letters[0].unresolved).toEqual(['city']);
    expect(result.rows[0].letters[0].emptyVars).toEqual([]);
  });

  it('unmatched с fallback → подставляется fallback (токен kind=fallback), без unresolved', () => {
    const mapping: HeOperatorMapping[] = [
      { operator: 'city', column: null, matched: false, fallback: 'в вашем городе' },
    ];
    const result = renderTemplatePreview({
      letters: [{ subject: 'Тема', body: 'Пишем компаниям {{city}}.', wait_days: 0 }],
      operatorMapping: mapping,
      rows: [{}],
      columns: [],
    });
    const lead = result.rows[0].letters[0];
    expect(lead.body).toBe('Пишем компаниям в вашем городе.');
    expect(lead.unresolved).toEqual([]);
    expect(lead.emptyVars).toEqual([]);

    const { tokens } = tokenizePreviewText('Пишем компаниям {{city}}.', mapping, {});
    expect(tokens).toEqual([
      { text: 'Пишем компаниям ', kind: 'text' },
      { text: 'в вашем городе', kind: 'fallback', operator: 'city' },
      { text: '.', kind: 'text' },
    ]);
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
    expect(lead.emptyVars).toEqual([]);
  });

  it('matched + пустая ячейка → пустая строка + emptyVars (fallback matched-маппинга игнорируется)', () => {
    const result = renderTemplatePreview({
      letters: LETTERS,
      operatorMapping: MAPPING,
      rows: [ROWS[1]],
      columns: ['Имя', 'Компания'],
    });
    const lead = result.rows[0].letters[0];
    expect(lead.subject).toBe('Иван, идея для ');
    expect(lead.body).toBe('Здравствуйте, Иван! Видели  в {{city}}. С уважением, Иван.');
    expect(lead.unresolved).toEqual(['city']);
    expect(lead.emptyVars).toEqual(['companyName']);
  });

  it('matched + пустая ячейка без fallback → пустая строка, НЕ unresolved', () => {
    const mapping: HeOperatorMapping[] = [{ operator: 'firstName', column: 'Имя', matched: true }];
    const result = renderTemplatePreview({
      letters: [{ subject: '{{firstName}}', body: 'Привет, {{firstName}}!', wait_days: 0 }],
      operatorMapping: mapping,
      rows: [{ 'Имя': '   ' }],
      columns: ['Имя'],
    });
    const lead = result.rows[0].letters[0];
    expect(lead.subject).toBe('');
    expect(lead.body).toBe('Привет, !');
    expect(lead.unresolved).toEqual([]);
    expect(lead.emptyVars).toEqual(['firstName']);
  });

  it('emptyVars собирается из subject и body с регистронезависимым дедупом', () => {
    const mapping: HeOperatorMapping[] = [{ operator: 'firstName', column: 'Имя', matched: true }];
    const result = renderTemplatePreview({
      letters: [{ subject: '{{firstName}}', body: '{{FirstName}} и {{FIRSTNAME}}', wait_days: 0 }],
      operatorMapping: mapping,
      rows: [{ 'Имя': ' ' }],
      columns: ['Имя'],
    });
    const lead = result.rows[0].letters[0];
    expect(lead.emptyVars).toEqual(['firstName']);
    expect(lead.unresolved).toEqual([]);
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

  it('unresolved дедуплицируется регистронезависимо (сохраняется первое написание)', () => {
    const result = renderTemplatePreview({
      letters: [{ subject: '{{City}} и {{city}}', body: '{{CITY}} и {{other}}', wait_days: 0 }],
      operatorMapping: [],
      rows: [{}],
      columns: [],
    });
    expect(result.rows[0].letters[0].unresolved).toEqual(['City', 'other']);
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

  it('подпись берётся из matched-маппинга — русскоязычная колонка «Название компании»', () => {
    const mapping: HeOperatorMapping[] = [
      { operator: 'CompanyName', column: 'Название компании', matched: true },
    ];
    const result = renderTemplatePreview({
      letters,
      operatorMapping: mapping,
      rows: [{ 'Название компании': 'ООО Реестр' }],
      columns: ['Название компании'],
    });
    expect(result.rows[0].rowLabel).toBe('ООО Реестр');
  });

  it('маппинг (company) важнее LABEL_COLUMNS', () => {
    const mapping: HeOperatorMapping[] = [
      { operator: 'company', column: 'Org', matched: true },
    ];
    const result = renderTemplatePreview({
      letters,
      operatorMapping: mapping,
      rows: [{ Org: 'АО Из Маппинга', company: 'Из Колонки' }],
      columns: ['Org'],
    });
    expect(result.rows[0].rowLabel).toBe('АО Из Маппинга');
  });

  it('пустая ячейка в колонке из маппинга → фолбэк на LABEL_COLUMNS', () => {
    const mapping: HeOperatorMapping[] = [
      { operator: 'companyName', column: 'Название компании', matched: true },
    ];
    const result = renderTemplatePreview({
      letters,
      operatorMapping: mapping,
      rows: [{ 'Название компании': '  ', 'Компания': 'ООО Фолбэк' }],
      columns: ['Название компании', 'Компания'],
    });
    expect(result.rows[0].rowLabel).toBe('ООО Фолбэк');
  });

  it('unmatched-маппинг на companyName подпись не даёт', () => {
    const mapping: HeOperatorMapping[] = [
      { operator: 'companyName', column: null, matched: false, fallback: 'ваша компания' },
    ];
    const result = renderTemplatePreview({
      letters,
      operatorMapping: mapping,
      rows: [{ 'Имя': 'Пётр' }],
      columns: ['Имя'],
    });
    expect(result.rows[0].rowLabel).toBe('Лид 1');
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
    const { tokens, unresolved, emptyVars } = tokenizePreviewText(
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
    expect(emptyVars).toEqual([]);
  });

  it('matched + пустая ячейка → токен value с пустым текстом + emptyVars', () => {
    const { tokens, unresolved, emptyVars } = tokenizePreviewText(
      '{{firstName}}!',
      [{ operator: 'firstName', column: 'Имя', matched: true }],
      { 'Имя': '  ' },
    );
    expect(tokens).toEqual([
      { text: '', kind: 'value', operator: 'firstName' },
      { text: '!', kind: 'text' },
    ]);
    expect(unresolved).toEqual([]);
    expect(emptyVars).toEqual(['firstName']);
  });

  it('unresolved внутри одного текста дедуплицируется регистронезависимо', () => {
    const { unresolved } = tokenizePreviewText('{{City}} и {{city}} и {{CITY}}', [], {});
    expect(unresolved).toEqual(['City']);
  });

  it('пустой текст → пустые токены', () => {
    expect(tokenizePreviewText('', MAPPING, {})).toEqual({ tokens: [], unresolved: [], emptyVars: [] });
  });

  it('OPERATOR_RE — тот же строгий регексп, что и в боевой экстракции', () => {
    expect(OPERATOR_RE.source).toBe('\\{\\{\\s*([A-Za-zА-Яа-яЁё0-9_.-]+)\\s*\\}\\}');
    expect('{{ firstName }}'.match(OPERATOR_RE)).toEqual(['{{ firstName }}']);
    // Пробел внутри имени — не оператор (старый UI-регексп [^{}]+ такое ловил).
    expect('{{some thing}}'.match(OPERATOR_RE)).toBeNull();
  });
});
