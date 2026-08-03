/**
 * @jest-environment node
 *
 * Конструктор баз ENG-локали (job.locale='en'; такие джобы создаёт Движок
 * вертикалей). Механика локали:
 *   - EN-алиасы заголовков → канонические английские колонки;
 *   - имена служебных колонок по локали («Found Email» / «Description»);
 *   - EN-блокировка job-бордов (linkedin/indeed/glassdoor/wellfound);
 *   - доп. ролевые префиксы (legal@/privacy@/abuse@) только для en;
 *   - Accept-Language и приоритет EN-путей страниц в скрапере.
 * Ключевой инвариант: RU-поведение по умолчанию (locale отсутствует / 'ru')
 * НЕ меняется — это проверяется симметричными кейсами ниже.
 */

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: () => ({}) },
}));

import {
  applyColumnMapping,
  mergeFoundEmailColumn,
  normalizeEnHeaders,
} from '@/lib/tools/baseConstructorWorker';
import {
  FOUND_EMAIL_COL,
  FOUND_EMAIL_COL_EN,
  descriptionColForLocale,
  foundEmailColForLocale,
  isNonScrapeableHost,
  normalizeConstructorLocale,
  stepFindEmails,
  stepRemoveSupportEmails,
} from '@/lib/tools/processingSteps';
import { scrapeEmails } from '@/lib/enrich/emailScraper';

const noop = async () => {};

describe('normalizeConstructorLocale', () => {
  it('только "en" активирует EN-локаль; всё остальное — ru (обратная совместимость)', () => {
    expect(normalizeConstructorLocale('en')).toBe('en');
    expect(normalizeConstructorLocale('ru')).toBe('ru');
    expect(normalizeConstructorLocale(undefined)).toBe('ru');
    expect(normalizeConstructorLocale(null)).toBe('ru');
    expect(normalizeConstructorLocale('EN')).toBe('ru'); // строгое сравнение, мусор → ru
  });
});

describe('EN-алиасы канонических колонок (baseConstructorWorker)', () => {
  it('normalizeEnHeaders резолвит английские заголовки в канонические', () => {
    const data = [
      ['Company Name', 'Organization', 'URL', 'E-Mail', 'Description', 'Industry', 'Country', 'City'],
      ['Acme', 'Acme Inc', 'acme.com', 'a@acme.com', 'Widgets', 'SaaS', 'USA', 'Austin'],
    ];
    const out = normalizeEnHeaders(data);
    // 'Organization' НЕ переименовывается в 'Company' — каноническая колонка
    // уже занята ('Company Name' → 'Company'), иначе было бы две 'Company'.
    expect(out[0]).toEqual([
      'Company', 'Organization', 'Website', 'Email', 'Description', 'Industry', 'Country', 'City',
    ]);
    expect(out[1]).toEqual(data[1]); // тело не трогаем
  });

  it('normalizeEnHeaders резолвит website-алиасы (site/domain/url) и mail', () => {
    const out = normalizeEnHeaders([['Site', 'Domain', 'Mail'], ['x.com', 'y.com', 'a@x.com']]);
    expect(out[0]).toEqual(['Website', 'Domain', 'Email']);
  });

  it('normalizeEnHeaders не плодит дубли и не трогает неизвестные заголовки', () => {
    const data = [['Company', 'Company Name', 'Notes'], ['A', 'A Inc', 'n']];
    const out = normalizeEnHeaders(data);
    expect(out[0]).toEqual(['Company', 'Company Name', 'Notes']);
  });

  it('normalizeEnHeaders — no-op для пустых данных', () => {
    expect(normalizeEnHeaders([])).toEqual([]);
  });

  it('applyColumnMapping: locale="en" переименовывает в английские канонические имена', () => {
    const data = [
      ['Organization', 'Site', 'E-Mail'],
      ['Acme', 'acme.com', 'a@acme.com'],
    ];
    const mapping = JSON.stringify({ company: 'Organization', site: 'Site', email: 'E-Mail' });
    const out = applyColumnMapping(data, mapping, 'en');
    expect(out[0]).toEqual(['Company', 'Website', 'Email']);
  });

  it('applyColumnMapping: без локали — прежние RU-канонические имена (неизменно)', () => {
    const data = [
      ['Organization', 'Site', 'E-Mail'],
      ['Acme', 'acme.com', 'a@acme.com'],
    ];
    const mapping = JSON.stringify({ company: 'Organization', site: 'Site', email: 'E-Mail' });
    const out = applyColumnMapping(data, mapping);
    expect(out[0]).toEqual(['компания', 'сайт', 'email']);
  });
});

