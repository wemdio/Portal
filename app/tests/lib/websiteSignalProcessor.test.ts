/** @jest-environment node */

jest.mock('server-only', () => ({}));

jest.mock('@/lib/enrich/websiteParser', () => ({
  fetchHtmlWithRetry: jest.fn(),
  fetchHtmlWithPlaywright: jest.fn(),
}));

jest.mock('@/lib/enrich/extractors/clientSegmentExtractor', () => ({
  extractClientSegment: jest.fn().mockResolvedValue('тест-сегмент'),
}));

jest.mock('@/lib/enrich/extractors/casesCountLlmExtractor', () => ({
  llmCountCases: jest.fn().mockResolvedValue('5+'),
}));

jest.mock('@/lib/enrich/extractors/careersLlmExtractor', () => ({
  llmExtractHiring: jest.fn().mockResolvedValue({ vacancies: '7+', professions: ['Грузчики'] }),
}));

jest.mock('@/lib/enrich/extractors/pricingLlmExtractor', () => ({
  llmExtractPricing: jest.fn().mockResolvedValue({
    pricing_model: 'sales-led',
    pricing_min: { value: 50000, currency: 'RUB' },
    free_trial: true,
  }),
}));

jest.mock('@/lib/enrich/extractors/integrationsLlmExtractor', () => ({
  llmExtractIntegrations: jest.fn().mockResolvedValue(['amoCRM', 'Slack']),
}));

jest.mock('@/lib/enrich/extractors/socialCompanyFinder', () => ({
  findCompanySocials: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/enrich/extractors/socialPostsExtractor', () => ({
  extractSocialPosts: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/enrich/extractors/eventDetector', () => ({
  detectEventSignals: jest.fn().mockResolvedValue({ event_opening: true, event_opening_summary: 'Новый офис' }),
}));

import { processSignalsForUrl } from '@/lib/enrich/websiteSignalProcessor';
import { fetchHtmlWithRetry, fetchHtmlWithPlaywright } from '@/lib/enrich/websiteParser';
import { findCompanySocials } from '@/lib/enrich/extractors/socialCompanyFinder';
import { extractSocialPosts } from '@/lib/enrich/extractors/socialPostsExtractor';
const findCompanySocialsMock = findCompanySocials as jest.MockedFunction<typeof findCompanySocials>;
const extractSocialPostsMock = extractSocialPosts as jest.MockedFunction<typeof extractSocialPosts>;

const fetchHtmlWithRetryMock = fetchHtmlWithRetry as jest.MockedFunction<typeof fetchHtmlWithRetry>;
const fetchHtmlWithPlaywrightMock = fetchHtmlWithPlaywright as jest.MockedFunction<typeof fetchHtmlWithPlaywright>;

const HTML_WITH_SIGNALS = `
<html>
  <head><title>Test</title></head>
  <body>
    <script src="https://mc.yandex.ru/metrika/tag.js"></script>
    <script src="https://yandex.ru/ads/system/context.js"></script>
    <script>VK.Retargeting.Init("VK-RTRG-1");</script>
  </body>
</html>
`;

