/** @jest-environment node */

/**
 * hh.ru через PROXY_URLS на ограниченном агенте: сбой ноды должен остаться
 * сбоем прокси (пауза ноды в ротации hh, понятный текст задачи), а не
 * безымянной «ошибкой сети». Фальшивая нода на 127.0.0.1, настоящий undici.
 */
import net from 'node:net';
import { fetch as undiciFetch } from 'undici';

jest.mock('@/lib/loggerServer', () => ({ logInfo: jest.fn(), logWarn: jest.fn(), logError: jest.fn() }));

// Глобальный fetch в jest пришёл из другого realm: ошибку диспетчера из
// vm-контекста он не считает Error и заменяет копией-строкой, пометки ноды
// теряются. На проде fetch и код в одном realm, так что берём fetch из undici.
const realFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = undiciFetch as unknown as typeof fetch; });
afterAll(() => { globalThis.fetch = realFetch; });

type Mode = 'close' | '407' | '502' | 'silent';

const ENV = ['PROXY_URLS', 'HH_PROXY_URL', 'HH_REQUEST_INTERVAL_MS', 'HH_REQUEST_TIMEOUT_MS',
  'HH_VACANCY_REQUEST_TIMEOUT_MS', 'HH_EMPLOYER_REQUEST_TIMEOUT_MS'] as const;
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

async function fakeNode(mode: Mode) {
  const stats = { connects: 0 };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      if (!buffer.includes('\r\n\r\n')) return;
      buffer = '';
      stats.connects += 1;
      if (mode === 'close') socket.end();
      else if (mode === '407' || mode === '502') socket.write(`HTTP/1.1 ${mode} Proxy\r\nContent-Length: 0\r\n\r\n`);
      // silent: CONNECT принят, ответа нет.
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as net.AddressInfo;
  return {
    stats,
    uri: `http://user:pass@127.0.0.1:${port}`,
    close: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function fetchThrough(mode: Mode, opts: { maxRetries: number; timeoutMs: number }, env: Record<string, string> = {}) {
  const node = await fakeNode(mode);
  process.env.PROXY_URLS = JSON.stringify([node.uri]);
  process.env.HH_REQUEST_INTERVAL_MS = '100';
  Object.assign(process.env, env);
  try {
    let message = '';
    let proxyFailures: unknown[] = [];
    await jest.isolateModulesAsync(async () => {
      const hh = await import('@/lib/parsers/hhParser');
      const logger = await import('@/lib/loggerServer');
      try {
        await hh.fetchWithRetry('https://api.hh.ru/vacancies?text=x', { ...opts, minDelayMs: 10, maxDelayMs: 20 });
      } catch (error) {
        message = (error as Error).message;
      }
      proxyFailures = (logger.logError as jest.Mock).mock.calls
        .filter(([event]) => event === 'hh.proxy_failed')
        .map(([, , meta]) => (meta as { consecutiveFailures: number }).consecutiveFailures);
    });
    return { message, proxyFailures, connects: node.stats.connects };
  } finally {
    await node.close();
  }
}

it.each<[string, Mode]>([
  ['закрывает CONNECT без ответа', 'close'],
  ['отвергает логин (407)', '407'],
])('нода %s: сбой прокси, нода копит неудачи и уходит на паузу', async (_label, mode) => {
  const { message, proxyFailures, connects } = await fetchThrough(mode, { maxRetries: 2, timeoutMs: 3_000 });
  expect(message).toBe('Все прокси недоступны (3 попыток). Проверьте PROXY_URLS — возможно, прокси истекли.');
  expect(proxyFailures).toEqual([1, 2, 3]);
  expect(connects).toBe(3);
});

it('нода ответила 502: не вина ноды, в тексте задачи названа причина', async () => {
  const { message, proxyFailures, connects } = await fetchThrough('502', { maxRetries: 2, timeoutMs: 3_000 });
  expect(message).toBe('HH API: 3 попыток неуспешны (ошибка сети × 3)');
  expect(proxyFailures).toEqual([]);
  expect(connects).toBe(3);
});

it('нода молчит дольше срока туннеля: это таймаут, а не сбой прокси', async () => {
  // Срок туннеля hh — самое длинное окно запроса: здесь 1 с, окно чтения 5 с.
  const env = { HH_REQUEST_TIMEOUT_MS: '1000', HH_VACANCY_REQUEST_TIMEOUT_MS: '1000', HH_EMPLOYER_REQUEST_TIMEOUT_MS: '1000' };
  const started = Date.now();
  const { message, proxyFailures, connects } = await fetchThrough('silent', { maxRetries: 0, timeoutMs: 5_000 }, env);
  expect(Date.now() - started).toBeLessThan(3_000);
  expect(message).toBe('HH API не отвечает (таймаут × 1).');
  expect(proxyFailures).toEqual([]);
  expect(connects).toBe(1);
});