describe('Имена служебных колонок по локали', () => {
  it('foundEmailColForLocale: en → "Found Email", default/ru → "Найденный Email"', () => {
    expect(foundEmailColForLocale('en')).toBe('Found Email');
    expect(foundEmailColForLocale('en')).toBe(FOUND_EMAIL_COL_EN);
    expect(foundEmailColForLocale('ru')).toBe(FOUND_EMAIL_COL);
    expect(foundEmailColForLocale(undefined)).toBe(FOUND_EMAIL_COL);
    expect(FOUND_EMAIL_COL).toBe('Найденный Email'); // RU-константа неизменна
  });

  it('descriptionColForLocale: en → "Description", default/ru → "Описание"', () => {
    expect(descriptionColForLocale('en')).toBe('Description');
    expect(descriptionColForLocale('ru')).toBe('Описание');
    expect(descriptionColForLocale(undefined)).toBe('Описание');
  });

  it('stepFindEmails target=separate при locale="en" создаёт колонку "Found Email"', async () => {
    // Сайт-колонка есть, но URL пустые → скрапить нечего, сеть не нужна:
    // проверяем чисто механику создания target-колонки.
    const data = [
      ['Company', 'Email', 'Website'],
      ['Acme', 'orig@acme.com', ''],
    ];
    const out = await stepFindEmails(data, noop, undefined, { target: 'separate', locale: 'en' });
    expect(out[0]).toEqual(['Company', 'Email', 'Website', 'Found Email']);
    expect(out[1]).toEqual(['Acme', 'orig@acme.com', '', '']);
  });

  it('stepFindEmails target=separate без локали — прежняя колонка "Найденный Email"', async () => {
    const data = [
      ['Компания', 'Email', 'Сайт'],
      ['Акме', 'orig@acme.ru', ''],
    ];
    const out = await stepFindEmails(data, noop, undefined, { target: 'separate' });
    expect(out[0]).toEqual(['Компания', 'Email', 'Сайт', 'Найденный Email']);
  });

  it('mergeFoundEmailColumn при locale="en" мерджит "Found Email" в исходную колонку', () => {
    const data = [
      ['Company', 'Email', 'Found Email'],
      ['Acme', 'orig@acme.com', 'found@acme.com'],
    ];
    const out = mergeFoundEmailColumn(data, 'en');
    expect(out[0]).toEqual(['Company', 'Email']);
    expect(out[1]).toEqual(['Acme', 'orig@acme.com, found@acme.com']);
  });

  it('mergeFoundEmailColumn без локали НЕ трогает "Found Email" (RU-поведение неизменно)', () => {
    const data = [
      ['Company', 'Email', 'Found Email'],
      ['Acme', 'orig@acme.com', 'found@acme.com'],
    ];
    const out = mergeFoundEmailColumn(data);
    expect(out).toEqual(data); // для RU "Found Email" — чужая колонка, no-op
  });
});

describe('NON_SCRAPEABLE_HOSTS по локали', () => {
  it('locale="en" дополнительно блокирует linkedin/indeed/glassdoor/wellfound', () => {
    for (const u of [
      'linkedin.com', 'https://www.linkedin.com/company/acme', 'de.linkedin.com',
      'indeed.com', 'https://www.indeed.com/jobs?q=x',
      'glassdoor.com', 'https://glassdoor.com/Overview/x.htm',
      'wellfound.com', 'https://wellfound.com/company/acme',
    ]) {
      expect(isNonScrapeableHost(u, 'en')).toBe(true);
    }
  });

  it('без локали EN-борды НЕ блокируются (RU-поведение неизменно)', () => {
    for (const u of ['linkedin.com', 'indeed.com', 'glassdoor.com', 'wellfound.com']) {
      expect(isNonScrapeableHost(u)).toBe(false);
      expect(isNonScrapeableHost(u, 'ru')).toBe(false);
    }
  });

  it('hh.ru и прочие RU-борды блокируются в обеих локалях; обычные сайты — нет', () => {
    expect(isNonScrapeableHost('hh.ru', 'en')).toBe(true);
    expect(isNonScrapeableHost('spb.hh.ru', 'en')).toBe(true);
    expect(isNonScrapeableHost('company.com', 'en')).toBe(false);
    expect(isNonScrapeableHost('mylinkedin.com', 'en')).toBe(false); // look-alike не цепляем
  });
});