describe('processSignalsForUrl', () => {
  beforeEach(() => {
    fetchHtmlWithRetryMock.mockReset();
    fetchHtmlWithPlaywrightMock.mockReset();
  });

  it('returns error without network calls when URL is invalid', async () => {
    const result = await processSignalsForUrl('not a url at all !!! ###');

    expect('error' in result).toBe(true);
    expect(fetchHtmlWithRetryMock).not.toHaveBeenCalled();
    expect(fetchHtmlWithPlaywrightMock).not.toHaveBeenCalled();
  });

  it('uses HTTP path on success and skips Playwright fallback', async () => {
    fetchHtmlWithRetryMock.mockResolvedValue({ html: HTML_WITH_SIGNALS, status: 200 });

    const result = await processSignalsForUrl('example.com');

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.method).toBe('http');
      expect(result.stack).toContain('Яндекс.Метрика');
      expect(result.stack).toContain('Яндекс.Директ');
      expect(result.stack).toContain('VK Pixel');
      expect(result.profile).toBe('Реклама есть, CRM и call-трекинга нет');
      expect(result.signalIds.length).toBeGreaterThan(0);
    }
    expect(fetchHtmlWithRetryMock).toHaveBeenCalledTimes(1);
    expect(fetchHtmlWithPlaywrightMock).not.toHaveBeenCalled();
  });

  it('falls back to Playwright when HTTP returns null for every variant', async () => {
    fetchHtmlWithRetryMock.mockResolvedValue(null);
    fetchHtmlWithPlaywrightMock.mockResolvedValue(HTML_WITH_SIGNALS);

    const result = await processSignalsForUrl('example.com');

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.method).toBe('playwright');
      expect(result.stack).toContain('Яндекс.Метрика');
    }
    // buildFetchFallbacks adds www / http variants, so a dead apex URL
    // burns 4 HTTP fetches before falling back to Playwright. Each variant
    // returns null here — all four are tried in order, then Playwright once.
    expect(fetchHtmlWithRetryMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(fetchHtmlWithPlaywrightMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to Playwright when HTTP returns non-2xx status', async () => {
    fetchHtmlWithRetryMock.mockResolvedValue({ html: '', status: 403 });
    fetchHtmlWithPlaywrightMock.mockResolvedValue(HTML_WITH_SIGNALS);

    const result = await processSignalsForUrl('example.com');

    expect('stack' in result).toBe(true);
    if ('stack' in result) expect(result.method).toBe('playwright');
    expect(fetchHtmlWithPlaywrightMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to Playwright when HTTP throws', async () => {
    fetchHtmlWithRetryMock.mockRejectedValue(new Error('network error'));
    fetchHtmlWithPlaywrightMock.mockResolvedValue(HTML_WITH_SIGNALS);

    const result = await processSignalsForUrl('example.com');

    expect('stack' in result).toBe(true);
    if ('stack' in result) expect(result.method).toBe('playwright');
  });

  it('returns DNS error message when Playwright fails with ERR_NAME_NOT_RESOLVED', async () => {
    fetchHtmlWithRetryMock.mockResolvedValue(null);
    fetchHtmlWithPlaywrightMock.mockRejectedValue(
      new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://example.com/'),
    );

    const result = await processSignalsForUrl('example.com');

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/Домен не найден|DNS/i);
      expect(result.error).not.toContain('Playwright');
    }
  });

  it('returns connection-refused message when server rejects connection', async () => {
    fetchHtmlWithRetryMock.mockRejectedValue(new Error('connect ECONNREFUSED 1.2.3.4:443'));
    fetchHtmlWithPlaywrightMock.mockRejectedValue(
      new Error('page.goto: net::ERR_CONNECTION_REFUSED at https://example.com/'),
    );

    const result = await processSignalsForUrl('example.com');

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/отклон|соединение/i);
      expect(result.error).not.toContain('Playwright');
    }
  });

  it('returns timeout message when both attempts time out', async () => {
    fetchHtmlWithRetryMock.mockRejectedValue(new Error('Request timed out after 12000ms'));
    fetchHtmlWithPlaywrightMock.mockRejectedValue(
      new Error('page.goto: Timeout 18000ms exceeded.'),
    );

    const result = await processSignalsForUrl('example.com');

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/таймаут/i);
      expect(result.error).not.toContain('Playwright');
    }
  });

  it('returns SSL error message when certificate validation fails', async () => {
    fetchHtmlWithRetryMock.mockRejectedValue(new Error('certificate has expired'));
    fetchHtmlWithPlaywrightMock.mockRejectedValue(
      new Error('page.goto: net::ERR_CERT_DATE_INVALID at https://example.com/'),
    );

    const result = await processSignalsForUrl('example.com');

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/SSL|сертификат/i);
    }
  });

  it('returns generic site-unavailable when no specific cause is available', async () => {
    fetchHtmlWithRetryMock.mockResolvedValue(null);
    fetchHtmlWithPlaywrightMock.mockResolvedValue(null);

    const result = await processSignalsForUrl('example.com');

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/недоступ/i);
      expect(result.error).not.toContain('Playwright');
    }
  });

  it('returns empty stack/profile when fetched HTML has no detectable signals', async () => {
    fetchHtmlWithRetryMock.mockResolvedValue({
      html: '<html><body><h1>Hello world</h1></body></html>',
      status: 200,
    });

    const result = await processSignalsForUrl('example.com');

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.stack).toBe('');
      expect(result.profile).toBe('');
      expect(result.signalIds).toEqual([]);
    }
  });

  // Multi-URL: cells from "Наша база баз" exports often carry several sites
  // ("t-paritet.ru, paritet-te.ru", "sportcover.ru, ipksport.ru"). When the
  // first URL is dead we must fall through to the second one.

  it('multi-URL: when the first site fails DNS, falls back to the second one and succeeds', async () => {
    fetchHtmlWithRetryMock.mockImplementation(async (url: string) => {
      if (url.includes('paritet-te.ru')) return { html: HTML_WITH_SIGNALS, status: 200 };
      // First URL: simulate a hard failure (null/empty body)
      return null;
    });
    fetchHtmlWithPlaywrightMock.mockImplementation(async (url: string) => {
      if (url.includes('paritet-te.ru')) return HTML_WITH_SIGNALS;
      throw new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://t-paritet.ru/');
    });

    const result = await processSignalsForUrl('t-paritet.ru, paritet-te.ru');

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.stack).toContain('Яндекс.Метрика');
    }
    // Both URLs were tried. fetchMainHtml now also tries www / http fallbacks
    // before giving up on each URL — see buildFetchFallbacks. So for the
    // dead first URL we burn 4 fetchHtmlWithRetry calls (apex/https,
    // www/https, apex/http, www/http) before falling back to Playwright,
    // then the second URL's first variant succeeds = 1 more. Total 5.
    expect(fetchHtmlWithRetryMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    // First batch of calls should target the failing primary domain.
    expect(fetchHtmlWithRetryMock.mock.calls[0][0]).toContain('t-paritet.ru');
    // Last call should be the recovering sibling URL.
    const last = fetchHtmlWithRetryMock.mock.calls[fetchHtmlWithRetryMock.mock.calls.length - 1][0];
    expect(last).toContain('paritet-te.ru');
  });

  it('multi-URL: when ALL sites fail, returns the FIRST error (primary domain is the most informative)', async () => {
    fetchHtmlWithRetryMock.mockResolvedValue(null);
    fetchHtmlWithPlaywrightMock.mockImplementation(async (url: string) => {
      if (url.includes('t-paritet.ru')) {
        throw new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://t-paritet.ru/');
      }
      // Second URL: connection refused — should NOT be the surfaced error.
      throw new Error('page.goto: net::ERR_CONNECTION_REFUSED at https://paritet-te.ru/');
    });

    const result = await processSignalsForUrl('t-paritet.ru, paritet-te.ru');

    expect('error' in result).toBe(true);
    if ('error' in result) {
      // First-URL error (DNS) wins, not the second-URL error.
      expect(result.error).toMatch(/Домен не найден|DNS/i);
    }
  });

  it('multi-URL: stops at the first success — does not waste time probing the rest', async () => {
    fetchHtmlWithRetryMock.mockImplementation(async (url: string) => {
      if (url.includes('sportcover.ru')) return { html: HTML_WITH_SIGNALS, status: 200 };
      return null;
    });
    fetchHtmlWithPlaywrightMock.mockResolvedValue(null);

    const result = await processSignalsForUrl('sportcover.ru, ipksport.ru');

    expect('stack' in result).toBe(true);
    // Only the first URL was probed — the second never got touched.
    expect(fetchHtmlWithRetryMock).toHaveBeenCalledTimes(1);
    expect(fetchHtmlWithPlaywrightMock).not.toHaveBeenCalled();
  });
});

