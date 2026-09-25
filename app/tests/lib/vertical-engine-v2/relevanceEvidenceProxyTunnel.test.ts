/** @jest-environment node */

/**
 * Сквозной стенд читателя сайтов с настоящим undici и фальшивой RU-нодой на
 * 127.0.0.1. Сайт отвечает нашему адресу 403 (как rossetimr.ru в замере 22.09),
 * второй заход идёт через агент ноды. 23.09 нода 141.133.56.12 закрывала
 * CONNECT без ответа; голый ProxyAgent на этом переподключался без конца,
 * задачи сбора VE2 держали воркер под нагрузкой, и повтор через прокси
 * выключили. Под тестом: одно чтение — один CONNECT, компания в своём окне,
 * сокетов после нет, мёртвая нода выбывает, рабочая спасает компанию.
 */
import net from 'node:net';
import http from 'node:http';
import dc from 'node:diagnostics_channel';
import { destroyVeEvidenceProxyAgentsForTests, fetchVeRelevanceEvidence } from '@/lib/verticalEngineV2/relevanceEvidence';
import { resetProxyGroupsCache, resetProxyNodeHealth } from '@/lib/enrich/proxyPool';

jest.mock('node:dns/promises', () => {
  const actual = jest.requireActual('node:dns/promises');
  class Resolver {
    async resolve4() { return ['93.184.216.34']; }
    cancel() {}
  }
  return { ...actual, Resolver };
});
// Прямой путь (наш адрес в США) — всегда 403, без сети. ProxyAgent, Pool и fetch — настоящие.
jest.mock('undici', () => {
  const actual = jest.requireActual('undici');
  class Agent extends actual.MockAgent {
    constructor() {
      super();
      this.disableNetConnect();
      this.get(() => true).intercept({ path: () => true })
        .reply(403, '<h1>403 Forbidden</h1>', { headers: { 'content-type': 'text/html' } }).persist();
    }
    async destroy() { await this.close(); }
  }
  return { ...actual, Agent };
});