describe('remove_support_emails: доп. префиксы по локали', () => {
  const enData = [
    ['Company', 'Email'],
    ['A', 'legal@x.com'],   // en: drop
    ['B', 'privacy@x.com'], // en: drop
    ['C', 'abuse@x.com'],   // en: drop (и в ru тоже — уже в базовом списке)
    ['D', 'info@x.com'],    // keep — «хороший» общий ящик
    ['E', 'sales@x.com'],   // keep
    ['F', 'hello@x.com'],   // keep
    ['G', 'ivan@x.com'],    // keep — персональный
  ];

  it('locale="en" выкидывает legal@/privacy@/abuse@, info@/sales@/hello@ остаются', async () => {
    const out = await stepRemoveSupportEmails(enData, noop, { locale: 'en' });
    expect(out.map((r) => r[0])).toEqual(['Company', 'D', 'E', 'F', 'G']);
  });

  it('без локали legal@/privacy@ ОСТАЮТСЯ (RU-поведение неизменно), abuse@ выкидывается как раньше', async () => {
    const out = await stepRemoveSupportEmails(enData, noop);
    expect(out.map((r) => r[0])).toEqual(['Company', 'A', 'B', 'D', 'E', 'F', 'G']);
  });
});

describe('scrapeEmails: локаль в опциях (мок fetch)', () => {
  const HTML_NO_EMAIL = '<html><head><title>Acme</title></head><body><p>Hello</p></body></html>';
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest
      .spyOn(global as unknown as { fetch: typeof fetch }, 'fetch')
      .mockImplementation(async () =>
        new Response(HTML_NO_EMAIL, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      );
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  function acceptLanguageOfFirstCall(): string {
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    return (init.headers as Record<string, string>)['Accept-Language'];
  }

  it('locale="en" → Accept-Language "en-US,en" и приоритет EN-путей (/contact первым)', async () => {
    const res = await scrapeEmails('https://acme.com', { locale: 'en', maxPages: 4, timeout: 500 });
    expect(acceptLanguageOfFirstCall()).toBe('en-US,en');
    // [0] — главная; дальше EN-приоритетные пути в заданном порядке.
    expect(res.checkedUrls[1]).toBe('https://acme.com/contact');
    expect(res.checkedUrls[2]).toBe('https://acme.com/contact-us');
    expect(res.checkedUrls[3]).toBe('https://acme.com/about');
  });

  it('без локали → прежний RU Accept-Language и прежний порядок путей (/contacts первым)', async () => {
    const res = await scrapeEmails('https://acme.com', { maxPages: 4, timeout: 500 });
    expect(acceptLanguageOfFirstCall()).toBe('ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7');
    expect(res.checkedUrls[1]).toBe('https://acme.com/contacts');
  });

  it('RU-пути остаются доступны при locale="en" (после EN-приоритетных)', async () => {
    const res = await scrapeEmails('https://acme.com', { locale: 'en', maxPages: 12, timeout: 500 });
    expect(res.checkedUrls).toContain('https://acme.com/contacts');
    expect(res.checkedUrls).toContain('https://acme.com/kontakty');
    // EN-приоритетные идут раньше RU-путей в обходе
    expect(res.checkedUrls.indexOf('https://acme.com/contact'))
      .toBeLessThan(res.checkedUrls.indexOf('https://acme.com/kontakty'));
  });
});

describe('stepFindEmails пробрасывает locale в скрапер (мок fetch)', () => {
  it('locale="en" из опций шага доезжает до Accept-Language запроса', async () => {
    const fetchMock = jest
      .spyOn(global as unknown as { fetch: typeof fetch }, 'fetch')
      .mockImplementation(async () =>
        new Response('<html><body><a href="mailto:hello@acme.com">mail</a></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      );
    try {
      const data = [
        ['Company', 'Website'],
        ['Acme', 'acme.com'],
      ];
      const out = await stepFindEmails(data, noop, undefined, { locale: 'en' });
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>)['Accept-Language']).toBe('en-US,en');
      // email со скрапа записался в созданную колонку Email
      expect(out[0]).toEqual(['Company', 'Website', 'Email']);
      expect(out[1][2]).toBe('hello@acme.com');
    } finally {
      fetchMock.mockRestore();
    }
  });
});
