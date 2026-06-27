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

  // Пинит суть фикса «одинаковые гипотезы разным клиентам»: внутренняя
  // инструкция должна гнать модель выводить ICP, разнообразить ТИПЫ источников
  // и не добивать гипотезы общими категориями. Без этого гарда ревёрт
  // формулировок прошёл бы молча и вернул баг.
  it('buildHypothesesPrompt (internal) пинит ICP-стир и правило разнообразия', () => {
    const { system, user } = buildHypothesesPrompt({
      briefText: 'test',
      catalog: EXPORT_BASE_CATALOG.slice(0, 5),
    });
    const combined = `${system}\n${user}`;
    expect(combined).toContain('КОНКРЕТНЫЙ ICP');
    expect(combined).toContain('Разнообразь ТИПЫ источников');
    expect(combined).toContain('НЕ добивай гипотезы общими категориями');
    expect(system).toContain('6. РАЗНООБРАЗИЕ');
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

  it('selectRelevantCatalog: бриф без keyword-совпадений отдаёт ПУСТО, не grab-bag', () => {
    // Несвязный бриф (токены не пересекаются с названиями категорий) раньше
    // проваливался в «универсальный» grab-bag (WB/OZON, госзакупки), который
    // инструкция запрещает. Теперь — пусто, чтобы не было противоречия
    // «вот запрещённое меню, но не используй его».
    const result = selectRelevantCatalog('qwxzvb asdfghj zxcvbn plmokn', EXPORT_BASE_CATALOG, 20);
    expect(result).toEqual([]);
  });

  it('selectRelevantCatalog: стемминг ловит русские словоформы (клиники↔клиник)', () => {
    const mini = [
      { category: 'Рубрика', name: 'База клиник и медицинских центров', url: 'u1' },
      { category: 'Рубрика', name: 'База строительных компаний и подрядчиков', url: 'u2' },
      { category: 'Рубрика', name: 'База автосалонов и дилеров', url: 'u3' },
    ] as unknown as Parameters<typeof selectRelevantCatalog>[1];
    // Бриф со СЛОВОФОРМАМИ (не точные токены каталога): «клиники»→«клиник»,
    // «строительство»→«строительных». Раньше exact-match их терял.
    const result = selectRelevantCatalog('частные клиники и строительство жилья', mini, 10);
    const urls = result.map((r) => r.url);
    expect(urls).toContain('u1');
    expect(urls).toContain('u2');
    expect(urls).not.toContain('u3');
  });
});

