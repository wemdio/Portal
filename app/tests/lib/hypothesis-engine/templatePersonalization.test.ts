/** @jest-environment node */

import {
  extractPersonalizationOperators,
  mapOperatorsToColumns,
} from '@/lib/hypothesisEngine/stages/template';

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
