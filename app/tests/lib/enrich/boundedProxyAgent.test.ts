/** @jest-environment node */

/**
 * Стенд на настоящем undici: фальшивая CONNECT-нода на 127.0.0.1 ведёт себя
 * так, как вели себя ноды 23.09 (141.133.56.12 закрывала CONNECT без ответа,
 * часть нод лежала вместе с сервером 144.31.54.166). Голый ProxyAgent на
 * закрытом без ответа CONNECT переподключается без конца; ограниченный агент
 * делает один CONNECT на чтение, укладывается в срок туннеля и не оставляет
 * сокетов. Срок туннеля здесь 300 мс вместо 5–30 с на проде.
 */
import net from 'node:net';
import http from 'node:http';
import tls from 'node:tls';
import dc from 'node:diagnostics_channel';
import { fetch, ProxyAgent, type Dispatcher } from 'undici';
import { createBoundedProxyAgent, isProxyNodeFault, type ProxyNodeResult } from '@/lib/enrich/boundedProxyAgent';
import { getProxyDispatcher, proxyPoolHealth, resetProxyGroupsCache, resetProxyNodeHealth } from '@/lib/enrich/proxyPool';

const TUNNEL_MS = 300;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Mode = 'close' | 'partial' | 'acceptClose' | 'silent' | 'mute' | '407' | '502' | '503' | 'rst' | 'tunnel' | 'lateTunnel'
  | 'tunnelSilent';
// lateTunnel: нода отвечает 200 уже после срока туннеля, но раньше, чем
// сработает её таймер заголовков (первый шаг таймера undici — через 0,5 с).
const LATE_REPLY_MS = TUNNEL_MS + 100;

// Каждый TCP-заход к ноде, в том числе к закрытому порту, где сервера нет.
const dials = new Map<number, number>();
const onBeforeConnect = (message: unknown) => {
  const { connectParams } = message as { connectParams: { port: string | number } };
  const port = Number(connectParams.port);
  dials.set(port, (dials.get(port) ?? 0) + 1);
};
// Одновременные соединения нашего процесса к ноде. Считаются у клиента: у
// ноды 'close' старого сокета может прийти позже приёма нового, и её
// мгновенный счётчик на миг показывает лишние соединения.
const conns = new Map<number, { live: number; max: number }>();
const onConnected = (message: unknown) => {
  const { connectParams, socket } = message as { connectParams: { port: string | number }; socket: net.Socket };
  const port = Number(connectParams.port);
  const entry = conns.get(port) ?? { live: 0, max: 0 };
  conns.set(port, entry);
  entry.live += 1;
  entry.max = Math.max(entry.max, entry.live);
  socket.once('close', () => { entry.live -= 1; });
};
beforeAll(() => {
  dc.subscribe('undici:client:beforeConnect', onBeforeConnect);
  dc.subscribe('undici:client:connected', onConnected);
});
beforeEach(() => { dials.clear(); conns.clear(); });
afterAll(() => {
  dc.unsubscribe('undici:client:beforeConnect', onBeforeConnect);
  dc.unsubscribe('undici:client:connected', onConnected);
});

const listen = (server: net.Server) => new Promise<number>((resolve) =>
  server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
const closeServer = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

/** Открытые сокеты нашего процесса к порту ноды. */
function clientSockets(port: number): number {
  const handles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles();
  return handles.filter((handle) => handle instanceof net.Socket && !handle.destroyed && handle.remotePort === port).length;
}

function tunnelTo(socket: net.Socket, targetPort: number): void {
  const upstream = net.connect(targetPort, '127.0.0.1', () => {
    socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
}

async function fakeNode(mode: Mode, targetPort?: number) {
  const stats = { accepted: 0, connects: 0, live: 0, targets: [] as string[] };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    stats.accepted += 1;
    stats.live += 1;
    sockets.add(socket);
    socket.on('close', () => { stats.live -= 1; sockets.delete(socket); });
    socket.on('error', () => {});
    // resume: иначе непрочитанный CONNECT держит сокет полуоткрытым.
    if (mode === 'acceptClose') { socket.resume().end(); return; }
    // mute: соединение принято, в ответ ни байта (TLS-нода не отвечает на рукопожатие).
    if (mode === 'mute') { socket.resume(); return; }
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      if (!buffer.includes('\r\n\r\n')) return;
      socket.off('data', onData);
      stats.connects += 1;
      stats.targets.push(buffer.split(' ')[1]);
      if (mode === 'close') socket.end();
      else if (mode === 'partial') socket.end('HTTP/1.1 200');
      else if (mode === 'rst') socket.resetAndDestroy();
      else if (mode === '407' || mode === '502' || mode === '503') socket.write(`HTTP/1.1 ${mode} Proxy\r\nContent-Length: 0\r\n\r\n`);
      else if (mode === 'tunnelSilent') socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      else if (mode === 'tunnel') tunnelTo(socket, targetPort!);
      else if (mode === 'lateTunnel') setTimeout(() => { if (!socket.destroyed) tunnelTo(socket, targetPort!); }, LATE_REPLY_MS);
      // silent: CONNECT принят, ответа нет.
    };
    socket.on('data', onData);
  });
  const port = await listen(server);
  return {
    port, stats, uri: `http://user:pass@127.0.0.1:${port}`,
    close: async () => { sockets.forEach((socket) => socket.destroy()); await closeServer(server); },
  };
}