describe('renderLeadSourcesKnowledge & client-mode prompt safety', () => {
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

  it('CLIENT_EXCLUDED_SOURCE_IDS включает team-only источники', () => {
    expect(CLIENT_EXCLUDED_SOURCE_IDS).toContain('signals');
    expect(CLIENT_EXCLUDED_SOURCE_IDS).toContain('crypto_payments');
    // agency_catalogs (Рейтинг Рунета) — скрейпинг каталогов делает специалист,
    // клиент сам не парсит → источник должен оставаться скрытым от клиента.
    expect(CLIENT_EXCLUDED_SOURCE_IDS).toContain('agency_catalogs');
  });

  it('renderLeadSourcesKnowledge({ exclude: CLIENT_EXCLUDED_SOURCE_IDS }) НЕ содержит team-only секции', () => {
    const text = renderLeadSourcesKnowledge({ exclude: CLIENT_EXCLUDED_SOURCE_IDS });
    expect(text).not.toMatch(/##\s+\d+\.\s+Сигналы/);
    expect(text).not.toContain('Crypto Payments');
    expect(text).not.toContain('/parsers/crypto-payments');
    expect(text).not.toContain('наш парсер');
    // Тело секции про Сигналы тоже исчезло
    expect(text).not.toContain('кнопка «Сигналы»');
  });

  it('renderLeadSourcesKnowledge({ exclude: CLIENT_EXCLUDED_SOURCE_IDS }) перенумеровывает оставшиеся источники без пропусков', () => {
    const text = renderLeadSourcesKnowledge({ exclude: CLIENT_EXCLUDED_SOURCE_IDS });
    const headings = [...text.matchAll(/^##\s+(\d+)\./gm)].map((m) => Number(m[1]));
    expect(headings.length).toBeGreaterThan(0);
    // Должна быть последовательность 1, 2, 3, ... без пропусков
    headings.forEach((n, i) => expect(n).toBe(i + 1));
  });

  it('buildHypothesesPrompt({ audience: "client" }) НЕ упоминает закрытые источники и интерфейсные подсказки', () => {
    const { system, user } = buildHypothesesPrompt({
      briefText: 'тестовый бриф',
      catalog: EXPORT_BASE_CATALOG.slice(0, 5),
      audience: 'client',
    });
    const combined = `${system}\n${user}`;
    const blockedFragments = [
      'Crypto Payments',
      'Сигналы',
      'Рейтинг Рунета',
      '/tools',
      '/parsers',
      'кнопка',
      'наш парсер',
      'нашим специалистом',
    ];
    for (const fragment of blockedFragments) {
      expect(combined).not.toContain(fragment);
    }
  });

  it('buildHypothesesPrompt({ audience: "client" }) сохраняет много гипотез и SaaS-actionable рамку', () => {
    const { system, user } = buildHypothesesPrompt({
      briefText: 'тестовый бриф',
      catalog: EXPORT_BASE_CATALOG.slice(0, 5),
      audience: 'client',
    });
    const combined = `${system}\n${user}`;
    expect(combined).toContain('5–10');
    expect(combined).toContain('идеально 7–8');
    expect(combined).toContain('самостоятельный план для клиента');
    expect(combined).toContain('в клиентском портале');
    expect(combined).toContain('понятно использовать вне портала');
    expect(combined).toContain('внешние открытые источники');
    expect(combined).toContain('Критерии сбора / как собрать базу');
    expect(combined).toContain('поиск вакансий HH');
    expect(combined).toContain('не через раздел «Компании»');
    expect(combined).toContain('Для гипотез с источником HH запрещено упоминать ССЧ, выручку');
    expect(combined).toContain('ни как следующий шаг');
    expect(combined).not.toContain('Конкретные фильтры/запросы');
  });

  it('client HH knowledge не обещает размер, ССЧ или выручку как HH-критерии', () => {
    const knowledge = renderLeadSourcesKnowledge({
      exclude: CLIENT_EXCLUDED_SOURCE_IDS,
      audience: 'client',
    });
    const hhSection = knowledge.split('## 2.')[0];

    expect(hhSection).not.toContain('размер компании');
    expect(hhSection).toContain('не указывай ССЧ');
    expect(hhSection).toContain('не указывай выручку');
    expect(hhSection).toContain('не предлагай их как последующую фильтрацию');
  });

  it('buildHypothesesPrompt() default (без audience) — поведение не меняется, team-only источники присутствуют', () => {
    const { system } = buildHypothesesPrompt({
      briefText: 'тестовый бриф',
      catalog: EXPORT_BASE_CATALOG.slice(0, 5),
    });
    expect(system).toMatch(/##\s+\d+\.\s+Сигналы/);
    expect(system).toContain('Crypto Payments');
    expect(system).toContain('/parsers/crypto-payments');
    expect(system).toContain('/tools/databases');
  });

  it('buildHypothesesPrompt({ audience: "client" }) всё ещё содержит остальные клиентские источники', () => {
    const { system, user } = buildHypothesesPrompt({
      briefText: 'test',
      catalog: EXPORT_BASE_CATALOG.slice(0, 5),
      audience: 'client',
    });
    const combined = `${system}\n${user}`;
    const hiddenFromClient = new Set(['Crypto Payments', 'Сигналы']);
    const stillRequired = REQUIRED_SOURCE_NAMES.filter((n) => !hiddenFromClient.has(n));
    for (const source of stillRequired) {
      expect(combined).toContain(source);
    }
  });
});
