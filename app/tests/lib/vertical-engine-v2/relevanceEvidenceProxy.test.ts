/** @jest-environment node */

/**
 * Прод читает сайты из США (HOSTKEY, Нью-Йорк). Замер 22.09 по доменам с
 * ярлыком «сайт не ответил»: своя главная, которая молчит нашему адресу или
 * отвечает ему 403, через RU-прокси открывается примерно в каждом десятом
 * случае (5–6 из 56–60) за 1–3 с. Половина воспроизводимых таймаутов — чужие
 * каталоги из поиска (audit-it, cntd), им повтор не помогает, а /contacts на
 * хосте с молчащей главной молчит 10 раз из 10. Главные ИНН владельца почти
 * не печатают (0 из 17), поэтому у спасённой главной тем же путём читаются
 * реквизиты. Прокси при этом не открывает около трети сайтов, которые напрямую
 * отвечают, а первый таймаут на проде часто даёт нагрузка: на таймаут второй
 * заход — прямой повтор и прокси в одном окне. Под тестом: второй заход, его
 * лимиты и то, когда ярлык таймаута честен.
 *
 * Домены и их поведение взяты из разобранных случаев; ИНН там, где он
 * известен из базы, настоящий, остальные условные.
 */
import { fetchVeRelevanceEvidence, type VeEvidenceRoute } from '@/lib/verticalEngineV2/relevanceEvidence';
import { parseVeEvidencePage, type VeEvidencePage } from '@/lib/verticalEngineV2/relevancePage';
import { VeOperationTimeoutError } from '@/lib/verticalEngineV2/operationDeadline';
import { proxySlotsInFlight, reportProxyNodeResult, resetProxyGroupsCache, resetProxyNodeHealth, tryAcquireProxySlot } from '@/lib/enrich/proxyPool';
import { ProxyTunnelError } from '@/lib/enrich/boundedProxyAgent';
import { veCompanyFactKey, veFactPageKey } from '@/lib/verticalEngineV2/companyFacts';

const mockTransport = {
  resolve: jest.fn(async (_hostname: string): Promise<string[]> => ['93.184.216.34']),
  fetch: jest.fn(),
};
jest.mock('node:dns/promises', () => {
  const actual = jest.requireActual('node:dns/promises');
  class Resolver {
    resolve4(hostname: string) { return mockTransport.resolve(hostname); }
    cancel() {}
  }
  return { ...actual, Resolver };
});
jest.mock('undici', () => {
  const actual = jest.requireActual('undici');
  class Agent {
    destroyed = false;
    async destroy() { this.destroyed = true; }
  }
  class ProxyAgent {
    destroyed = false;
    constructor(readonly options: unknown) {}
    async destroy() { this.destroyed = true; }
  }
  class Pool {
    constructor(readonly origin: unknown, readonly options: Record<string, unknown>) {}
  }
  return { ...actual, Agent, ProxyAgent, Pool, fetch: (url: string, init: unknown) => mockTransport.fetch(url, init) };
});
// Лимит пропусков читается при загрузке модуля. Тесты считают его по
// умолчанию (6), даже если в окружении процесса задан свой.
jest.mock('@/lib/enrich/proxyPool', () => {
  const saved = process.env.ENRICH_PROXY_RETRY_CONCURRENCY;
  delete process.env.ENRICH_PROXY_RETRY_CONCURRENCY;
  try {
    const actual = jest.requireActual('@/lib/enrich/proxyPool');
    return { ...actual, tryAcquireProxySlot: jest.fn(actual.tryAcquireProxySlot) };
  } finally {
    if (saved !== undefined) process.env.ENRICH_PROXY_RETRY_CONCURRENCY = saved;
  }
});

const FOCUS = 'производство продуктов питания';
const html = (url: string, body: string): VeEvidencePage =>
  parseVeEvidencePage(Buffer.from(body), url, 'text/html; charset=utf-8', FOCUS);
const homeWithInn = (inn: string) => `<title>Собственное производство</title><main><p>Мы выпускаем продукты питания
  на собственном производстве и поставляем их в магазины области.</p></main><footer>Реквизиты: ИНН ${inn}</footer>`;
const pageTimeout = () => new VeOperationTimeoutError('relevance evidence page', 5_000);
const code = (message: string, errorCode: string) => new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code: errorCode }) });
const noSearch = () => jest.fn(async () => []);

// ООО «Добродар» (база «Кондитерские»): главная молчит нашему адресу 15 с,
// через RU-прокси отвечает за 3,2 с; /contacts напрямую тоже молчит.
const DOBRODAR = { companyInn: '5436109541', companyName: 'ООО "ДОБРОДАР"',
  companyAddress: '633623, Новосибирская обл., Сузунский м.о., рп. Сузун, ул. Ленина, зд. 22В', focus: FOCUS };

type Call = { url: string; route: VeEvidenceRoute };
function recorder(handler: (url: string, route: VeEvidenceRoute) => VeEvidencePage | Promise<VeEvidencePage>) {
  const calls: Call[] = [];
  const fetchPage = jest.fn(async (url: string, _signal: AbortSignal, route?: VeEvidenceRoute) => {
    // Без маршрута (старый контракт) заход прямой.
    calls.push({ url, route: route ?? 'direct' });
    return handler(url, route ?? 'direct');
  });
  return { calls, fetchPage };
}

// Любая из трёх переменных включает пул (без приоритетной приоритетом
// становятся остальные), а next/jest подгружает ../.env: чистим все три.
const PROXY_ENV = ['YANDEXMAPS_PROXY_URLS_PRIORITY', 'YANDEXMAPS_PROXY_URLS', 'PROXY_URLS'] as const;
const originalEnv = Object.fromEntries(PROXY_ENV.map((name) => [name, process.env[name]]));
const RU_NODE = 'http://user:pass@ru-proxy.invalid:8000';
const setPool = (configured: boolean) => {
  for (const name of PROXY_ENV) delete process.env[name];
  if (configured) process.env.YANDEXMAPS_PROXY_URLS_PRIORITY = JSON.stringify([RU_NODE]);
  resetProxyGroupsCache();
};
const originalRetry = process.env.VE_EVIDENCE_PROXY_RETRY;
/** Нода трижды подряд закрыла CONNECT без ответа и выбыла. */
const tripNode = () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  for (let i = 0; i < 3; i += 1) reportProxyNodeResult(RU_NODE, 'down', 'UND_ERR_SOCKET');
  warn.mockRestore();
};
// Ошибки fetch из undici, как их видит читатель: код — в cause.
const tunnelClosed = () => new TypeError('fetch failed', { cause: new ProxyTunnelError('proxy_tunnel_failed: UND_ERR_SOCKET',
  { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }) });
const connectAnswered = (status: number) => new TypeError('fetch failed',
  { cause: Object.assign(new Error(`Proxy response (${status}) !== 200 when HTTP Tunneling`), { code: 'UND_ERR_ABORTED' }) });

beforeEach(() => {
  // Повтор через прокси включён по умолчанию; выключатель — отдельные тесты ниже.
  delete process.env.VE_EVIDENCE_PROXY_RETRY;
  resetProxyNodeHealth();
  setPool(true);
  mockTransport.resolve.mockReset().mockResolvedValue(['93.184.216.34']);
  mockTransport.fetch.mockReset();
});
afterEach(() => {
  if (originalRetry === undefined) delete process.env.VE_EVIDENCE_PROXY_RETRY;
  else process.env.VE_EVIDENCE_PROXY_RETRY = originalRetry;
  resetProxyNodeHealth();
  // Пропуск в пул возвращается всегда, в том числе после сбоя прокси.
  expect(proxySlotsInFlight()).toBe(0);
  for (const name of PROXY_ENV) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
  resetProxyGroupsCache();
});

// sibdobrodar.ru в замере: главная без ИНН владельца, /contacts через прокси
// ответил 200 за 2,8 с. ИНН на странице контактов — условие теста.
const DOBRODAR_HOME = `<title>Сибирский хлеб</title><main><p>Выпекаем хлеб и кондитерские изделия
  на собственном производстве и поставляем их в магазины области.</p><a href="/contacts">Контакты</a></main>`;
