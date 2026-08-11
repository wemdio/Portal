/** @jest-environment node */

/**
 * Проверка прокси кампании — два вердикта на один прокси.
 *
 * Главное, что здесь закреплено: «прокси не отвечает» и «прокси жив, но
 * Telegram через него не проходит» — разные исходы. Первый чинит провайдер,
 * второй означает блокировку, при которой аккаунты молча перестают работать.
 * Если эти два случая когда-нибудь сольются в один, вся фича перестанет иметь
 * смысл, поэтому проверяем именно их различимость.
 *
 * Все прокси здесь — локальные заглушки на net. В интернет тесты не ходят: у
 * CI его может не быть, а у боевых прокси нельзя воспроизвести отказ по заказу.
 */

import net from 'net';
import {
  checkProxy,
  checkProxies,
  TELEGRAM_PROBE_TARGET,
} from '@/lib/tgOutreach/proxyCheck';

/** Цель проверки в тестах: до неё никто не ходит, важна только строка CONNECT. */
const TARGET = { host: '127.0.0.1', port: 443 };

interface Stub {
  port: number;
  close: () => Promise<void>;
}

function startStub(onConnection: (socket: net.Socket) => void): Promise<Stub> {
  return new Promise((resolve) => {
    const server = net.createServer(onConnection);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        close: () => new Promise<void>((done) => {
          server.close(() => done());
        }),
      });
    });
  });
}

/** Заглушка HTTP-прокси, отвечающая заданной строкой на CONNECT. */
function startHttpProxyStub(
  reply: string,
  opts: { delayMs?: number; onRequest?: (raw: string) => void } = {},
): Promise<Stub> {
  return startStub((socket) => {
    socket.on('error', () => { /* клиент рвёт соединение первым — это норма */ });
    socket.once('data', (chunk) => {
      opts.onRequest?.(chunk.toString());
      if (!reply) return; // молчаливый прокси — сценарий таймаута
      setTimeout(() => socket.write(reply), opts.delayMs ?? 0);
    });
  });
}