const INN = '7700000001';
const FOCUS = 'производство продуктов питания';
const noSearch = () => jest.fn(async () => []);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const dials = new Map<number, number>();
const onBeforeConnect = (message: unknown) => {
  const port = Number((message as { connectParams: { port: string | number } }).connectParams.port);
  dials.set(port, (dials.get(port) ?? 0) + 1);
};
const listen = (server: net.Server) => new Promise<number>((resolve) =>
  server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
const clientSockets = (port: number) => (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles()
  .filter((handle) => handle instanceof net.Socket && !handle.destroyed && handle.remotePort === port).length;

const closers: Array<() => Promise<void>> = [];
/** close — закрывает CONNECT без ответа; tunnel — ведёт туннель к локальному сайту. */
async function fakeNode(mode: 'close' | 'tunnel', sitePort?: number) {
  const stats = { accepted: 0, connects: 0, live: 0 };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    stats.accepted += 1;
    stats.live += 1;
    sockets.add(socket);
    socket.on('close', () => { stats.live -= 1; sockets.delete(socket); });
    socket.on('error', () => {});
    socket.once('data', () => {
      stats.connects += 1;
      if (mode === 'close') { socket.end(); return; }
      const upstream = net.connect(sitePort!, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('close', () => upstream.destroy());
    });
  });
  const port = await listen(server);
  // Закрытый порт снимает очередь undici даже на старом коде: шторм не
  // переживает тест.
  closers.push(async () => {
    sockets.forEach((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  process.env.YANDEXMAPS_PROXY_URLS_PRIORITY = JSON.stringify([`http://user:pass@127.0.0.1:${port}`]);
  resetProxyGroupsCache();
  return { port, stats };
}

let site = 0;
async function readCompany(website = `https://blocked-${site += 1}.ru`) {
  const started = Date.now();
  const evidence = await fetchVeRelevanceEvidence(website, { companyInn: INN, focus: FOCUS, search: noSearch() as never });
  return { evidence, ms: Date.now() - started };
}

const PROXY_ENV = ['YANDEXMAPS_PROXY_URLS_PRIORITY', 'YANDEXMAPS_PROXY_URLS', 'PROXY_URLS', 'VE_EVIDENCE_PROXY_RETRY'] as const;
const originalEnv = Object.fromEntries(PROXY_ENV.map((name) => [name, process.env[name]]));
let warn: jest.SpyInstance;
beforeAll(() => dc.subscribe('undici:client:beforeConnect', onBeforeConnect));
afterAll(() => dc.unsubscribe('undici:client:beforeConnect', onBeforeConnect));
beforeEach(() => {
  for (const name of PROXY_ENV) delete process.env[name];
  // Явно, а не по умолчанию: тот же стенд воспроизводит шторм на коде до правки.
  process.env.VE_EVIDENCE_PROXY_RETRY = '1';
  resetProxyNodeHealth();
  dials.clear();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await destroyVeEvidenceProxyAgentsForTests();
  warn.mockRestore();
  resetProxyNodeHealth();
  for (const name of PROXY_ENV) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
  resetProxyGroupsCache();
});

describe('RU-нода закрывает CONNECT без ответа', () => {
  it('одна компания: окно соблюдено, один CONNECT, сбой прокси в телеметрии, сокетов после нет', async () => {
    const node = await fakeNode('close');
    const { evidence, ms } = await readCompany();
    expect(ms).toBeLessThan(5_500);
    expect(evidence.proxy).toEqual({ attempts: 1, rescued: 0, verified: 0, denied: 0, failed: 1 });
    // Сайт ответил нашему адресу 403 — ответ окончательный, не таймаут.
    expect(evidence.reason).toBe('website_identity_unverified');
    expect(dials.get(node.port)).toBe(1);
    await sleep(500);
    // До правки: тысячи CONNECT за окно и новые после него.
    expect(dials.get(node.port)).toBe(1);
    expect(node.stats.connects).toBeLessThanOrEqual(1);
    expect(node.stats.live).toBe(0);
    expect(clientSockets(node.port)).toBe(0);
  }, 20_000);

  it('после трёх таких компаний нода выбывает: четвёртая к ней не подключается', async () => {
    const node = await fakeNode('close');
    for (let i = 0; i < 3; i += 1) {
      const { evidence } = await readCompany();
      expect(evidence.proxy).toEqual(expect.objectContaining({ attempts: 1, failed: 1 }));
    }
    expect(node.stats.accepted).toBe(3);
    expect(warn).toHaveBeenCalledWith('[proxyPool] RU-прокси №1 выбыл на 60 с: 3 отказа соединения подряд (UND_ERR_SOCKET)');
    const { evidence } = await readCompany();
    expect(node.stats.accepted).toBe(3);
    expect(dials.get(node.port)).toBe(3);
    // Пропуск не брался: живой RU-ноды нет.
    expect(evidence.proxy).toEqual({ attempts: 0, rescued: 0, verified: 0, denied: 0, unavailable: 1 });
  }, 30_000);
});

describe('рабочая RU-нода', () => {
  it('туннель открывается, главная с ИНН приходит через прокси и подтверждает компанию', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<title>Собственное производство</title><main><p>Мы выпускаем продукты питания на собственном
        производстве и поставляем их в магазины области.</p></main><footer>Реквизиты: ИНН ${INN}</footer>`);
    });
    const sitePort = await listen(server);
    closers.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const node = await fakeNode('tunnel', sitePort);
    const { evidence } = await readCompany('http://working-node.ru');
    expect(evidence.status).toBe('ok');
    expect(evidence.reason).toBe('identity_verified_website');
    expect(evidence.proxy).toEqual({ attempts: 1, rescued: 1, verified: 1, denied: 0 });
    expect(node.stats.connects).toBe(1);
    // Готовый туннель живёт не дольше секунды простоя.
    await sleep(1_500);
    expect(clientSockets(node.port)).toBe(0);
  }, 20_000);
});