function boundedAgent(uri: string, extra: Parameters<typeof createBoundedProxyAgent>[1] = {}) {
  const results: Array<{ kind: ProxyNodeResult; detail: string }> = [];
  const agent = createBoundedProxyAgent(uri, {
    tunnelTimeoutMs: TUNNEL_MS, connectionsPerNode: 6,
    onNodeResult: (kind, detail) => results.push({ kind, detail }), ...extra,
  });
  return { agent, results };
}

async function read(agent: Dispatcher, url = 'https://site.test/', windowMs = 5_000) {
  const started = Date.now();
  try {
    const response = await fetch(url, { dispatcher: agent, signal: AbortSignal.timeout(windowMs) });
    return { ms: Date.now() - started, status: response.status, body: await response.text(), error: undefined };
  } catch (error) {
    return { ms: Date.now() - started, status: 0, body: '', error };
  }
}

function codes(error: unknown): string[] {
  const found: string[] = [];
  for (let current = error, depth = 0; current && typeof current === 'object' && depth < 4; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') found.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return found;
}

describe('нода не отвечает на CONNECT: один CONNECT на чтение, срок соблюдён, сокетов не остаётся', () => {
  it.each<[string, Mode]>([
    ['закрыла без ответа', 'close'],
    ['начала строку статуса и закрыла', 'partial'],
    ['закрыла сразу после приёма соединения', 'acceptClose'],
  ])('%s: сбой туннеля окончателен, вина ноды', async (_label, mode) => {
    const node = await fakeNode(mode);
    const { agent, results } = boundedAgent(node.uri);
    try {
      const { ms, error } = await read(agent);
      expect(error).toBeDefined();
      expect(ms).toBeLessThan(TUNNEL_MS + 200);
      expect(codes(error)).toContain('PORTAL_PROXY_TUNNEL');
      expect(isProxyNodeFault(error)).toBe(true);
      expect(dials.get(node.port)).toBe(1);
      expect(node.stats.connects).toBeLessThanOrEqual(1);
      // Без правки undici переподключался бы и после отказа.
      await sleep(500);
      expect(dials.get(node.port)).toBe(1);
      expect(node.stats.accepted).toBe(1);
      expect(node.stats.live).toBe(0);
      expect(clientSockets(node.port)).toBe(0);
      expect(results).toEqual([{ kind: 'down', detail: 'UND_ERR_SOCKET' }]);
    } finally {
      await agent.destroy();
      await node.close();
    }
  });

  it('молчит на CONNECT: чтение кончается по сроку туннеля, нода не виновата', async () => {
    const node = await fakeNode('silent');
    const { agent, results } = boundedAgent(node.uri);
    try {
      const { ms, error } = await read(agent);
      expect(codes(error)).toContain('PORTAL_PROXY_TUNNEL');
      expect(ms).toBeGreaterThanOrEqual(TUNNEL_MS - 20);
      expect(ms).toBeLessThan(TUNNEL_MS + 300);
      expect(isProxyNodeFault(error)).toBe(false);
      // Сокет к ноде закрывает срок ожидания ответа на CONNECT; таймер
      // заголовков в undici идёт шагом около 0,5 с.
      await sleep(TUNNEL_MS + 1_200);
      expect(node.stats.connects).toBe(1);
      expect(dials.get(node.port)).toBe(1);
      expect(node.stats.live).toBe(0);
      expect(clientSockets(node.port)).toBe(0);
      // Здоровая нода так же молчит, пока ждёт мёртвый сайт: не засчитываем.
      expect(results).toEqual([]);
    } finally {
      await agent.destroy();
      await node.close();
    }
  });

  it.each<[Mode, ProxyNodeResult, boolean]>([
    ['407', 'auth', true],
    ['502', 'answered', false],
    ['503', 'answered', false],
  ])('отвечает %s на CONNECT: быстрый отказ, один CONNECT', async (mode, kind, fault) => {
    const node = await fakeNode(mode);
    const { agent, results } = boundedAgent(node.uri);
    try {
      const { ms, error } = await read(agent);
      expect(error).toBeDefined();
      expect(ms).toBeLessThan(TUNNEL_MS);
      expect(isProxyNodeFault(error)).toBe(fault);
      await sleep(300);
      expect(node.stats.connects).toBe(1);
      expect(dials.get(node.port)).toBe(1);
      expect(node.stats.live).toBe(0);
      expect(clientSockets(node.port)).toBe(0);
      expect(results).toEqual([{ kind, detail: mode }]);
    } finally {
      await agent.destroy();
      await node.close();
    }
  });

  it('сбрасывает соединение (RST): вина ноды, один заход', async () => {
    const node = await fakeNode('rst');
    const { agent, results } = boundedAgent(node.uri);
    try {
      const { ms, error } = await read(agent);
      expect(error).toBeDefined();
      expect(ms).toBeLessThan(TUNNEL_MS + 200);
      expect(isProxyNodeFault(error)).toBe(true);
      await sleep(500);
      expect(dials.get(node.port)).toBe(1);
      expect(node.stats.live).toBe(0);
      expect(clientSockets(node.port)).toBe(0);
      expect(results).toHaveLength(1);
      expect(results[0].kind).toBe('down');
      expect(['ECONNRESET', 'UND_ERR_SOCKET']).toContain(results[0].detail);
    } finally {
      await agent.destroy();
      await node.close();
    }
  });

  it('порт ноды закрыт: отказ соединения, вина ноды, один заход', async () => {
    const probe = net.createServer();
    const port = await listen(probe);
    await closeServer(probe);
    const { agent, results } = boundedAgent(`http://user:pass@127.0.0.1:${port}`);
    try {
      const { ms, error } = await read(agent);
      expect(codes(error)).toContain('ECONNREFUSED');
      expect(ms).toBeLessThan(TUNNEL_MS);
      expect(isProxyNodeFault(error)).toBe(true);
      await sleep(500);
      expect(dials.get(port)).toBe(1);
      expect(clientSockets(port)).toBe(0);
      expect(results).toEqual([{ kind: 'down', detail: 'ECONNREFUSED' }]);
    } finally {
      await agent.destroy();
    }
  });

  // SYN без ответа на локальном стенде не воспроизвести. Срок соединения с
  // нодой в undici один и тот же: для http-ноды он закрывает TCP, для
  // https-ноды — TCP и TLS до неё. Здесь https-нода принимает TCP и молчит в
  // рукопожатии: соединение с ней так и не устанавливается.
  it.each<[string, { nodeDialTimeoutMs?: number }, number]>([
    ['заданный срок', { nodeDialTimeoutMs: 300 }, 300],
    ['срок по умолчанию — 3 с (у undici было 10 с)', {}, 3_000],
  ])('соединение с нодой не устанавливается: рвётся по сроку соединения, вина ноды, один заход (%s)', async (_label, dial, dialMs) => {
    const node = await fakeNode('mute');
    // Срок туннеля больше срока соединения: отказ — от срока соединения.
    const { agent, results } = boundedAgent(`https://user:pass@localhost:${node.port}`, { tunnelTimeoutMs: 8_000, ...dial });
    try {
      const { ms, error } = await read(agent, 'https://site.test/', 10_000);
      expect(codes(error)).toContain('UND_ERR_CONNECT_TIMEOUT');
      // Таймер соединения в undici идёт шагом 0,5 с.
      expect(ms).toBeGreaterThanOrEqual(dialMs - 20);
      expect(ms).toBeLessThan(dialMs + 1_500);
      expect(isProxyNodeFault(error)).toBe(true);
      await sleep(300);
      expect(dials.get(node.port)).toBe(1);
      expect(node.stats.accepted).toBe(1);
      expect(node.stats.live).toBe(0);
      expect(clientSockets(node.port)).toBe(0);
      expect(results).toEqual([{ kind: 'down', detail: 'UND_ERR_CONNECT_TIMEOUT' }]);
    } finally {
      await agent.destroy();
      await node.close();
    }
  }, 15_000);
});

describe('исправная нода', () => {
  it('туннель к сайту открывается, простаивающий туннель закрывается', async () => {
    const site = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); });
    const sitePort = await listen(site);
    const node = await fakeNode('tunnel', sitePort);
    const { agent, results } = boundedAgent(node.uri, { tunnelIdleMs: 200 });
    try {
      const { status, body } = await read(agent, 'http://site.test/');
      expect(status).toBe(200);
      expect(body).toBe('ok');
      expect(node.stats.targets).toEqual(['site.test:80']);
      expect(results).toEqual([{ kind: 'answered', detail: '200' }]);
      // Готовый туннель живёт не дольше простоя, а не по подсказке сайта.
      await sleep(600);
      expect(clientSockets(node.port)).toBe(0);
      expect(node.stats.live).toBe(0);
    } finally {
      await agent.destroy();
      await node.close();
      site.closeAllConnections();
      await closeServer(site);
    }
  });

  it('TLS через туннель несёт имя сайта (SNI), хотя requestTls задан', async () => {
    const seen: string[] = [];
    const site = tls.createServer({ SNICallback: (name, callback) => { seen.push(name); callback(new Error('no certificate in test')); } });
    site.on('tlsClientError', () => {});
    const sitePort = await listen(site);
    const node = await fakeNode('tunnel', sitePort);
    const { agent } = boundedAgent(node.uri);
    try {
      const { error } = await read(agent, 'https://sni-check.test/');
      expect(error).toBeDefined();
      expect(seen).toEqual(['sni-check.test']);
      expect(node.stats.targets).toEqual(['sni-check.test:443']);
    } finally {
      await agent.destroy();
      await node.close();
      await closeServer(site);
    }
  });

  it('нода ответила на CONNECT после срока туннеля: чтение уже провалено, поздний туннель закрывается', async () => {
    // Здоровая нода отвечает 200 только после того, как сама дозвонилась до
    // сайта, — ровно для медленных сайтов, которые мы и шлём через прокси.
    const site = http.createServer((_req, res) => { res.end('ok'); });
    const sitePort = await listen(site);
    const node = await fakeNode('lateTunnel', sitePort);
    const { agent, results } = boundedAgent(node.uri);
    try {
      const { ms, error } = await read(agent, 'http://late.test/');
      expect(codes(error)).toContain('PORTAL_PROXY_TUNNEL');
      expect(ms).toBeLessThan(LATE_REPLY_MS);
      await sleep(1_000);
      // Туннель к сайту действительно открылся — уже никому не нужный.
      expect(results).toEqual([{ kind: 'answered', detail: '200' }]);
      expect(node.stats.connects).toBe(1);
      expect(dials.get(node.port)).toBe(1);
      // Без закрытия позднего сокета он висел бы без срока: ни пул сайта,
      // ни пул ноды о нём уже не знают.
      expect(node.stats.live).toBe(0);
      expect(clientSockets(node.port)).toBe(0);
    } finally {
      await agent.destroy();
      await node.close();
      site.closeAllConnections();
      await closeServer(site);
    }
  });

  it('CONNECT принят, сайт молчит в TLS: отказ по сроку туннеля, лишних CONNECT нет, сокетов не остаётся', async () => {
    const node = await fakeNode('tunnelSilent');
    const { agent, results } = boundedAgent(node.uri);
    try {
      const { ms, error } = await read(agent);
      expect(codes(error)).toContain('PORTAL_PROXY_TUNNEL');
      expect(ms).toBeLessThan(TUNNEL_MS + 300);
      expect(isProxyNodeFault(error)).toBe(false);
      await sleep(TUNNEL_MS * 3);
      expect(node.stats.connects).toBe(1);
      expect(node.stats.live).toBe(0);
      expect(clientSockets(node.port)).toBe(0);
      expect(results).toEqual([{ kind: 'answered', detail: '200' }]);
    } finally {
      await agent.destroy();
      await node.close();
    }
  });
});