/** Заглушка SOCKS5 без авторизации, отвечающая заданным кодом на CONNECT. */
function startSocks5Stub(replyCode: number): Promise<Stub> {
  return startStub((socket) => {
    socket.on('error', () => { /* см. выше */ });
    let stage: 'greeting' | 'connect' = 'greeting';
    socket.on('data', () => {
      if (stage === 'greeting') {
        stage = 'connect';
        socket.write(Buffer.from([0x05, 0x00]));
        return;
      }
      socket.write(Buffer.from([0x05, replyCode, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    });
  });
}

/** Порт, на котором заведомо никто не слушает. */
async function deadPort(): Promise<number> {
  const stub = await startStub(() => {});
  await stub.close();
  return stub.port;
}

let logSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
beforeAll(() => {
  // Туннель логирует каждый шаг рукопожатия — в боевом воркере это нужно, в
  // выводе тестов только мешает. Заодно глушим предупреждение @mtcute/convert
  // про CommonJS: оно про пакет, а не про наш код.
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
});

describe('checkProxy', () => {
  it('живой прокси с проходящим Telegram — оба вердикта положительные', async () => {
    let seenRequest = '';
    const stub = await startHttpProxyStub('HTTP/1.1 200 Connection established\r\n\r\n', {
      onRequest: (raw) => { seenRequest = raw; },
    });
    try {
      const res = await checkProxy(
        { id: 'p1', url: `http://user:pass@127.0.0.1:${stub.port}`, name: 'Прокси 1' },
        { target: TARGET, tunnelTimeoutMs: 2_000 },
      );

      expect(res.status).toBe('ok');
      expect(res.proxy_ok).toBe(true);
      expect(res.telegram_ok).toBe(true);
      expect(res.reason).toBeNull();
      expect(res.proxy_latency_ms).toBeGreaterThanOrEqual(0);
      expect(res.telegram_latency_ms).toBeGreaterThanOrEqual(0);
      expect(res.name).toBe('Прокси 1');
      // Туннель строится именно до адреса дата-центра, и учётка из строки
      // прокси доезжает до него — иначе проверка мерила бы не то.
      expect(seenRequest).toContain(`CONNECT ${TARGET.host}:${TARGET.port}`);
      expect(seenRequest).toContain(`Proxy-Authorization: Basic ${Buffer.from('user:pass').toString('base64')}`);
    } finally {
      await stub.close();
    }
  });

  it('мёртвый прокси — первый вердикт отрицательный, до Telegram не идём', async () => {
    const port = await deadPort();
    const res = await checkProxy(
      { id: 'p2', url: `http://user:pass@127.0.0.1:${port}` },
      { target: TARGET, tcpTimeoutMs: 2_000, tunnelTimeoutMs: 2_000 },
    );

    expect(res.status).toBe('proxy_dead');
    expect(res.proxy_ok).toBe(false);
    expect(res.telegram_ok).toBe(false);
    // null, а не 0: туннель не пробовали вовсе, и это видно по ответу.
    expect(res.telegram_latency_ms).toBeNull();
    expect(res.reason).toMatch(/прокси не отвечает/);
  });

  it('прокси жив, но Telegram через него недоступен — вердикты расходятся', async () => {
    const stub = await startHttpProxyStub('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    try {
      const res = await checkProxy(
        { id: 'p3', url: `http://user:pass@127.0.0.1:${stub.port}` },
        { target: TARGET, tunnelTimeoutMs: 2_000 },
      );

      expect(res.status).toBe('telegram_unreachable');
      expect(res.proxy_ok).toBe(true);
      expect(res.telegram_ok).toBe(false);
      expect(res.reason).toMatch(/прокси жив, но Telegram через него недоступен/);
      expect(res.reason).toContain('502');
    } finally {
      await stub.close();
    }
  });

  it('прокси отвечает 407 — это отказ прокси, а не блокировка Telegram', async () => {
    const stub = await startHttpProxyStub('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
    try {
      const res = await checkProxy(
        { id: 'p4', url: `http://user:pass@127.0.0.1:${stub.port}` },
        { target: TARGET, tunnelTimeoutMs: 2_000 },
      );

      expect(res.status).toBe('proxy_rejected');
      expect(res.proxy_ok).toBe(false);
      expect(res.telegram_ok).toBe(false);
      expect(res.reason).toMatch(/не пускает/);
    } finally {
      await stub.close();
    }
  });

  it('молчащий прокси не вешает проверку — туннель падает по таймауту', async () => {
    const stub = await startHttpProxyStub('');
    try {
      const startedAt = Date.now();
      const res = await checkProxy(
        { id: 'p5', url: `http://user:pass@127.0.0.1:${stub.port}` },
        { target: TARGET, tunnelTimeoutMs: 200 },
      );

      expect(res.status).toBe('telegram_unreachable');
      expect(res.proxy_ok).toBe(true);
      expect(res.telegram_ok).toBe(false);
      expect(res.reason).toMatch(/туннель не открылся/);
      // Проверка укладывается в свой таймаут, а не ждёт TCP-таймаута системы.
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    } finally {
      await stub.close();
    }
  });

  it('неразбираемая строка прокси — в сеть не ходим вообще', async () => {
    const res = await checkProxy({ id: 'p6', url: 'вообще не url' }, { target: TARGET });

    expect(res.status).toBe('bad_url');
    expect(res.proxy_ok).toBe(false);
    expect(res.telegram_ok).toBe(false);
    expect(res.proxy_latency_ms).toBeNull();
    expect(res.reason).toMatch(/не удалось разобрать/);
  });

  it('socks5: успешный туннель и отказ по адресу назначения различаются', async () => {
    const good = await startSocks5Stub(0x00);
    const unreachable = await startSocks5Stub(0x04); // host unreachable
    try {
      const ok = await checkProxy(
        { id: 's1', url: `socks5://127.0.0.1:${good.port}` },
        { target: TARGET, tunnelTimeoutMs: 2_000 },
      );
      expect(ok.status).toBe('ok');
      expect(ok.telegram_ok).toBe(true);

      const bad = await checkProxy(
        { id: 's2', url: `socks5://127.0.0.1:${unreachable.port}` },
        { target: TARGET, tunnelTimeoutMs: 2_000 },
      );
      expect(bad.status).toBe('telegram_unreachable');
      expect(bad.proxy_ok).toBe(true);
      expect(bad.telegram_ok).toBe(false);
    } finally {
      await good.close();
      await unreachable.close();
    }
  });

  it('адрес проверки совпадает с боевым дата-центром Telegram', async () => {
    const { DC_MAPPING_PROD } = await import('@mtcute/convert');
    expect(TELEGRAM_PROBE_TARGET.host).toBe(DC_MAPPING_PROD[2].main.ipAddress);
    expect(TELEGRAM_PROBE_TARGET.port).toBe(DC_MAPPING_PROD[2].main.port);
  });
});

describe('checkProxies', () => {
  it('проверяет пачку, сохраняя порядок, и не открывает больше сокетов, чем разрешено', async () => {
    let inFlight = 0;
    let peak = 0;
    const stub = await startStub((socket) => {
      socket.on('error', () => {});
      socket.once('data', () => {
        // Считаем только туннели: TCP-проба данных не шлёт и живёт миллисекунды.
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        setTimeout(() => {
          socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
          inFlight -= 1;
        }, 40);
      });
    });
    try {
      const proxies = Array.from({ length: 12 }, (_, i) => ({
        id: `p${i}`,
        url: `http://127.0.0.1:${stub.port}`,
        name: `Прокси ${i}`,
      }));

      const res = await checkProxies(proxies, { target: TARGET, tunnelTimeoutMs: 2_000, concurrency: 4 });

      expect(res).toHaveLength(12);
      expect(res.map((r) => r.id)).toEqual(proxies.map((p) => p.id));
      expect(res.every((r) => r.status === 'ok')).toBe(true);
      expect(peak).toBeLessThanOrEqual(4);
      expect(peak).toBeGreaterThan(1);
    } finally {
      await stub.close();
    }
  });

  it('один мёртвый прокси не мешает проверить остальные', async () => {
    const stub = await startHttpProxyStub('HTTP/1.1 200 Connection established\r\n\r\n');
    const dead = await deadPort();
    try {
      const res = await checkProxies(
        [
          { id: 'live', url: `http://127.0.0.1:${stub.port}` },
          { id: 'dead', url: `http://127.0.0.1:${dead}` },
          { id: 'broken', url: 'мусор' },
        ],
        { target: TARGET, tcpTimeoutMs: 2_000, tunnelTimeoutMs: 2_000, concurrency: 2 },
      );

      expect(res.map((r) => r.status)).toEqual(['ok', 'proxy_dead', 'bad_url']);
    } finally {
      await stub.close();
    }
  });
});