const DOBRODAR_CONTACTS = `<title>Контакты</title><main><p>ООО «Добродар», рп. Сузун, ул. Ленина, 22В.</p></main>
  <footer>ИНН ${DOBRODAR.companyInn}</footer>`;

describe('второй заход через RU-прокси', () => {
  it('своя главная молчит нашему адресу: главная и реквизиты читаются через прокси и подтверждают компанию', async () => {
    jest.useFakeTimers();
    try {
      const slotsDuringProxy: number[] = [];
      const { calls, fetchPage } = recorder((url, route) => {
        // Прямые заходы висят до постраничного дедлайна, как в замере.
        if (route === 'direct') return new Promise<never>(() => {});
        slotsDuringProxy.push(proxySlotsInFlight());
        if (url === 'https://sibdobrodar.ru/') return html(url, DOBRODAR_HOME);
        if (url === 'https://sibdobrodar.ru/contacts') return html(url, DOBRODAR_CONTACTS);
        throw new Error('website_content_unavailable');
      });
      const pending = fetchVeRelevanceEvidence('sibdobrodar.ru', { ...DOBRODAR, fetchPage, search: noSearch() as never });
      await jest.advanceTimersByTimeAsync(5_001);
      const result = await pending;
      expect(result.status).toBe('ok');
      expect(result.reason).toBe('identity_verified_website');
      // Второй заход — прямой повтор и прокси в одном окне; ответил прокси.
      // Страницы деятельности напрямую промолчали бы так же — их не читаем.
      expect(calls).toEqual([
        { url: 'https://sibdobrodar.ru/', route: 'direct' },
        { url: 'https://sibdobrodar.ru/', route: 'direct' },
        { url: 'https://sibdobrodar.ru/', route: 'proxy' },
        { url: 'https://sibdobrodar.ru/contacts', route: 'proxy' },
      ]);
      expect(result.proxy).toEqual({ attempts: 2, rescued: 1, verified: 1, denied: 0 });
      // Каждый заход держит один пропуск и отдаёт его.
      expect(slotsDuringProxy).toEqual([1, 1]);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('ИНН уже на главной, открытой через прокси: больше ни одного запроса к сайту', async () => {
    const { calls, fetchPage } = recorder((url, route) => {
      if (route === 'direct') throw pageTimeout();
      return html(url, homeWithInn(DOBRODAR.companyInn));
    });
    const result = await fetchVeRelevanceEvidence('sibdobrodar.ru', { ...DOBRODAR, fetchPage, search: noSearch() as never });
    expect(result.reason).toBe('identity_verified_website');
    expect(calls).toEqual([
      { url: 'https://sibdobrodar.ru/', route: 'direct' },
      { url: 'https://sibdobrodar.ru/', route: 'direct' },
      { url: 'https://sibdobrodar.ru/', route: 'proxy' },
    ]);
    expect(result.proxy).toEqual({ attempts: 1, rescued: 1, verified: 1, denied: 0 });
  });

  it('спасённая главная без текста: спасение в телеметрии есть, пользы нет', async () => {
    const { fetchPage } = recorder((url, route) => {
      if (route === 'direct') throw pageTimeout();
      return html(url, `<footer>ИНН ${DOBRODAR.companyInn}</footer>`);
    });
    const result = await fetchVeRelevanceEvidence('sibdobrodar.ru', { ...DOBRODAR, fetchPage, search: noSearch() as never });
    expect(result.status).toBe('unavailable');
    expect(result.proxy).toEqual({ attempts: 1, rescued: 1, verified: 0, denied: 0 });
  });

  it('спасённая главная не подтвердилась, компанию подтвердил сайт из поиска: пользы прокси нет', async () => {
    const { fetchPage } = recorder((url, route) => {
      if (url === 'https://sibdobrodar.ru/') {
        if (route === 'direct') throw pageTimeout();
        return html(url, DOBRODAR_HOME);
      }
      if (url === 'https://found-bakery.ru/') {
        return html(url, `<main><p>Выпекаем хлеб и кондитерские изделия на собственном производстве.</p></main><footer>ИНН ${DOBRODAR.companyInn}</footer>`);
      }
      throw pageTimeout();
    });
    const result = await fetchVeRelevanceEvidence('sibdobrodar.ru', { ...DOBRODAR, fetchPage,
      search: jest.fn(async () => [{ link: 'https://found-bakery.ru/' }]) as never });
    expect(result.reason).toBe('discovered_verified_website');
    // proxyVerified считается по спасённому хосту, а не по любому тексту.
    expect(result.proxy).toEqual(expect.objectContaining({ rescued: 1, verified: 0 }));
  });

  it('реквизиты спасённой главной не ответили и через прокси: не больше трёх запросов через прокси, напрямую ничего', async () => {
    const { calls, fetchPage } = recorder((url, route) => {
      if (url === 'https://sibdobrodar.ru/' && route === 'proxy') {
        return html(url, `${DOBRODAR_HOME}<nav><a href="/rekvizity">Реквизиты</a><a href="/o-kompanii">О компании</a></nav>`);
      }
      throw pageTimeout();
    });
    const result = await fetchVeRelevanceEvidence('sibdobrodar.ru', { ...DOBRODAR, fetchPage, search: noSearch() as never });
    // Напрямую — только главная: первый заход и повтор в окне прокси.
    expect(calls.filter((call) => call.route === 'direct')).toEqual([
      { url: 'https://sibdobrodar.ru/', route: 'direct' },
      { url: 'https://sibdobrodar.ru/', route: 'direct' },
    ]);
    expect(calls.filter((call) => call.route === 'proxy')).toHaveLength(3);
    expect(result.proxy).toEqual({ attempts: 3, rescued: 1, verified: 0, denied: 0 });
    // Сайт через прокси ответил — это частичное чтение, ответ окончательный.
    expect(result.reason).toBe('website_identity_unverified');
  });

  it('на реквизиты молчащего сайта не хватило пропуска: напрямую не читаем, ярлык — таймаут, гейт повторит', async () => {
    const { calls, fetchPage } = recorder((url, route) => {
      if (route === 'direct') throw pageTimeout();
      // Пока шла главная, пропуска разобрали другие компании.
      jest.mocked(tryAcquireProxySlot).mockReturnValueOnce(null);
      return html(url, DOBRODAR_HOME);
    });
    const result = await fetchVeRelevanceEvidence('sibdobrodar.ru', { ...DOBRODAR, fetchPage, search: noSearch() as never });
    expect(calls).toEqual([
      { url: 'https://sibdobrodar.ru/', route: 'direct' },
      { url: 'https://sibdobrodar.ru/', route: 'direct' },
      { url: 'https://sibdobrodar.ru/', route: 'proxy' },
    ]);
    expect(result.proxy).toEqual({ attempts: 1, rescued: 1, verified: 0, denied: 1 });
    // Отказ в пропуске — наш лимит, а не ответ сайта: окончательного «не
    // подтверждено» по нему не ставим.
    expect(result.reason).toBe('website_evidence_timeout');
  });

  it('все RU-ноды выбыли: пропуск не берётся, свой молчащий сайт получает прямой повтор и ярлык таймаута', async () => {
    tripNode();
    jest.mocked(tryAcquireProxySlot).mockClear();
    const { calls, fetchPage } = recorder(() => { throw pageTimeout(); });
    const result = await fetchVeRelevanceEvidence('konfetkavpk.ru', {
      companyInn: '5023005244', focus: FOCUS, fetchPage, search: noSearch() as never,
    });
    expect(tryAcquireProxySlot).not.toHaveBeenCalled();
    expect(calls).toEqual([
      { url: 'https://konfetkavpk.ru/', route: 'direct' },
      { url: 'https://konfetkavpk.ru/', route: 'direct' },
    ]);
    // Нет живой ноды — наш предел, а не ответ сайта: гейт повторит компанию.
    expect(result.reason).toBe('website_evidence_timeout');
    expect(result.proxy).toEqual({ attempts: 0, rescued: 0, verified: 0, denied: 0, unavailable: 1 });
  });

  it('нода выбыла, пока читалась главная: реквизиты молчащего сайта не читаются, ярлык — таймаут', async () => {
    // Три ссылки на реквизиты: без выхода из цикла по «нет живой ноды» каждая
    // считалась бы ещё одним unavailable.
    const home = `${DOBRODAR_HOME}<nav><a href="/rekvizity">Реквизиты</a><a href="/o-kompanii">О компании</a></nav>`;
    const { calls, fetchPage } = recorder((url, route) => {
      if (route === 'direct') throw pageTimeout();
      tripNode();
      return html(url, home);
    });
    const result = await fetchVeRelevanceEvidence('sibdobrodar.ru', { ...DOBRODAR, fetchPage, search: noSearch() as never });
    expect(calls).toEqual([
      { url: 'https://sibdobrodar.ru/', route: 'direct' },
      { url: 'https://sibdobrodar.ru/', route: 'direct' },
      { url: 'https://sibdobrodar.ru/', route: 'proxy' },
    ]);
    expect(result.reason).toBe('website_evidence_timeout');
    expect(result.proxy).toEqual({ attempts: 1, rescued: 1, verified: 0, denied: 0, unavailable: 1 });
  });

  it('нода закрыла CONNECT без ответа в гонке с прямым повтором: сбой прокси в телеметрии, ярлык — таймаут', async () => {
    const { calls, fetchPage } = recorder((_url, route) => { throw route === 'proxy' ? tunnelClosed() : pageTimeout(); });
    const result = await fetchVeRelevanceEvidence('konfetkavpk.ru', {
      companyInn: '5023005244', focus: FOCUS, fetchPage, search: noSearch() as never,
    });
    expect(calls.map((call) => call.route)).toEqual(['direct', 'direct', 'proxy']);
    expect(result.reason).toBe('website_evidence_timeout');
    expect(result.proxy).toEqual({ attempts: 1, rescued: 0, verified: 0, denied: 0, failed: 1 });
  });

  it('сертификат сайта через прокси не принят: это ответ сайта, а не сбой прокси', async () => {
    const { calls, fetchPage } = recorder((_url, route) => {
      throw route === 'proxy' ? code('certificate has expired', 'CERT_HAS_EXPIRED') : pageTimeout();
    });
    const result = await fetchVeRelevanceEvidence('konfetkavpk.ru', {
      companyInn: '5023005244', focus: FOCUS, fetchPage, search: noSearch() as never,
    });
    expect(calls.map((call) => call.route)).toEqual(['direct', 'direct', 'proxy']);
    expect(result.proxy).toEqual({ attempts: 1, rescued: 0, verified: 0, denied: 0 });
  });

  // Вину ноды по закрытию CONNECT без ответа метит сам транспорт (стенд в
  // relevanceEvidenceProxyTunnel.test.ts); 407 узнаётся по тексту undici.
  it.each([
    ['нода не пустила по паролю (407): сайт не отвечал, ярлык — таймаут', 407, 'website_evidence_timeout'],
    ['502 на CONNECT — голос сайта за нодой: ответ окончательный', 502, 'website_identity_unverified'],
  ])('реквизиты сайта, открытого только через прокси: %s', async (_label, status, reason) => {
    const { calls, fetchPage } = recorder((url, route) => {
      if (route === 'direct') throw pageTimeout();
      if (url === 'https://sibdobrodar.ru/') return html(url, DOBRODAR_HOME);
      throw connectAnswered(status);
    });
    const result = await fetchVeRelevanceEvidence('sibdobrodar.ru', { ...DOBRODAR, fetchPage, search: noSearch() as never });
    expect(calls.filter((call) => call.route === 'proxy').map((call) => call.url))
      .toEqual(['https://sibdobrodar.ru/', 'https://sibdobrodar.ru/contacts']);
    expect(result.proxy).toEqual({ attempts: 2, rescued: 1, verified: 0, denied: 0, failed: 1 });
    expect(result.reason).toBe(reason);
  });

  it('первый таймаут от нагрузки: прямой повтор идёт вместе с прокси и открывает сайт, который через прокси висит', async () => {
    // meatfresh.ru в замере: напрямую главная открывается за 5 с, через
    // RU-прокси висит 15 с. На проде первый заход промолчал под нагрузкой.
    jest.useFakeTimers();
    try {
      const INN = '7707083893';
      const calls: Call[] = [];
      const proxySignals: AbortSignal[] = [];
      let homeReads = 0;
      const fetchPage = jest.fn(async (url: string, signal: AbortSignal, route?: VeEvidenceRoute) => {
        calls.push({ url, route: route ?? 'direct' });
        if (route === 'proxy') { proxySignals.push(signal); return new Promise<never>(() => {}); }
        if (url !== 'https://meatfresh.ru/') throw new Error('website_content_unavailable');
        if (++homeReads === 1) return new Promise<never>(() => {});
        return html(url, `<title>Митфреш</title><main><p>Производство мясных полуфабрикатов на собственном заводе.</p></main>
          <footer>ИНН ${INN}</footer>`);
      });
      const pending = fetchVeRelevanceEvidence('meatfresh.ru', { companyInn: INN, focus: FOCUS, fetchPage, search: noSearch() as never });
      await jest.advanceTimersByTimeAsync(5_001);
      const result = await pending;
      expect(result.reason).toBe('identity_verified_website');
      expect(calls.slice(0, 3)).toEqual([
        { url: 'https://meatfresh.ru/', route: 'direct' },
        { url: 'https://meatfresh.ru/', route: 'direct' },
        { url: 'https://meatfresh.ru/', route: 'proxy' },
      ]);
      // Проигравший заход через прокси отменён, пропуск отдан.
      expect(proxySignals).toHaveLength(1);
      expect(proxySignals[0].aborted).toBe(true);
      // Сайт ответил напрямую: страницы деятельности читаются напрямую, как раньше.
      expect(calls.length).toBeGreaterThan(3);
      expect(calls.slice(3).every((call) => call.route === 'direct')).toBe(true);
      expect(result.proxy).toEqual({ attempts: 1, rescued: 0, verified: 0, denied: 0 });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  // sibdobrodar.ru на проде (база f1bb9ccf): главная промолчала 5 с, прямой
  // повтор открыл её за 2,6 с — раньше прокси (3,2 с). /contacts напрямую
  // молчит, через прокси отвечает 200 за 2,8 с. Хост тот же, что у сайта,
  // спасённого прокси, хоть гонку за главную и выиграл прямой повтор.
  it.each([
    ['пул настроен', 'pool', 'identity_verified_website'],
    ['пула нет', 'none', 'website_evidence_timeout'],
    ['пропуска в пул нет', 'no-slot', 'website_evidence_timeout'],
  ] as const)('%s: главная открылась прямым повтором после молчания, реквизиты — гонкой прямого и прокси', async (_label, mode, reason) => {
    setPool(mode !== 'none');
    const acquire = jest.mocked(tryAcquireProxySlot);
    const actualAcquire = acquire.getMockImplementation();
    if (mode === 'no-slot') acquire.mockImplementation(() => null);
    jest.useFakeTimers();
    try {
      const later = <T>(ms: number, value: () => T) => new Promise<T>((resolve) => setTimeout(() => resolve(value()), ms));
      let homeDirect = 0;
      const { calls, fetchPage } = recorder((url, route) => {
        if (url === 'https://sibdobrodar.ru/') {
          if (route === 'proxy') return later(3_165, () => html(url, DOBRODAR_HOME));
          return ++homeDirect === 1 ? new Promise<never>(() => {}) : later(2_598, () => html(url, DOBRODAR_HOME));
        }
        if (url === 'https://sibdobrodar.ru/contacts' && route === 'proxy') return later(2_760, () => html(url, DOBRODAR_CONTACTS));
        // Остальное напрямую молчит, как в замере.
        if (route === 'direct') return new Promise<never>(() => {});
        throw new Error('website_content_unavailable');
      });
      const pending = fetchVeRelevanceEvidence('sibdobrodar.ru', { ...DOBRODAR, fetchPage, search: noSearch() as never });
      await jest.advanceTimersByTimeAsync(130_000);
      const result = await pending;
      expect(result.reason).toBe(reason);
      expect(result.timeout).toBe('page');
      if (mode === 'pool') {
        expect(result.status).toBe('ok');
        expect(calls.slice(0, 5)).toEqual([
          { url: 'https://sibdobrodar.ru/', route: 'direct' },
          { url: 'https://sibdobrodar.ru/', route: 'direct' },
          { url: 'https://sibdobrodar.ru/', route: 'proxy' },
          { url: 'https://sibdobrodar.ru/contacts', route: 'direct' },
          { url: 'https://sibdobrodar.ru/contacts', route: 'proxy' },
        ]);
        // Страницы деятельности живого напрямую сайта читаются напрямую, как раньше.
        expect(calls.slice(5).every((call) => call.route === 'direct')).toBe(true);
        // Главную принёс прямой повтор, реквизиты — прокси.
        expect(result.proxy).toEqual({ attempts: 2, rescued: 0, verified: 1, denied: 0 });
      } else {
        // Без прокси реквизиты читаются напрямую, как до правки, и молчат:
        // это наш предел, а не ответ сайта — гейт повторит компанию.
        expect(calls.every((call) => call.route === 'direct')).toBe(true);
        expect(calls.filter((call) => call.url === 'https://sibdobrodar.ru/contacts')).toHaveLength(2);
        expect(result.proxy).toEqual(mode === 'no-slot' ? { attempts: 0, rescued: 0, verified: 0, denied: 2 } : undefined);
      }
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
      acquire.mockImplementation(actualAcquire);
    }
  });

  it('быстрые отказы соседних своих доменов не отнимают у молчащего домена второй заход', async () => {
    // ООО «Пэтрон»: hyleys.ru и hyleys.com отвергают соединение и съедают оба
    // повтора, пока hyleys-shop.ru молчит 5 с.
    jest.useFakeTimers();
    try {
      const INN = '7710321259';
      const { calls, fetchPage } = recorder((url, route) => {
        if (url.startsWith('https://hyleys.ru/') || url.startsWith('https://hyleys.com/')) throw code('connect ECONNREFUSED 185.1.1.1:443', 'ECONNREFUSED');
        if (url !== 'https://hyleys-shop.ru/') throw new Error('website_content_unavailable');
        if (route === 'direct') return new Promise<never>(() => {});
        return html(url, `<title>Хайлис</title><main><p>Кондитерская фабрика: торты и пирожные.</p></main><footer>ИНН ${INN}</footer>`);
      });
      const pending = fetchVeRelevanceEvidence('hyleys.ru, hyleys.com, hyleys-shop.ru', {
        companyInn: INN, focus: FOCUS, fetchPage, search: noSearch() as never,
      });
      await jest.advanceTimersByTimeAsync(5_001);
      const result = await pending;
      expect(calls.filter((call) => call.url === 'https://hyleys.ru/')).toHaveLength(2);
      expect(calls.filter((call) => call.url === 'https://hyleys.com/')).toHaveLength(2);
      expect(calls).toContainEqual({ url: 'https://hyleys-shop.ru/', route: 'proxy' });
      expect(result.reason).toBe('identity_verified_website');
      expect(result.proxy).toEqual({ attempts: 1, rescued: 1, verified: 1, denied: 0 });
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([403, 429])('главная отвечает %i нашему адресу: заход через прокси', async (status) => {
    // rossetimr.ru: 403 напрямую, через RU-прокси 200 за 0,9 с.
    const { calls, fetchPage } = recorder((url, route) => {
      if (route === 'direct') throw new Error(`website_blocked_http_${status}`);
      return html(url, homeWithInn('7700000001'));
    });
    const result = await fetchVeRelevanceEvidence('https://rossetimr.ru', {
      companyInn: '7700000001', focus: FOCUS, fetchPage, search: noSearch() as never,
    });
    expect(result.status).toBe('ok');
    expect(calls.slice(0, 2)).toEqual([
      { url: 'https://rossetimr.ru/', route: 'direct' },
      { url: 'https://rossetimr.ru/', route: 'proxy' },
    ]);
    expect(calls.filter((call) => call.route === 'proxy')).toHaveLength(1);
    // Отказ по адресу быстрый: страницы деятельности читаются напрямую, как раньше.
    expect(calls.slice(2).length).toBeGreaterThan(0);
    expect(calls.slice(2).every((call) => call.route === 'direct' && call.url.startsWith('https://rossetimr.ru/'))).toBe(true);
    expect(result.proxy).toEqual({ attempts: 1, rescued: 1, verified: 1, denied: 0 });
  });

  // rossetimr.ru: главная без ИНН, ИНН только на /contacts (так у 17 из 17
  // главных в замере).
  const ROSSETI_HOME = `<title>Россети</title><main><p>Выпекаем хлеб и кондитерские изделия
    на собственном производстве и поставляем их в магазины области.</p><a href="/contacts">Контакты</a></main>`;
  const rossetiContacts = (inn: string) => `<title>Контакты</title><main><p>Реквизиты компании.</p></main><footer>ИНН ${inn}</footer>`;

  it('после 403 главная без ИНН: реквизиты читаются через прокси и подтверждают компанию', async () => {
    const INN = '7700000001';
    const { calls, fetchPage } = recorder((url, route) => {
      if (route === 'direct' && ['https://rossetimr.ru/', 'https://rossetimr.ru/contacts'].includes(url)) throw new Error('website_blocked_http_403');
      if (url === 'https://rossetimr.ru/') return html(url, ROSSETI_HOME);
      if (url === 'https://rossetimr.ru/contacts') return html(url, rossetiContacts(INN));
      throw new Error('website_content_unavailable');
    });
    const result = await fetchVeRelevanceEvidence('https://rossetimr.ru', { companyInn: INN, focus: FOCUS, fetchPage, search: noSearch() as never });
    expect(result.reason).toBe('identity_verified_website');
    expect(calls).toContainEqual({ url: 'https://rossetimr.ru/contacts', route: 'proxy' });
    expect(calls).not.toContainEqual({ url: 'https://rossetimr.ru/contacts', route: 'direct' });
    expect(result.proxy).toEqual({ attempts: 2, rescued: 1, verified: 1, denied: 0 });
  });

  it.each([
    ['не хватило пропуска', 'denied', { attempts: 1, rescued: 1, verified: 1, denied: 1 }],
    ['прокси не открыл страницу', 'failed', { attempts: 2, rescued: 1, verified: 1, denied: 0 }],
    // Нода выбыла, пока читалась главная: это не нехватка пропуска.
    ['нет живой ноды', 'unavailable', { attempts: 1, rescued: 1, verified: 1, denied: 0, unavailable: 1 }],
  ])('после 403 реквизиты без прокси (%s) читаются напрямую, как раньше', async (_label, kind, telemetry) => {
    // 403 бывает только на главной: напрямую /contacts отвечает, как без пула.
    const INN = '7700000001';
    const { calls, fetchPage } = recorder((url, route) => {
      if (url === 'https://rossetimr.ru/') {
        if (route === 'direct') throw new Error('website_blocked_http_403');
        if (kind === 'denied') jest.mocked(tryAcquireProxySlot).mockReturnValueOnce(null);
        if (kind === 'unavailable') tripNode();
        return html(url, ROSSETI_HOME);
      }
      if (url === 'https://rossetimr.ru/contacts') {
        if (route === 'proxy') throw pageTimeout();
        return html(url, rossetiContacts(INN));
      }
      throw new Error('website_content_unavailable');
    });
    const result = await fetchVeRelevanceEvidence('https://rossetimr.ru', { companyInn: INN, focus: FOCUS, fetchPage, search: noSearch() as never });
    expect(calls).toContainEqual({ url: 'https://rossetimr.ru/contacts', route: 'direct' });
    expect(result.reason).toBe('identity_verified_website');
    expect(result.proxy).toEqual(telemetry);
  });

  it('после 403 три захода через прокси исчерпаны: следующая страница идёт напрямую по лимиту, даже если нода уже выбыла', async () => {
    const INN = '7700000001';
    let proxyReads = 0;
    const { calls, fetchPage } = recorder((url, route) => {
      if (url === 'https://rossetimr.ru/') {
        if (route === 'direct') throw new Error('website_blocked_http_403');
        proxyReads += 1;
        return html(url, `${ROSSETI_HOME}<nav><a href="/rekvizity">Реквизиты</a><a href="/o-kompanii">О компании</a></nav>`);
      }
      if (route === 'direct') return html(url, rossetiContacts(INN));
      // Третий заход через прокси — последний по лимиту; после него нода выбывает.
      proxyReads += 1;
      if (proxyReads === 3) tripNode();
      return html(url, '<title>Страница</title><main><p>Реквизиты компании.</p></main>');
    });
    const result = await fetchVeRelevanceEvidence('https://rossetimr.ru', { companyInn: INN, focus: FOCUS, fetchPage, search: noSearch() as never });
    expect(calls.slice(0, 5)).toEqual([
      { url: 'https://rossetimr.ru/', route: 'direct' },
      { url: 'https://rossetimr.ru/', route: 'proxy' },
      { url: 'https://rossetimr.ru/rekvizity', route: 'proxy' },
      { url: 'https://rossetimr.ru/contacts', route: 'proxy' },
      { url: 'https://rossetimr.ru/o-kompanii', route: 'direct' },
    ]);
    expect(result.reason).toBe('identity_verified_website');
    // Прямой заход — из-за лимита, а не из-за выбывшей ноды: unavailable нет.
    expect(result.proxy).toEqual({ attempts: 3, rescued: 1, verified: 1, denied: 0 });
  });

  it('403 напрямую, через прокси молчание: сайт ответил сам, ответ окончательный', async () => {
    const { calls, fetchPage } = recorder((_url, route) => {
      throw route === 'proxy' ? pageTimeout() : new Error('website_blocked_http_403');
    });
    const result = await fetchVeRelevanceEvidence('https://rossetimr.ru', {
      companyInn: '7700000001', focus: FOCUS, fetchPage, search: noSearch() as never,
    });
    expect(calls.filter((call) => call.url === 'https://rossetimr.ru/')).toEqual([
      { url: 'https://rossetimr.ru/', route: 'direct' },
      { url: 'https://rossetimr.ru/', route: 'proxy' },
    ]);
    expect(result.reason).toBe('website_identity_unverified');
    expect(result.timeout).toBe('page');
  });

  it('без настроенного пула на 403 повтора нет, как и раньше', async () => {
    setPool(false);
    const { calls, fetchPage } = recorder(() => { throw new Error('website_blocked_http_403'); });
    const result = await fetchVeRelevanceEvidence('https://rossetimr.ru', {
      companyInn: '7700000001', focus: FOCUS, fetchPage, search: noSearch() as never,
    });
    expect(calls.filter((call) => call.url === 'https://rossetimr.ru/')).toEqual([{ url: 'https://rossetimr.ru/', route: 'direct' }]);
    expect(result.reason).not.toBe('website_evidence_timeout');
    expect(result.proxy).toBeUndefined();
  });

  it.each([
    ['404 или не-HTML', () => { throw new Error('website_content_unavailable'); }],
    ['слишком большая страница', () => { throw new Error('website_content_too_large'); }],
    ['редирект на чужой сайт', () => { throw new Error('website_redirect_unavailable'); }],
    ['адаптер вернул чужой адрес', () => html('https://all.accor.com/', homeWithInn('7700000001'))],
  ])('%s: прокси не нужен, сайт ответил сам', async (_label, answer) => {
    const { calls, fetchPage } = recorder((url) => (url === 'https://ibisomsk.ru/' ? answer() : html(url, '<p>Страница</p>')));
    const result = await fetchVeRelevanceEvidence('https://ibisomsk.ru', {
      companyInn: '5504011650', focus: FOCUS, fetchPage, search: noSearch() as never,
    });
    expect(calls.some((call) => call.route === 'proxy')).toBe(false);
    expect(result.proxy).toBeUndefined();
    expect(result.reason).toBe('website_identity_unverified');
  });

  it('все пропуска в пул заняты: прежний прямой повтор, отказ виден в телеметрии', async () => {
    const taken: Array<() => void> = [];
    // Лимит на процесс — ENRICH_PROXY_RETRY_CONCURRENCY, по умолчанию 6.
    for (let slot = tryAcquireProxySlot(); slot; slot = tryAcquireProxySlot()) taken.push(slot);
    try {
      let answered = false;
      const { calls, fetchPage } = recorder((url) => {
        if (url !== 'https://sibdobrodar.ru/') throw pageTimeout();
        // Повтор тем же маршрутом: второй прямой заход отвечает.
        if (!answered) { answered = true; throw pageTimeout(); }
        return html(url, homeWithInn(DOBRODAR.companyInn));
      });
      const result = await fetchVeRelevanceEvidence('https://sibdobrodar.ru', { ...DOBRODAR, fetchPage, search: noSearch() as never });
      expect(calls.slice(0, 2)).toEqual([
        { url: 'https://sibdobrodar.ru/', route: 'direct' },
        { url: 'https://sibdobrodar.ru/', route: 'direct' },
      ]);
      expect(calls.some((call) => call.route === 'proxy')).toBe(false);
      expect(result.status).toBe('ok');
      expect(result.proxy).toEqual({ attempts: 0, rescued: 0, verified: 0, denied: 1 });
      expect(proxySlotsInFlight()).toBe(taken.length);
    } finally {
      taken.forEach((release) => release());
    }
  });

  it('два своих домена молчат: через прокси идёт ровно один запрос на компанию', async () => {
    const { calls, fetchPage } = recorder(() => { throw pageTimeout(); });
    const result = await fetchVeRelevanceEvidence('https://romashka.ru, https://romashka-mebel.ru', {
      companyInn: '7700000001', focus: FOCUS, fetchPage, search: noSearch() as never,
    });
    expect(calls.filter((call) => call.route === 'proxy')).toHaveLength(1);
    expect(result.reason).toBe('website_evidence_timeout');
    expect(result.proxy).toEqual({ attempts: 1, rescued: 0, verified: 0, denied: 0 });
  });

  it('заход через прокси укладывается в те же 5 с, что и прямой', async () => {
    jest.useFakeTimers();
    try {
      const { calls, fetchPage } = recorder(() => new Promise<never>(() => {}));
      let settled = false;
      const pending = fetchVeRelevanceEvidence('https://konfetkavpk.ru', {
        companyInn: '5023005244', focus: FOCUS, fetchPage, search: noSearch() as never,
      }).finally(() => { settled = true; });
      await jest.advanceTimersByTimeAsync(5_050);
      expect(settled).toBe(false);
      // Прямой повтор и прокси стартуют вместе, в одном окне.
      expect(calls.map((call) => call.route)).toEqual(['direct', 'direct', 'proxy']);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(true);
      const result = await pending;
      expect(result.reason).toBe('website_evidence_timeout');
      expect(calls.map((call) => call.route)).toEqual(['direct', 'direct', 'proxy']);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('заход через прокси тратит общий бюджет повторов', async () => {
    // Свой сайт молчит напрямую, на повторе и через прокси (одно окно —
    // повтор 1 из 2). Главная
    // найденного сайта отвечает со второго раза (повтор 2 из 2), и его
    // /contacts повтора уже не получает.
    let foundHome = 0;
    const { calls, fetchPage } = recorder((url) => {
      if (url === 'https://found.ru/' && ++foundHome > 1) return html(url, '<main><p>Кондитерская фабрика, торты и пирожные.</p></main>');
      throw pageTimeout();
    });
    await fetchVeRelevanceEvidence('https://konfetkavpk.ru', {
      companyInn: '5023005244', focus: FOCUS, fetchPage, search: jest.fn(async () => [{ link: 'https://found.ru/' }]) as never,
    });
    expect(calls.filter((call) => call.url === 'https://konfetkavpk.ru/').map((call) => call.route)).toEqual(['direct', 'direct', 'proxy']);
    expect(calls.filter((call) => call.url === 'https://found.ru/')).toHaveLength(2);
    expect(calls.filter((call) => call.url === 'https://found.ru/contacts')).toHaveLength(1);
  });
});

describe('сбой внутренней страницы не хоронит живой сайт', () => {
  // Главная прочитана без ИНН, /contacts промолчал (под нагрузкой). Поиск
  // приводит на страницу реквизитов того же сайта: она подтверждает компанию,
  // и страницы деятельности читаются, как раньше. Так бывает часто: у
  // найденных поиском подтверждённых сайтов хост совпадает с сайтом из
  // источника примерно в половине случаев.
  it.each([
    ['пул настроен', true],
    ['пула нет', false],
  ])('%s: реквизиты того же хоста из поиска ведут к страницам деятельности', async (_label, pool) => {
    setPool(pool);
    const INN = '6950015687';
    const { calls, fetchPage } = recorder((url) => {
      if (url === 'https://morozoff-prod.ru/') return html(url, '<title>Морозофф</title><main><p>Пельмени и выпечка.</p><a href="/katalog/torty">Торты</a></main>');
      if (url === 'https://morozoff-prod.ru/contacts') throw pageTimeout();
      if (url === 'https://morozoff-prod.ru/rekvizity') {
        return html(url, `<title>Реквизиты</title><main><p>Реквизиты компании.</p><a href="/katalog/torty">Торты</a></main><footer>ИНН ${INN}</footer>`);
      }
      if (url === 'https://morozoff-prod.ru/katalog/torty') {
        return html(url, '<main><p>Кондитерские изделия: торты и пирожные собственного производства.</p></main>');
      }
      throw new Error('website_content_unavailable');
    });
    const result = await fetchVeRelevanceEvidence('morozoff-prod.ru', {
      companyInn: INN, companyName: 'ООО "МОРОЗОФФ"', companyAddress: 'г. Тверь', focus: FOCUS,
      fetchPage, search: jest.fn(async () => [{ link: 'https://morozoff-prod.ru/rekvizity' }]) as never,
    });
    expect(result.status).toBe('ok');
    expect(result.reason).toBe('discovered_verified_website');
    expect(result.text).toContain('URL: https://morozoff-prod.ru/katalog/torty');
    expect(calls.some((call) => call.url === 'https://morozoff-prod.ru/katalog/torty')).toBe(true);
    expect(calls.some((call) => call.route === 'proxy')).toBe(false);
  });
});

describe('главная ответила сама — хост не мёртвый, реквизиты читаются как раньше', () => {
  // Мёртвым считается только хост, чья главная напрямую молчит или рвёт
  // соединение. Ответ самого сайта (статус, не-HTML, размер) — живой хост.
  it.each([
    ['404 или не-HTML', 'website_content_unavailable', false],
    ['слишком большая', 'website_content_too_large', false],
    ['503', 'website_transient_http_503', false],
    ['403 без пула', 'website_blocked_http_403', false],
    ['403, прокси промолчал', 'website_blocked_http_403', true],
  ])('%s: /contacts с ИНН читается напрямую и подтверждает компанию', async (_label, answer, pool) => {
    setPool(pool);
    const INN = '7700000001';
    const { calls, fetchPage } = recorder((url, route) => {
      if (route === 'proxy') throw pageTimeout();
      if (url === 'https://romashka.ru/') throw new Error(answer);
      if (url === 'https://romashka.ru/contacts') {
        return html(url, `<main><p>Выпускаем продукты питания на собственном производстве.</p></main><footer>ИНН ${INN}</footer>`);
      }
      throw new Error('website_content_unavailable');
    });
    const result = await fetchVeRelevanceEvidence('https://romashka.ru', { companyInn: INN, focus: FOCUS, fetchPage, search: noSearch() as never });
    expect(calls).toContainEqual({ url: 'https://romashka.ru/contacts', route: 'direct' });
    expect(result.reason).toBe('identity_verified_website');
  });
});

describe('память фактов при молчащей главной', () => {
  // Своя главная молчит, а подтверждённые реквизиты того же хоста лежат в
  // памяти фактов (30 суток). Их читаем без сети, как раньше: мёртвый хост
  // отменяет только сетевые чтения. На проде так у ~4% пар «компания–хост».
  const contactsUrl = 'https://sibdobrodar.ru/contacts';
  const remembered = html(contactsUrl, `<title>Контакты</title><main><p>ООО «Добродар»: выпекаем хлеб и кондитерские изделия
    на собственном производстве, рп. Сузун, ул. Ленина, 22В.</p></main><footer>ИНН ${DOBRODAR.companyInn}</footer>`);
  const companyFacts = {
    read: (async () => [{
      company_key: veCompanyFactKey({ inn: DOBRODAR.companyInn }), page_key: veFactPageKey(contactsUrl), reader_version: 1,
      observed_at: new Date(Date.now() - 86_400_000).toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      page: { url: contactsUrl, text: remembered.text, inns: remembered.inns, ownerInns: remembered.ownerInns,
        document: { text: remembered.text.repeat(3), links: [] } },
    }]) as never,
    write: jest.fn(async () => undefined) as never,
  };

  it.each([
    ['пул настроен', true],
    ['пула нет', false],
  ])('%s: реквизиты из памяти подтверждают компанию, по сети — только главная', async (_label, pool) => {
    setPool(pool);
    const { calls, fetchPage } = recorder(() => { throw pageTimeout(); });
    const result = await fetchVeRelevanceEvidence('sibdobrodar.ru', { ...DOBRODAR, fetchPage, companyFacts, search: noSearch() as never });
    expect(remembered.ownerInns).toEqual([DOBRODAR.companyInn]);
    expect(result.status).toBe('ok');
    expect(result.reason).toBe('identity_verified_website');
    // /contacts взят из памяти, страницы деятельности молчащего хоста не читаются.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.url === 'https://sibdobrodar.ru/')).toBe(true);
  });
});

describe('ярлык таймаута — только для молчащего собственного сайта', () => {
  it('свой домен мёртв, молчит только каталог из поиска: ответ окончательный, прокси не нужен', async () => {
    // ООО «Джи Эл Эс Фармасьютикалз»: manoren.ru не резолвится, поиск приносит
    // audit-it.ru, который молчит нашему адресу. Раньше это был «таймаут» и
    // повторный круг гейта, хотя повтор каталога ничего не даёт.
    const audit = 'https://www.audit-it.ru/contragent/1157746509612_ooo-dzhi-el-es-farmasyutikalz';
    const search = jest.fn(async () => [{ link: audit }]);
    const { calls, fetchPage } = recorder((url) => {
      if (url.startsWith('https://manoren.ru/')) throw Object.assign(new Error('queryA ENOTFOUND manoren.ru'), { code: 'ENOTFOUND' });
      throw pageTimeout();
    });
    const result = await fetchVeRelevanceEvidence('manoren.ru', {
      companyInn: '7729463120', companyName: 'ООО "ДЖИ ЭЛ ЭС ФАРМАСЬЮТИКАЛЗ"',
      companyAddress: '143130, Московская обл., Рузский м.о., пгт. Тучково, Восточный мкр., д. 6/1', focus: FOCUS,
      fetchPage, search: search as never,
    });
    expect(result.reason).toBe('website_identity_unverified');
    expect(result.timeout).toBe('page');
    expect(search).toHaveBeenCalledTimes(1);
    expect(calls.some((call) => call.route === 'proxy')).toBe(false);
    // /contacts молчащего и мёртвого хоста не читается.
    expect(calls.map((call) => call.url)).toEqual(['https://manoren.ru/', audit, audit]);
  });

  it('частично прочитанный сайт получает окончательный ответ, а не «таймаут»', async () => {
    // Главная прочитана, ИНН на ней нет, /contacts молчит, поиск пуст.
    const { fetchPage } = recorder((url) => {
      if (url === 'https://sibdobrodar.ru/') return html(url, '<main><p>Продукты питания собственного производства.</p></main>');
      throw pageTimeout();
    });
    const result = await fetchVeRelevanceEvidence('https://sibdobrodar.ru', { ...DOBRODAR, fetchPage, search: noSearch() as never });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('website_identity_unverified');
    // Телеметрия по-прежнему видит молчащую страницу.
    expect(result.timeout).toBe('page');
  });

  it('молчащая страница услуг не отменяет готовый текст', async () => {
    const { fetchPage } = recorder((url) => {
      if (url.endsWith('/uslugi/konditerskie')) throw pageTimeout();
      if (url === 'https://sibdobrodar.ru/') return html(url, `${homeWithInn(DOBRODAR.companyInn)}
        <nav><a href="/uslugi/khleb">Производство хлеба</a><a href="/uslugi/konditerskie">Кондитерские изделия</a></nav>`);
      return html(url, '<main><p>Выпекаем хлеб на собственном производстве каждый день.</p></main>');
    });
    const result = await fetchVeRelevanceEvidence('https://sibdobrodar.ru', { ...DOBRODAR, fetchPage, search: noSearch() as never });
    expect(result.status).toBe('ok');
    expect(result.reason).toBe('identity_verified_website');
    expect(result.timeout).toBe('page');
  });

  it('свой сайт молчит и напрямую, и через прокси: таймаут, /contacts не читается', async () => {
    // ООО «ВПК»: konfetkavpk.ru и его /contacts молчали по 5 с на каждый заход.
    const { calls, fetchPage } = recorder(() => { throw pageTimeout(); });
    const result = await fetchVeRelevanceEvidence('konfetkavpk.ru', {
      companyInn: '5023005244', companyName: 'ООО "ВПК"',
      companyAddress: '141290, Московская обл., Пушкинский г.о., г. Красноармейск, ул. Свердлова, д. 10', focus: FOCUS,
      fetchPage, search: noSearch() as never,
    });
    expect(result.reason).toBe('website_evidence_timeout');
    expect(result.timeout).toBe('page');
    expect(calls).toEqual([
      { url: 'https://konfetkavpk.ru/', route: 'direct' },
      { url: 'https://konfetkavpk.ru/', route: 'direct' },
      { url: 'https://konfetkavpk.ru/', route: 'proxy' },
    ]);
  });

  it('свой сайт прочитан, но истёк общий дедлайн: таймаут, компания получит повтор', async () => {
    // Своя главная и /contacts отвечают за 4,5 с без ИНН, поиск — за 89 с,
    // все три найденных домена молчат. Общий дедлайн 120 с кончается на них.
    jest.useFakeTimers();
    try {
      const later = <T>(ms: number, value: () => T) => new Promise<T>((resolve) => setTimeout(() => resolve(value()), ms));
      const { fetchPage } = recorder((url) => (url.startsWith('https://romashka.ru/')
        ? later(4_500, () => html(url, '<main><p>Производим продукты питания.</p></main>'))
        : new Promise<never>(() => {})));
      const search = jest.fn(() => later(89_000, () => [{ link: 'https://f1.ru/' }, { link: 'https://f2.ru/' }, { link: 'https://f3.ru/' }]));
      let settled = false;
      const pending = fetchVeRelevanceEvidence('https://romashka.ru', {
        companyInn: '7700000001', focus: FOCUS, fetchPage, search: search as never,
      }).finally(() => { settled = true; });
      await jest.advanceTimersByTimeAsync(125_000);
      expect(settled).toBe(true);
      const result = await pending;
      expect(result.timeout).toBe('deadline');
      expect(result.reason).toBe('website_evidence_timeout');
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['404 или не-HTML', 'website_content_unavailable'],
    ['503', 'website_transient_http_503'],
    ['редирект на чужой сайт', 'website_redirect_unavailable'],
    ['слишком большая страница', 'website_content_too_large'],
  ])('напрямую молчание, через прокси сайт ответил сам (%s): ответ окончательный', async (_label, answer) => {
    const { calls, fetchPage } = recorder((_url, route) => { throw route === 'proxy' ? new Error(answer) : pageTimeout(); });
    const result = await fetchVeRelevanceEvidence('https://konfetkavpk.ru', {
      companyInn: '5023005244', focus: FOCUS, fetchPage, search: noSearch() as never,
    });
    expect(calls.map((call) => call.route)).toEqual(['direct', 'direct', 'proxy']);
    expect(result.reason).toBe('website_identity_unverified');
  });

  it.each([
    ['прокси не настроен в процессе', new Error('website_proxy_unavailable')],
    ['прокси отказал в соединении', code('connect ECONNREFUSED 10.1.1.1:8000', 'ECONNREFUSED')],
    ['прокси сам промолчал', pageTimeout()],
  ])('сбой прокси (%s) не превращает молчание сайта в окончательный отказ', async (_label, proxyFailure) => {
    const { calls, fetchPage } = recorder((_url, route) => { throw route === 'proxy' ? proxyFailure : pageTimeout(); });
    const result = await fetchVeRelevanceEvidence('https://konfetkavpk.ru', {
      companyInn: '5023005244', focus: FOCUS, fetchPage, search: noSearch() as never,
    });
    expect(calls.map((call) => call.route)).toEqual(['direct', 'direct', 'proxy']);
    // Сайт так и не ответил — компания получит штатный повтор гейта.
    expect(result.reason).toBe('website_evidence_timeout');
  });

  it.each([
    ['DNS не находит домен', Object.assign(new Error('queryA ENOTFOUND hyleys.ru'), { code: 'ENOTFOUND' }), 1],
    ['соединение отвергнуто', code('connect ECONNREFUSED 185.1.1.1:443', 'ECONNREFUSED'), 2],
    ['сертификат просрочен', code('certificate has expired', 'CERT_HAS_EXPIRED'), 1],
    ['TLS сломан', code('tlsv1 alert internal error', 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR'), 1],
  ])('%s: прокси не вызывается, /contacts хоста не читается, ярлык прежний', async (_label, failure, reads) => {
    // ООО «Пэтрон»: hyleys.ru отвергал соединение, hyleys.com рвал TLS.
    const { calls, fetchPage } = recorder(() => { throw failure; });
    const result = await fetchVeRelevanceEvidence('https://hyleys.ru', {
      companyInn: '7710321259', focus: FOCUS, fetchPage, search: noSearch() as never,
    });
    // Сертификат и TLS на повторе дают тот же отказ — повтор не тратим.
    expect(calls).toHaveLength(reads);
    expect(calls.some((call) => call.route === 'proxy')).toBe(false);
    expect(calls.some((call) => call.url === 'https://hyleys.ru/contacts')).toBe(false);
    expect(result.reason).toBe('website_identity_unverified');
    expect(result.proxy).toBeUndefined();
  });
});

describe('настоящий транспорт через прокси', () => {
  const response = (status: number, body: string) =>
    new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const viaProxy = (init: unknown) => (init as { dispatcher?: { constructor: { name: string } } }).dispatcher?.constructor.name === 'ProxyAgent';

  it('403 нашему адресу: второй заход идёт через общий диспетчер пула, и тот не уничтожается', async () => {
    mockTransport.fetch.mockImplementation(async (_url: string, init: unknown) =>
      (viaProxy(init) ? response(200, homeWithInn('7700000001')) : response(403, '<h1>403 Forbidden</h1>')));
    const result = await fetchVeRelevanceEvidence('https://rossetimr.ru', {
      companyInn: '7700000001', focus: FOCUS, search: noSearch() as never,
    });
    expect(result.status).toBe('ok');
    expect(result.proxy).toEqual({ attempts: 1, rescued: 1, verified: 1, denied: 0 });
    // Внутренние страницы после 403 читаются напрямую, как раньше: отказ быстрый.
    expect(mockTransport.fetch.mock.calls.filter(([, init]) => viaProxy(init))).toHaveLength(1);
    const [direct, proxied] = mockTransport.fetch.mock.calls.slice(0, 2).map(([, init]) => (init as { dispatcher: { destroyed: boolean } }).dispatcher);
    expect(viaProxy({ dispatcher: direct })).toBe(false);
    expect(direct.destroyed).toBe(true);
    // Диспетчер прокси общий на процесс: уничтожить его — сломать все заходы.
    expect(viaProxy({ dispatcher: proxied })).toBe(true);
    expect(proxied.destroyed).toBe(false);
    expect(mockTransport.fetch.mock.calls[1][1]).toEqual(expect.objectContaining({ redirect: 'manual' }));
    // undici не отменяет CONNECT вместе с запросом и сам повторяет туннель,
    // закрытый без ответа. Здесь — только конфигурация; как агент по ней
    // обрывает туннель, проверяет стенд на настоящем undici
    // (tests/lib/enrich/boundedProxyAgent.test.ts).
    const { options } = proxied as unknown as { options: { uri: string; keepAliveTimeout: number; keepAliveMaxTimeout: number;
      proxyTls: object; requestTls: object; factory: unknown;
      clientFactory: (origin: URL, o: object) => { options: Record<string, unknown> } } };
    expect(options.uri).toBe('http://user:pass@ru-proxy.invalid:8000');
    // TCP до ноды — 3 с; CONNECT и TLS к сайту через туннель — в окне страницы.
    expect(options.proxyTls).toEqual({ timeout: 3_000 });
    expect(options.requestTls).toEqual({ timeout: 5_000 });
    expect(typeof options.factory).toBe('function');
    expect(options.clientFactory(new URL(options.uri), {}).options).toEqual(expect.objectContaining({ connections: 6, headersTimeout: 5_000 }));
    // Готовый туннель уходит к пулу сайта и вне лимита выше жил бы по
    // подсказке Keep-Alive сайта (до 600 с): держим его не дольше секунды.
    expect(options).toEqual(expect.objectContaining({ keepAliveTimeout: 1_000, keepAliveMaxTimeout: 1_000 }));
  });

  it('молчащая главная: прямой повтор и прокси в одном окне, проигравший запрос отменяется', async () => {
    jest.useFakeTimers();
    try {
      const directSignals: AbortSignal[] = [];
      mockTransport.fetch.mockImplementation((_url: string, init: unknown) => {
        if (viaProxy(init)) return Promise.resolve(response(200, homeWithInn('7700000001')));
        const { signal } = init as { signal: AbortSignal };
        directSignals.push(signal);
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      });
      const pending = fetchVeRelevanceEvidence('https://silent-home.ru', { companyInn: '7700000001', focus: FOCUS, search: noSearch() as never });
      await jest.advanceTimersByTimeAsync(5_001);
      const result = await pending;
      expect(result.status).toBe('ok');
      expect(result.proxy).toEqual({ attempts: 1, rescued: 1, verified: 1, denied: 0 });
      // Первый прямой запрос снят окном 5 с, второй — сразу после ответа прокси.
      expect(directSignals).toHaveLength(2);
      expect(directSignals.every((signal) => signal.aborted)).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('диспетчер к ноде один на процесс: лимит соединений к ноде общий для всех компаний', async () => {
    mockTransport.fetch.mockImplementation(async (_url: string, init: unknown) =>
      (viaProxy(init) ? response(200, homeWithInn('7700000001')) : response(403, '<h1>403 Forbidden</h1>')));
    await fetchVeRelevanceEvidence('https://a-site.ru', { companyInn: '7700000001', focus: FOCUS, search: noSearch() as never });
    await fetchVeRelevanceEvidence('https://b-site.ru', { companyInn: '7700000001', focus: FOCUS, search: noSearch() as never });
    const proxied = mockTransport.fetch.mock.calls.filter(([, init]) => viaProxy(init)).map(([, init]) => (init as { dispatcher: unknown }).dispatcher);
    expect(proxied).toHaveLength(2);
    expect(proxied[0]).toBe(proxied[1]);
  });

  it('только RU-ноды приоритетной группы, даже если задан запасной пул', async () => {
    // Геоблок режет не-RU адреса, а запасные ноды (HK/EU) именно такие.
    process.env.YANDEXMAPS_PROXY_URLS = '["http://user:pass@hk-proxy.invalid:8000"]';
    resetProxyGroupsCache();
    mockTransport.fetch.mockImplementation(async (_url: string, init: unknown) =>
      (viaProxy(init) ? response(200, homeWithInn('7700000001')) : response(403, '<h1>403 Forbidden</h1>')));
    await fetchVeRelevanceEvidence('https://c-site.ru', { companyInn: '7700000001', focus: FOCUS, search: noSearch() as never });
    const proxied = mockTransport.fetch.mock.calls.filter(([, init]) => viaProxy(init))
      .map(([, init]) => (init as { dispatcher: { options: { uri: string } } }).dispatcher);
    expect(proxied).toHaveLength(1);
    expect(proxied[0].options.uri).toBe('http://user:pass@ru-proxy.invalid:8000');
  });

  it('через прокси действует та же проверка публичного адреса', async () => {
    // Адрес разрешает сам прокси, но наш резолвер обязан вернуть публичный
    // IPv4: частный ответ на втором заходе останавливает его до запроса.
    mockTransport.resolve.mockReset()
      .mockResolvedValueOnce(['93.184.216.34'])
      .mockResolvedValue(['10.0.0.7']);
    mockTransport.fetch.mockImplementation(async () => response(403, '<h1>403 Forbidden</h1>'));
    const result = await fetchVeRelevanceEvidence('https://rossetimr.ru', {
      companyInn: '7700000001', focus: FOCUS, search: noSearch() as never,
    });
    expect(result.status).not.toBe('ok');
    expect(result.proxy).toEqual({ attempts: 1, rescued: 0, verified: 0, denied: 0 });
    expect(mockTransport.fetch).toHaveBeenCalledTimes(1);
    expect(mockTransport.fetch.mock.calls.some(([, init]) => viaProxy(init))).toBe(false);
  });
});

describe('выключатель повтора через прокси', () => {
  const silentOwnHome = () => recorder((url, route) => {
    if (route === 'direct') throw pageTimeout();
    return html(url, homeWithInn(DOBRODAR.companyInn));
  });

  it('VE_EVIDENCE_PROXY_RETRY не задан: молчащая своя главная идёт в прокси', async () => {
    const { calls, fetchPage } = silentOwnHome();
    const evidence = await fetchVeRelevanceEvidence('sibdobrodar.ru', { ...DOBRODAR, fetchPage, search: noSearch() as never });
    expect(calls.map((call) => call.route)).toEqual(['direct', 'direct', 'proxy']);
    expect(evidence.status).toBe('ok');
    expect(evidence.proxy).toEqual({ attempts: 1, rescued: 1, verified: 1, denied: 0 });
  });

  it('VE_EVIDENCE_PROXY_RETRY=0: молчащая своя главная в прокси не идёт', async () => {
    process.env.VE_EVIDENCE_PROXY_RETRY = '0';
    const { calls, fetchPage } = silentOwnHome();
    const evidence = await fetchVeRelevanceEvidence('sibdobrodar.ru', { ...DOBRODAR, fetchPage, search: noSearch() as never });
    expect(calls.some((call) => call.route === 'proxy')).toBe(false);
    expect(evidence.reason).toBe('website_evidence_timeout');
    expect(evidence.proxy).toBeUndefined();
  });
});
