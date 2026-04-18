import {
  REQUIRED_SOURCE_NAMES,
  LEAD_SOURCES_KNOWLEDGE,
  buildHypothesesPrompt,
  selectRelevantCatalog,
} from '@/lib/projectBriefHypotheses/sources';

// Sanity: the constant must export every source we care about.
const EXPECTED_BY_NAME = ['HH', 'Руспрофайл', 'Селеком', 'Сбис', 'Поисковая выдача', 'Яндекс.Карты', 'Google Maps', 'Crypto Payments', 'Сигналы', 'export-base.ru'];
test('REQUIRED_SOURCE_NAMES drift guard', () => {
  expect([...REQUIRED_SOURCE_NAMES].sort()).toEqual([...EXPECTED_BY_NAME].sort());
});
import { EXPORT_BASE_CATALOG } from '@/lib/projectBriefHypotheses/exportBaseCatalog';

describe('projectBriefHypotheses prompt', () => {
  it('LEAD_SOURCES_KNOWLEDGE упоминает все обязательные источники агентства', () => {
    for (const source of REQUIRED_SOURCE_NAMES) {
      expect(LEAD_SOURCES_KNOWLEDGE).toContain(source);
    }
  });

  it('buildHypothesesPrompt вшивает текст брифа в user message', () => {
    const { user } = buildHypothesesPrompt({
      briefText: 'тестовый бриф клиента из агентства',
      catalog: EXPORT_BASE_CATALOG.slice(0, 5),
    });
    expect(user).toContain('тестовый бриф клиента из агентства');
  });

  it('buildHypothesesPrompt включает все обязательные источники в system+user', () => {
    const { system, user } = buildHypothesesPrompt({
      briefText: 'test',
      catalog: EXPORT_BASE_CATALOG.slice(0, 5),
    });
    const combined = `${system}\n${user}`;
    for (const source of REQUIRED_SOURCE_NAMES) {
      expect(combined).toContain(source);
    }
  });

  it('buildHypothesesPrompt вставляет переданный сэмпл каталога export-base', () => {
    const sample = EXPORT_BASE_CATALOG.slice(0, 3);
    const { user } = buildHypothesesPrompt({ briefText: 'test', catalog: sample });
    for (const item of sample) {
      expect(user).toContain(item.name);
    }
  });

  it('buildHypothesesPrompt усекает слишком большой brief_text', () => {
    const huge = 'A'.repeat(50_000);
    const { user } = buildHypothesesPrompt({ briefText: huge, catalog: EXPORT_BASE_CATALOG.slice(0, 5) });
    expect(user.length).toBeLessThan(huge.length);
  });

  it('selectRelevantCatalog сужает каталог по ключевым словам брифа и держит лимит', () => {
    const result = selectRelevantCatalog(
      'продаём услуги для медицинских клиник, стоматологий и салонов красоты',
      EXPORT_BASE_CATALOG,
      20,
    );
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result.length).toBeGreaterThan(0);
    const hasMedical = result.some((item) => /мед|клин|стоматол|здоров|красот/i.test(item.name));
    expect(hasMedical).toBe(true);
  });

  it('selectRelevantCatalog возвращает фолбэк когда брифа нет', () => {
    const result = selectRelevantCatalog('', EXPORT_BASE_CATALOG, 10);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it('selectRelevantCatalog не дублирует записи', () => {
    const result = selectRelevantCatalog('строительство ремонт мебель медицина', EXPORT_BASE_CATALOG, 50);
    const urls = result.map((r) => r.url);
    expect(new Set(urls).size).toBe(urls.length);
  });
});
