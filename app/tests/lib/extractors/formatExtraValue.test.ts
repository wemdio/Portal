/** @jest-environment node */

import { formatExtraValue, EMPTY_CELL_DASH } from '@/lib/enrich/extractors/formatExtraValue';

describe('formatExtraValue — DASH and tristate booleans', () => {
  it('exports DASH as the en-dash character so callers can compare', () => {
    expect(EMPTY_CELL_DASH).toBe('–');
  });

  it('renders undefined/null as DASH for every key', () => {
    const keys: Array<Parameters<typeof formatExtraValue>[0]> = [
      'customers', 'integrations', 'case_industries',
      'enterprise_logos', 'free_trial',
      'cases_count', 'vacancies_count', 'team_size', 'founded_year',
      'pricing_model', 'blog_last_post', 'stack', 'profile',
      'pricing_min', 'hiring_roles', 'client_segment',
    ];
    for (const key of keys) {
      expect(formatExtraValue(key, undefined)).toBe('–');
      expect(formatExtraValue(key, null)).toBe('–');
    }
  });

  it('renders empty arrays as DASH (customers/integrations/case_industries)', () => {
    expect(formatExtraValue('customers', [])).toBe('–');
    expect(formatExtraValue('integrations', [])).toBe('–');
    expect(formatExtraValue('case_industries', [])).toBe('–');
  });

  it('renders non-empty arrays as comma-joined string', () => {
    expect(formatExtraValue('customers', ['Сбербанк', 'МТС'])).toBe('Сбербанк, МТС');
  });

  it('renders enterprise_logos / free_trial as tri-state: true→Да, false→Нет, undefined→DASH', () => {
    expect(formatExtraValue('enterprise_logos', true)).toBe('Да');
    expect(formatExtraValue('enterprise_logos', false)).toBe('Нет');
    expect(formatExtraValue('enterprise_logos', undefined)).toBe('–');
    expect(formatExtraValue('free_trial', true)).toBe('Да');
    expect(formatExtraValue('free_trial', false)).toBe('Нет');
    expect(formatExtraValue('free_trial', undefined)).toBe('–');
  });

  it('renders 0 as DASH for count fields (0 means "we did not find any")', () => {
    expect(formatExtraValue('cases_count', 0)).toBe('–');
    expect(formatExtraValue('vacancies_count', 0)).toBe('–');
    expect(formatExtraValue('team_size', 0)).toBe('–');
  });

  it('renders positive counts as plain strings', () => {
    expect(formatExtraValue('cases_count', 23)).toBe('23');
    expect(formatExtraValue('vacancies_count', 4)).toBe('4');
    expect(formatExtraValue('team_size', 80)).toBe('80');
  });

  it('renders cases_count estimate string «N+» as-is; empty → DASH', () => {
    expect(formatExtraValue('cases_count', '20+')).toBe('20+');
    expect(formatExtraValue('cases_count', '  15+  ')).toBe('15+');
    expect(formatExtraValue('cases_count', '')).toBe('–');
    expect(formatExtraValue('cases_count', 23)).toBe('23');
    expect(formatExtraValue('cases_count', 0)).toBe('–');
  });

  it('renders vacancies_count estimate string «N+» as-is; empty → DASH', () => {
    expect(formatExtraValue('vacancies_count', '10+')).toBe('10+');
    expect(formatExtraValue('vacancies_count', 4)).toBe('4');
    expect(formatExtraValue('vacancies_count', 0)).toBe('–');
    expect(formatExtraValue('vacancies_count', '')).toBe('–');
  });

  it('renders implausible founded_year as DASH (out of 1800-2100)', () => {
    expect(formatExtraValue('founded_year', 1750)).toBe('–');
    expect(formatExtraValue('founded_year', 9999)).toBe('–');
    expect(formatExtraValue('founded_year', 0)).toBe('–');
    expect(formatExtraValue('founded_year', 2018)).toBe('2018');
  });

  it('renders pricing_model as Russian label; "unknown" → DASH', () => {
    expect(formatExtraValue('pricing_model', 'self-serve')).toBe('Самообслуживание');
    expect(formatExtraValue('pricing_model', 'sales-led')).toBe('Через продажи');
    expect(formatExtraValue('pricing_model', 'unknown')).toBe('–');
  });

  it('renders pricing_min as "value currency"; bad shapes → DASH', () => {
    expect(formatExtraValue('pricing_min', { value: 990, currency: 'RUB' })).toBe('990 RUB');
    expect(formatExtraValue('pricing_min', { value: 0, currency: 'RUB' })).toBe('–');
    expect(formatExtraValue('pricing_min', { value: 990, currency: '' })).toBe('–');
    expect(formatExtraValue('pricing_min', { foo: 'bar' })).toBe('–');
  });

  it('renders hiring_roles as comma-joined RU labels; all false → DASH', () => {
    expect(formatExtraValue('hiring_roles', {
      engineering: true, marketing: true, sales: false, design: false, product: false,
    })).toBe('инженеры, маркетинг');
    expect(formatExtraValue('hiring_roles', {
      engineering: false, marketing: false, sales: false, design: false, product: false,
    })).toBe('–');
  });

  it('renders whitespace-only strings as DASH for text fields', () => {
    expect(formatExtraValue('blog_last_post', '   ')).toBe('–');
    expect(formatExtraValue('stack', '')).toBe('–');
    expect(formatExtraValue('profile', '')).toBe('–');
  });

  it('passes through non-empty strings for text fields', () => {
    expect(formatExtraValue('blog_last_post', '15 мая 2025: Запуск платформы')).toBe('15 мая 2025: Запуск платформы');
    expect(formatExtraValue('stack', 'Яндекс.Метрика, GTM')).toBe('Яндекс.Метрика, GTM');
  });

  it('renders client_segment as plain string; empty/whitespace → DASH', () => {
    expect(formatExtraValue('client_segment', 'стоматологии')).toBe('стоматологии');
    expect(formatExtraValue('client_segment', 'B2B-стройка')).toBe('B2B-стройка');
    expect(formatExtraValue('client_segment', '   ')).toBe('–');
    expect(formatExtraValue('client_segment', '')).toBe('–');
  });
});