const waitFor = async (done: () => boolean, limitMs: number) => {
  const started = Date.now();
  while (!done() && Date.now() - started < limitMs) await sleep(50);
  return done();
};

describe('нагрузка на ноду', () => {
  it('20 параллельных чтений против ноды, закрывающей CONNECT: ровно 20 CONNECT, после — ни одного', async () => {
    const node = await fakeNode('close');
    const { agent, results } = boundedAgent(node.uri);
    try {
      const reads = await Promise.all(Array.from({ length: 20 }, (_, i) => read(agent, `https://site-${i}.test/`)));
      expect(reads.every((result) => result.error)).toBe(true);
      expect(Math.max(...reads.map((result) => result.ms))).toBeLessThan(TUNNEL_MS + 500);
      await sleep(500);
      expect(node.stats.accepted).toBe(20);
      expect(dials.get(node.port)).toBe(20);
      expect(node.stats.live).toBe(0);
      expect(clientSockets(node.port)).toBe(0);
      expect(results.every((result) => result.kind === 'down')).toBe(true);
    } finally {
      await agent.destroy();
      await node.close();
    }
  });

  it('20 параллельных чтений против молчащей ноды: к ноде не больше 6 соединений, хвост очереди CONNECT ограничен', async () => {
    // Молчащая нода держит каждое соединение до срока: предел соединений
    // виден только здесь (без него к ноде висели бы все 20 сразу).
    const node = await fakeNode('silent');
    const { agent, results } = boundedAgent(node.uri);
    try {
      const started = Date.now();
      const reads = await Promise.all(Array.from({ length: 20 }, (_, i) => read(agent, `https://site-${i}.test/`)));
      expect(reads.every((result) => codes(result.error).includes('PORTAL_PROXY_TUNNEL'))).toBe(true);
      expect(Math.max(...reads.map((result) => result.ms))).toBeLessThan(TUNNEL_MS + 500);
      // Чтения провалены, а CONNECT из очереди пула ноды ещё уходят: по 6, и
      // каждый ждёт ответа не дольше срока (шаг таймера undici — до 1 с).
      // Допустимый хвост от начала чтений — ceil(20 / 6) = 4 таких срока,
      // потом тишина.
      const tailLimitMs = Math.ceil(20 / 6) * (TUNNEL_MS + 1_000);
      const drained = () => node.stats.connects === 20 && node.stats.live === 0;
      expect(await waitFor(drained, tailLimitMs - (Date.now() - started))).toBe(true);
      // Предел держится: 6 соединений сразу, но не больше.
      expect(conns.get(node.port)).toEqual({ live: 0, max: 6 });
      expect(node.stats.accepted).toBe(20);
      expect(dials.get(node.port)).toBe(20);
      await sleep(300);
      expect(node.stats.connects).toBe(20);
      expect(clientSockets(node.port)).toBe(0);
      expect(results).toEqual([]);
    } finally {
      await agent.destroy();
      await node.close();
    }
  }, 15_000);
});