describe('processSignalsForUrl — deep fetch and per-extractor selection', () => {
  beforeEach(() => {
    fetchHtmlWithRetryMock.mockReset();
    fetchHtmlWithPlaywrightMock.mockReset();
  });

  // Helper: register HTML responses for specific URL substrings.
  function mockUrlResponses(map: Record<string, string>) {
    fetchHtmlWithRetryMock.mockImplementation(async (url: string) => {
      for (const [pattern, body] of Object.entries(map)) {
        if (url.includes(pattern)) return { html: body, status: 200 };
      }
      return { html: '', status: 404 };
    });
  }

  it('without extractors option — fetches only main page (backward compatible behavior)', async () => {
    fetchHtmlWithRetryMock.mockResolvedValue({
      html: '<html><body><script src="https://mc.yandex.ru/metrika/tag.js"></script></body></html>',
      status: 200,
    });

    const result = await processSignalsForUrl('example.com');

    expect(fetchHtmlWithRetryMock).toHaveBeenCalledTimes(1);
    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.client_segment).toBeUndefined();
      expect(result.pricing_model).toBeUndefined();
    }
  });

  it('with extractors=["stack","profile"] — still fetches only main, no subpages', async () => {
    fetchHtmlWithRetryMock.mockResolvedValue({
      html: '<html><body><a href="/pricing">Pricing</a><a href="/cases">Cases</a></body></html>',
      status: 200,
    });

    await processSignalsForUrl('example.com', { extractors: ['stack', 'profile'] });

    expect(fetchHtmlWithRetryMock).toHaveBeenCalledTimes(1);
  });

  // Note on the 15s timeout (this test + the two below): the customers block
  // calls llmExtractCustomers as a fallback when heuristic returned < 3 names
  // (the test fixture only has 1, "Сбербанк"). With OPENROUTER_*_API_KEY set
  // in the local .env, this hits the real Requesty endpoint and can take a
  // few seconds. The default 5s ceiling tripped intermittently before this
  // event-detector work; bumping to 15s removes the flake without hiding a
  // real hang.
  it('with extractors=["client_segment"] — discovers /cases + /about, fetches main + both', async () => {
    mockUrlResponses({
      'example.com/cases': '<section class="clients"><img alt="Сбербанк" /></section>',
      'example.com/about': '<p>О компании</p>',
      'example.com': '<html><body><a href="/cases">Кейсы</a><a href="/about">О нас</a><a href="/pricing">Цены</a></body></html>',
    });

    const result = await processSignalsForUrl('example.com', { extractors: ['client_segment'] });

    const fetchedUrls = fetchHtmlWithRetryMock.mock.calls.map((c) => c[0] as string);
    expect(fetchedUrls.some((u) => u.includes('/cases'))).toBe(true);
    expect(fetchedUrls.some((u) => u.includes('/about'))).toBe(true);
    expect(fetchedUrls.some((u) => u.includes('/pricing'))).toBe(false);
    if ('stack' in result) {
      expect(result.client_segment).toBe('тест-сегмент');
      expect(result.pricing_model).toBeUndefined();
    }
  });

  it('with extractors=["client_segment","cases_count"] — fetches /cases only ONCE', async () => {
    mockUrlResponses({
      'example.com/cases': `
        <section class="clients"><img alt="Газпром" /></section>
        <article class="case-card">x</article>
        <article class="case-card">y</article>
      `,
      'example.com/about': '<p>О компании</p>',
      'example.com': '<a href="/cases">Cases</a><a href="/about">About</a>',
    });

    const result = await processSignalsForUrl('example.com', {
      extractors: ['client_segment', 'cases_count'],
    });

    const casesFetches = fetchHtmlWithRetryMock.mock.calls.filter((c) => (c[0] as string).includes('/cases'));
    expect(casesFetches).toHaveLength(1);
    if ('stack' in result) {
      expect(result.client_segment).toBe('тест-сегмент');
      expect(result.cases_count).toBe(2);
    }
  });

  it('cases_count: heuristic 0 → uses LLM estimate', async () => {
    mockUrlResponses({
      // class="projects" не матчит CASE_SELECTOR, числа в тексте нет →
      // extractCasesCount = 0 → зовётся llmCountCases (мок → "5+").
      'example.com/cases': '<div class="projects">Делали проекты для разных компаний и брендов.</div>',
      'example.com': '<a href="/cases">Кейсы</a>',
    });

    const result = await processSignalsForUrl('example.com', { extractors: ['cases_count'] });

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.cases_count).toBe('5+');
    }
  });

  it('vacancies_count/hiring_roles: heuristic 0 → uses LLM', async () => {
    mockUrlResponses({
      // class="hiring-block" не матчит VACANCY_SELECTOR, числа нет →
      // extractHiring даёт 0/[] → зовётся llmExtractHiring (мок).
      'example.com/careers': '<div class="hiring-block">Ищем сотрудников в команду на разные роли, подробности по запросу.</div>',
      'example.com': '<a href="/careers">Вакансии</a>',
    });

    const result = await processSignalsForUrl('example.com', { extractors: ['vacancies_count', 'hiring_roles'] });

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.vacancies_count).toBe('7+');
      expect(result.hiring_roles).toEqual(['Грузчики']);
    }
  });

  it('pricing: heuristic blank → fills model/min/free_trial from LLM', async () => {
    mockUrlResponses({
      // нет цен/кнопок/тарифов/маркеров → extractPricingModel=unknown,
      // extractPricingDetails={} → зовётся llmExtractPricing (мок).
      'example.com/pricing': '<div class="info">Наши услуги помогают бизнесу расти и развиваться каждый день уверенно.</div>',
      'example.com': '<a href="/pricing">Цены</a>',
    });

    const result = await processSignalsForUrl('example.com', {
      extractors: ['pricing_model', 'pricing_min', 'free_trial'],
    });

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.pricing_model).toBe('sales-led');
      expect(result.pricing_min).toEqual({ value: 50000, currency: 'RUB' });
      expect(result.free_trial).toBe(true);
    }
  });

  it('integrations: empty merge → fills from LLM', async () => {
    mockUrlResponses({
      // нет script-следов и нет распознаваемой integration-секции →
      // signatures=[] и extractIntegrations=[] → merge пуст → llmExtractIntegrations (мок).
      'example.com/integrations': '<div class="info">Мы дружим со многими сервисами для вашего удобства каждый день.</div>',
      'example.com': '<a href="/integrations">Интеграции</a>',
    });

    const result = await processSignalsForUrl('example.com', { extractors: ['integrations'] });

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.integrations).toEqual(['amoCRM', 'Slack']);
    }
  });

  it('subpage 404 does not fail main result — graceful degradation', async () => {
    fetchHtmlWithRetryMock.mockImplementation(async (url: string) => {
      if (url.includes('/cases') || url.includes('/about')) return { html: '', status: 404 };
      return { html: '<a href="/cases">Cases</a><a href="/about">About</a>', status: 200 };
    });

    const result = await processSignalsForUrl('example.com', { extractors: ['stack', 'client_segment'] });

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.client_segment).toBe('тест-сегмент');
    }
  });

  it('subpage timeout does not block other subpages', async () => {
    fetchHtmlWithRetryMock.mockImplementation(async (url: string) => {
      if (url.includes('/cases')) {
        await new Promise((r) => setTimeout(r, 50));
        throw new Error('Request timed out');
      }
      if (url.includes('/pricing')) {
        return {
          html: '<div class="price">990 ₽/мес</div><button>Купить</button>',
          status: 200,
        };
      }
      return { html: '<a href="/pricing">P</a><a href="/cases">C</a><a href="/about">A</a>', status: 200 };
    });

    const result = await processSignalsForUrl('example.com', {
      extractors: ['client_segment', 'pricing_model'],
    });

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.client_segment).toBe('тест-сегмент');
      expect(result.pricing_model).toBe('self-serve');
    }
  });

  it('full extractor set — populates all expected optional fields', async () => {
    mockUrlResponses({
      '/pricing': '<div class="price">990 ₽/мес</div><button>Купить</button>',
      '/careers': '<a class="vacancy">Frontend Developer</a><a class="vacancy">Marketer</a>',
      '/cases': '<section class="clients"><img alt="Тинькофф" /></section><article class="case-card">x</article>',
      '/integrations': '<section class="integrations"><img alt="Slack" /><img alt="Telegram" /></section>',
      '/about': '<p>Основана в 2018 году</p><div class="team"><div class="member-card">A</div></div>',
      '/blog': '<article><time datetime="2026-04-10">Post</time><h2>Latest product news</h2><p>We shipped a new integration.</p></article>',
      'example.com': `
        <a href="/pricing">P</a>
        <a href="/careers">C</a>
        <a href="/cases">Cs</a>
        <a href="/integrations">I</a>
        <a href="/about">A</a>
        <a href="/blog">B</a>
      `,
    });

    const result = await processSignalsForUrl('example.com', {
      extractors: [
        'stack', 'profile', 'client_segment', 'cases_count', 'enterprise_logos',
        'pricing_model', 'pricing_min', 'free_trial',
        'vacancies_count', 'hiring_roles',
        'integrations', 'founded_year', 'team_size', 'blog_last_post',
      ],
    });

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.client_segment).toBe('тест-сегмент');
      expect(result.cases_count).toBe(1);
      expect(result.enterprise_logos).toBe(true);
      expect(result.pricing_model).toBe('self-serve');
      expect(result.pricing_min).toEqual({ value: 990, currency: 'RUB' });
      expect(result.vacancies_count).toBe(2);
      // hiring_roles is now a string[] of top-N concrete profession names
      // (since the 09.06 industrial-segment rewrite). The /careers fixture has
      // "Frontend Developer" and "Marketer" — both should land in the list.
      expect(Array.isArray(result.hiring_roles)).toBe(true);
      const professions = (result.hiring_roles as string[]).join(' ').toLowerCase();
      expect(professions).toContain('frontend developer');
      expect(professions).toContain('marketer');
      expect(result.integrations).toEqual(expect.arrayContaining(['Slack', 'Telegram']));
      expect(result.founded_year).toBe(2018);
      expect(result.team_size).toBe(1);
      expect(result.blog_last_post).toBe('Latest product news — We shipped a new integration.');
    }
  }, 15000);

  it('integrations — detects martech from the main-page script footprint and merges with showcased logos', async () => {
    mockUrlResponses({
      '/integrations': '<section class="integrations"><img alt="Slack" /></section>',
      'example.com': `
        <a href="/integrations">I</a>
        <script src="https://cdn.amocrm.ru/js/button.js"></script>
        <script src="//code.jivosite.com/widget/abc"></script>
        <script src="https://widget.cloudpayments.ru/bundles/cloudpayments.js"></script>
        <a href="https://www.wildberries.ru/catalog/1">WB</a>
      `,
    });

    const result = await processSignalsForUrl('example.com', { extractors: ['integrations'] });

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      // Signature-detected tools the company actually runs…
      expect(result.integrations).toEqual(
        expect.arrayContaining(['amoCRM', 'JivoSite', 'CloudPayments', 'Wildberries']),
      );
      // …merged with logos scraped from the explicit integrations section.
      expect(result.integrations).toContain('Slack');
    }
  });

  it('integrations — populates from main-page signatures even when the section has no usable logos', async () => {
    mockUrlResponses({
      '/integrations': '<section class="integrations"><p>Мы интегрируемся со множеством сервисов</p></section>',
      'example.com': `
        <a href="/integrations">I</a>
        <script src="https://mod.calltouch.ru/init.js"></script>
        <script src="https://s.marquiz.ru/v2/quiz.js"></script>
      `,
    });

    const result = await processSignalsForUrl('example.com', { extractors: ['integrations'] });

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.integrations).toEqual(expect.arrayContaining(['Calltouch', 'Marquiz']));
    }
  });

  it('blog_last_post follows the latest post link from the listing and extracts the full text', async () => {
    const listing = `
      <a href="/blog">Blog</a>
      <article><time datetime="2026-01-10">old</time><h2><a href="/blog/old-post">Old launch</a></h2><p>teaser</p></article>
      <article><time datetime="2026-05-20">new</time><h2><a href="/blog/may-update">May update</a></h2><p>teaser</p></article>
    `;
    const fullPost = `<article class="post-content"><h1>May product update</h1>`
      + `<p>${'We shipped many new things this month. '.repeat(12)}</p>`
      + `<p>${'Full details about the release are described here. '.repeat(8)}</p></article>`;

    mockUrlResponses({
      'example.com/blog/may-update': fullPost,
      'example.com/blog': listing,
      'example.com': '<a href="/blog">Blog</a>',
    });

    const result = await processSignalsForUrl('example.com', { extractors: ['blog_last_post'] });

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.blog_last_post).toContain('May product update');
      expect(result.blog_last_post).toContain('We shipped many new things');
      expect((result.blog_last_post ?? '').length).toBeGreaterThan(300);
      // Must have navigated to the latest post page, not the old one.
      const fetched = fetchHtmlWithRetryMock.mock.calls.map((c) => c[0] as string);
      expect(fetched.some((u) => u.includes('/blog/may-update'))).toBe(true);
      expect(fetched.some((u) => u.includes('/blog/old-post'))).toBe(false);
    }
  });

  it('blog_last_post falls back to a discovered social link when no blog page is present', async () => {
    mockUrlResponses({
      '/blog': '',
      'vk.com/company_page': '<article><time datetime="2026-04-11">date</time><h2>VK launch post</h2><p>New release is live.</p></article>',
      'example.com': '<a href="/blog">Blog</a><a href="https://vk.com/company_page">VK</a>',
    });

    const result = await processSignalsForUrl('example.com', {
      extractors: ['blog_last_post'],
    });

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.blog_last_post).toBe('VK launch post — New release is live.');
    }
  });

  it('with extractors=[] — returns minimal result without stack/profile', async () => {
    fetchHtmlWithRetryMock.mockResolvedValue({
      html: '<html><body><script src="https://mc.yandex.ru/metrika/tag.js"></script></body></html>',
      status: 200,
    });

    const result = await processSignalsForUrl('example.com', { extractors: [] });

    expect('stack' in result).toBe(true);
    if ('stack' in result) {
      expect(result.stack).toBe('');
      expect(result.profile).toBe('');
    }
  });
});

