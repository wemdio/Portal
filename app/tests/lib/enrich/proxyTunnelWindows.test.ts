/** @jest-environment node */

/**
 * Срок туннеля у ограниченного агента общий для всех чтений через него.
 * Короче окна вызывающего его делать нельзя: медленный, но рабочий туннель
 * (нода отвечает на CONNECT только после того, как сама дозвонилась до
 * сайта) обрывался бы раньше, чем вызывающий сам бросил бы чтение. Как агент
 * держит срок, проверяет стенд boundedProxyAgent.test.ts; здесь — какой срок
 * выбирают те, кто его создаёт.
 */
const NODE = 'http://user:pass@203.0.113.10:62780';
const ENV = ['YANDEXMAPS_PROXY_URLS_PRIORITY', 'YANDEXMAPS_PROXY_URLS', 'PROXY_URLS', 'HH_PROXY_URL',
  'HH_REQUEST_TIMEOUT_MS', 'HH_VACANCY_REQUEST_TIMEOUT_MS', 'HH_EMPLOYER_REQUEST_TIMEOUT_MS'] as const;
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));

function mockFactory() {
  const factory = jest.fn((_uri: string, _opts: object) => ({ destroy: jest.fn(async () => undefined) }));
  jest.doMock('@/lib/enrich/boundedProxyAgent', () => ({
    ...jest.requireActual('@/lib/enrich/boundedProxyAgent'),
    createBoundedProxyAgent: factory,
  }));
  return factory;
}

beforeEach(() => {
  for (const name of ENV) delete process.env[name];
});
afterEach(() => {
  jest.dontMock('@/lib/enrich/boundedProxyAgent');
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

it('общий пул (websiteParser, emailScraper): 15 с — самое длинное окно страницы у читающих через него', async () => {
  // websiteEnrichmentWorker — 15 с (WEBSITE_ENRICHMENT_TIMEOUT_MS),
  // fetchAndExtract(…, { timeout: 15_000 }) — processingSteps, dfybWorker, api/enrich.
  process.env.YANDEXMAPS_PROXY_URLS_PRIORITY = JSON.stringify([NODE]);
  await jest.isolateModulesAsync(async () => {
    const factory = mockFactory();
    const pool = await import('@/lib/enrich/proxyPool');
    pool.resetProxyGroupsCache();
    expect(await pool.getProxyDispatcher(true)).toBeDefined();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0][0]).toBe(NODE);
    expect(factory.mock.calls[0][1]).toEqual(expect.objectContaining({ tunnelTimeoutMs: 15_000 }));
  });
});

it('hh.ru через PROXY_URLS (парсер hh, досье VE2): срок — самое длинное окно запроса hhParser, 30 с по умолчанию', () => {
  process.env.PROXY_URLS = JSON.stringify([NODE]);
  jest.isolateModules(() => {
    const factory = mockFactory();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@/lib/parsers/hhParser');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]).toEqual([NODE, { tunnelTimeoutMs: 30_000 }]);
  });
});

it('hh.ru: окно запроса поднято через env — срок туннеля поднимается вместе с ним', () => {
  process.env.PROXY_URLS = JSON.stringify([NODE]);
  process.env.HH_EMPLOYER_REQUEST_TIMEOUT_MS = '45000';
  jest.isolateModules(() => {
    const factory = mockFactory();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@/lib/parsers/hhParser');
    expect(factory.mock.calls[0]).toEqual([NODE, { tunnelTimeoutMs: 45_000 }]);
  });
});

it('TLS к сайту через туннель — в сроке туннеля и не дольше прежних 10 с undici (проверка настроек)', () => {
  jest.isolateModules(() => {
    const created: Array<Record<string, unknown>> = [];
    jest.doMock('undici', () => ({
      ...jest.requireActual('undici'),
      ProxyAgent: jest.fn(function (options: Record<string, unknown>) { created.push(options); }),
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createBoundedProxyAgent } = require('@/lib/enrich/boundedProxyAgent') as typeof import('@/lib/enrich/boundedProxyAgent');
    createBoundedProxyAgent(NODE, { tunnelTimeoutMs: 30_000 });
    createBoundedProxyAgent(NODE, { tunnelTimeoutMs: 5_000 });
    expect(created.map((options) => [options.proxyTls, options.requestTls])).toEqual([
      [{ timeout: 3_000 }, { timeout: 10_000 }],
      [{ timeout: 3_000 }, { timeout: 5_000 }],
    ]);
  });
  jest.dontMock('undici');
});
