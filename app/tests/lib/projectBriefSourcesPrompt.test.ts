import {
  REQUIRED_SOURCE_NAMES,
  LEAD_SOURCES_KNOWLEDGE,
  buildHypothesesPrompt,
  selectRelevantCatalog,
  renderLeadSourcesKnowledge,
  CLIENT_EXCLUDED_SOURCE_IDS,
  LEAD_SOURCES,
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

describe('renderLeadSourcesKnowledge & client-mode prompt (no «Сигналы»)', () => {
  it('LEAD_SOURCES (structured array) cодержит все обязательные источники по name', () => {
    for (const name of REQUIRED_SOURCE_NAMES) {
      const needle: string = name;
      const found = LEAD_SOURCES.some((s) => (s.name as string).includes(needle));
      expect(found).toBe(true);
    }
  });

  it('LEAD_SOURCES_KNOWLEDGE (default export) === renderLeadSourcesKnowledge() (no regression)', () => {
    expect(renderLeadSourcesKnowledge()).toBe(LEAD_SOURCES_KNOWLEDGE);
  });

  it('CLIENT_EXCLUDED_SOURCE_IDS включает «signals» (Сигналы)', () => {
    expect(CLIENT_EXCLUDED_SOURCE_IDS).toContain('signals');
  });

  it('renderLeadSourcesKnowledge({ exclude: ["signals"] }) НЕ содержит «Сигналы» секции', () => {
    const text = renderLeadSourcesKnowledge({ exclude: ['signals'] });
    expect(text).not.toMatch(/##\s+\d+\.\s+Сигналы/);
    // Тело секции про Сигналы тоже исчезло
    expect(text).not.toContain('кнопка «Сигналы»');
  });

  it('renderLeadSourcesKnowledge({ exclude: ["signals"] }) перенумеровывает оставшиеся источники без пропусков', () => {
    const text = renderLeadSourcesKnowledge({ exclude: ['signals'] });
    const headings = [...text.matchAll(/^##\s+(\d+)\./gm)].map((m) => Number(m[1]));
    expect(headings.length).toBeGreaterThan(0);
    // Должна быть последовательность 1, 2, 3, ... без пропусков
    headings.forEach((n, i) => expect(n).toBe(i + 1));
  });

  it('buildHypothesesPrompt({ audience: "client" }) НЕ упоминает «Сигналы»', () => {
    const { system, user } = buildHypothesesPrompt({
      briefText: 'тестовый бриф',
      catalog: EXPORT_BASE_CATALOG.slice(0, 5),
      audience: 'client',
    });
    const combined = `${system}\n${user}`;
    expect(combined).not.toMatch(/##\s+\d+\.\s+Сигналы/);
    expect(combined).not.toContain('кнопка «Сигналы»');
  });

  it('buildHypothesesPrompt() default (без audience) — поведение не меняется, «Сигналы» присутствуют', () => {
    const { system } = buildHypothesesPrompt({
      briefText: 'тестовый бриф',
      catalog: EXPORT_BASE_CATALOG.slice(0, 5),
    });
    expect(system).toMatch(/##\s+\d+\.\s+Сигналы/);
  });

  it('buildHypothesesPrompt({ audience: "client" }) всё ещё содержит остальные обязательные источники', () => {
    const { system, user } = buildHypothesesPrompt({
      briefText: 'test',
      catalog: EXPORT_BASE_CATALOG.slice(0, 5),
      audience: 'client',
    });
    const combined = `${system}\n${user}`;
    const stillRequired = REQUIRED_SOURCE_NAMES.filter((n) => n !== 'Сигналы');
    for (const source of stillRequired) {
      expect(combined).toContain(source);
    }
  });
});