describe('общий пул proxyPool (websiteParser, emailScraper, стадии VE2)', () => {
  const saved = process.env.YANDEXMAPS_PROXY_URLS_PRIORITY;
  afterEach(() => {
    resetProxyNodeHealth();
    if (saved === undefined) delete process.env.YANDEXMAPS_PROXY_URLS_PRIORITY;
    else process.env.YANDEXMAPS_PROXY_URLS_PRIORITY = saved;
    resetProxyGroupsCache();
  });

  it('нода закрывает CONNECT: глобальный fetch получает один отказ на чтение, после трёх нода выбывает', async () => {
    const node = await fakeNode('close');
    process.env.YANDEXMAPS_PROXY_URLS_PRIORITY = JSON.stringify([node.uri]);
    resetProxyGroupsCache();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let i = 0; i < 3; i += 1) {
        const dispatcher = await getProxyDispatcher(true);
        expect(dispatcher).toBeDefined();
        const started = Date.now();
        // Так читает websiteParser.fetchHtml: глобальный fetch с диспетчером пула.
        await expect(globalThis.fetch('https://site.test/', { dispatcher, signal: AbortSignal.timeout(2_000) } as RequestInit))
          .rejects.toThrow();
        expect(Date.now() - started).toBeLessThan(500);
      }
      await sleep(300);
      expect(dials.get(node.port)).toBe(3);
      expect(node.stats.live).toBe(0);
      expect(clientSockets(node.port)).toBe(0);
      expect(proxyPoolHealth()).toEqual({ priorityOut: [1] });
      // Живых RU-нод нет: fetchHtml идёт напрямую, как без пула.
      expect(await getProxyDispatcher(true)).toBeUndefined();
    } finally {
      warn.mockRestore();
      await node.close();
    }
  });
});

describe('сторож поведения undici', () => {
  it('голый ProxyAgent на закрытом без ответа CONNECT переподключается сам', async () => {
    // Если это перестанет воспроизводиться (обновили undici), пересмотреть
    // boundedProxyAgent: он опирается именно на это устройство.
    const node = await fakeNode('close');
    const agent = new ProxyAgent(node.uri);
    let connects = 0;
    try {
      const { error } = await read(agent, 'https://site.test/', 1_000);
      expect(error).toBeDefined();
      connects = node.stats.connects;
    } finally {
      // Закрываем порт: на отказе соединения undici снимает очередь, и шторм
      // сирот кончается, а не переживает тест.
      await node.close();
      await agent.destroy().catch(() => undefined);
    }
    // Замер 23.09 на том же устройстве: 53 CONNECT за 8 с одного чтения.
    expect(connects).toBeGreaterThan(1);
  });
});