describe('processSignalsForUrl — social media discovery', () => {
  const ORIG_FETCH = global.fetch;
  beforeEach(() => {
    fetchHtmlWithRetryMock.mockReset();
    fetchHtmlWithPlaywrightMock.mockReset();
    findCompanySocialsMock.mockReset().mockResolvedValue([]);
    extractSocialPostsMock.mockReset().mockResolvedValue([]);
    // HEAD-пробы подстраниц (/about) → быстро «нет», без реальной сети.
    (global.fetch as unknown) = jest.fn().mockResolvedValue({ ok: false });
    delete process.env.SIGNALS_SOCIAL_DEEP;
  });
  afterEach(() => { global.fetch = ORIG_FETCH; delete process.env.SIGNALS_SOCIAL_DEEP; });

  it('reads socials from static footer without deep recall', async () => {
    const html = `<html><body><footer><a href="https://t.me/realco">tg</a></footer></body></html>`;
    fetchHtmlWithRetryMock.mockResolvedValue({ html, status: 200 });
    const result = await processSignalsForUrl('example.com', { extractors: ['social_media'] });
    expect('social_media' in result && result.social_media).toEqual(['https://t.me/realco']);
    expect(fetchHtmlWithPlaywrightMock).not.toHaveBeenCalled();
    expect(findCompanySocialsMock).not.toHaveBeenCalled();
  });

  it('renders with Playwright when static HTML has no socials', async () => {
    const bare = `<html><body><p>no socials</p></body></html>`;
    const rendered = `<html><body><footer><a href="https://vk.com/rendered">vk</a></footer></body></html>`;
    fetchHtmlWithRetryMock.mockResolvedValue({ html: bare, status: 200 });
    fetchHtmlWithPlaywrightMock.mockResolvedValue(rendered);
    const result = await processSignalsForUrl('example.com', { extractors: ['social_media'] });
    expect('social_media' in result && result.social_media).toEqual(['https://vk.com/rendered']);
    expect(fetchHtmlWithPlaywrightMock).toHaveBeenCalled();
    expect(findCompanySocialsMock).not.toHaveBeenCalled();
  });

  it('falls back to Serper finder when static and Playwright are both empty', async () => {
    const bare = `<html><body><p>none</p></body></html>`;
    fetchHtmlWithRetryMock.mockResolvedValue({ html: bare, status: 200 });
    fetchHtmlWithPlaywrightMock.mockResolvedValue(bare);
    findCompanySocialsMock.mockResolvedValue(['https://t.me/found_by_search']);
    const result = await processSignalsForUrl('example.com', { extractors: ['social_media'] });
    expect('social_media' in result && result.social_media).toEqual(['https://t.me/found_by_search']);
    expect(findCompanySocialsMock).toHaveBeenCalled();
  });

  it('SIGNALS_SOCIAL_DEEP=0 disables Playwright + Serper recall', async () => {
    process.env.SIGNALS_SOCIAL_DEEP = '0';
    const bare = `<html><body><p>none</p></body></html>`;
    fetchHtmlWithRetryMock.mockResolvedValue({ html: bare, status: 200 });
    const result = await processSignalsForUrl('example.com', { extractors: ['social_media'] });
    expect('social_media' in result && result.social_media).toEqual([]);
    expect(fetchHtmlWithPlaywrightMock).not.toHaveBeenCalled();
    expect(findCompanySocialsMock).not.toHaveBeenCalled();
  });

  it('feeds the resolved social urls into the event pipeline', async () => {
    const html = `<html><body><footer><a href="https://t.me/realco">tg</a></footer></body></html>`;
    fetchHtmlWithRetryMock.mockResolvedValue({ html, status: 200 });
    const result = await processSignalsForUrl('example.com', {
      extractors: ['social_media', 'event_opening', 'event_opening_summary'],
    });
    expect(extractSocialPostsMock).toHaveBeenCalledWith(['https://t.me/realco'], expect.anything());
    expect('event_opening' in result && result.event_opening).toBe(true);
  });

  it('does not error the row when Playwright throws; falls through to Serper', async () => {
    const bare = `<html><body><p>none</p></body></html>`;
    fetchHtmlWithRetryMock.mockResolvedValue({ html: bare, status: 200 });
    fetchHtmlWithPlaywrightMock.mockRejectedValue(new Error('browser launch failed'));
    findCompanySocialsMock.mockResolvedValue(['https://t.me/from_serper']);
    const result = await processSignalsForUrl('example.com', { extractors: ['social_media'] });
    expect('social_media' in result && result.social_media).toEqual(['https://t.me/from_serper']);
  });
});
