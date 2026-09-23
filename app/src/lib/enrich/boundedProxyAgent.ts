/**
 * Диспетчер к одной прокси-ноде с жёсткими пределами на туннель.
 *
 * Голый ProxyAgent из undici 7.25 на ноде, закрывшей CONNECT без ответа,
 * переподключается без конца: ошибка туннеля (UND_ERR_SOCKET) для клиента
 * сайта считается восстановимой, очередь не снимается, а отмена fetch не
 * достаёт запрос, который ждёт соединения. Замер 23.09: 53 CONNECT за 8 с
 * одного чтения и ещё 64 за 10 с после отмены. Здесь:
 *   — туннель (CONNECT и TLS к сайту через него) ограничен сроком, сбой
 *     туннеля окончателен для чтения: один CONNECT на чтение;
 *   — TCP до ноды рвётся через 3 с, ответ CONNECT ждётся не дольше срока;
 *   — исход CONNECT сообщается наружу (onNodeResult): по нему общий пул
 *     выводит мёртвую ноду на время.
 * CONNECT, стоящие в очереди пула ноды, уходят к ней и после провала своих
 * чтений: каждый ждёт ответа не дольше срока туннеля (плюс шаг таймера undici
 * до 1 с). Хвост после провала N чтений — не больше ceil(N / connectionsPerNode)
 * таких сроков; поздно открытый туннель закрывается сразу.
 * Возвращается обычный ProxyAgent, не подкласс.
 */
import type { Socket } from 'node:net';
import { Pool, ProxyAgent, type buildConnector, type Dispatcher } from 'undici';

/** answered — нода ответила на CONNECT (любой статус, кроме 407); auth — 407;
 * down — нода не приняла соединение, сбросила его или закрыла без ответа. */
export type ProxyNodeResult = 'answered' | 'auth' | 'down';

export interface BoundedProxyAgentOptions {
  /** Срок туннеля целиком: CONNECT к ноде и TLS к сайту через неё. */
  tunnelTimeoutMs?: number;
  /** Соединение с нодой: TCP (для https-ноды — и TLS до неё). */
  nodeDialTimeoutMs?: number;
  /** Одновременных CONNECT к ноде; по умолчанию без предела, как у undici. */
  connectionsPerNode?: number;
  /** Сколько готовый туннель живёт без запросов. */
  tunnelIdleMs?: number;
  onNodeResult?: (kind: ProxyNodeResult, detail: string) => void;
}

/** Туннель через прокси не открылся: чтение окончено, undici его не повторяет. */
export class ProxyTunnelError extends Error {
  readonly code = 'PORTAL_PROXY_TUNNEL';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProxyTunnelError';
  }
}

// Ошибки, в которых виновата сама нода, а не сайт за ней.
const nodeFaults = new WeakSet<object>();
// Молчание на CONNECT (UND_ERR_HEADERS_TIMEOUT) сюда не входит: здоровая нода
// так же молчит, пока сама ждёт мёртвый сайт, а через прокси идут как раз
// молчащие сайты. Ответы 5xx — тоже голос сайта за нодой.
const NODE_DOWN_CODES = new Set(['UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'ECONNREFUSED',
  'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENETDOWN', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);
const AUTH_REJECTED = /Proxy response \(407\)/;
const SITE_TLS_MAX_MS = 10_000;

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

/** Сбой по вине ноды: отказ, сброс, закрытие CONNECT без ответа, TCP-таймаут, 407. */
export function isProxyNodeFault(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth += 1) {
    if (nodeFaults.has(current)) return true;
    if (current instanceof Error && AUTH_REJECTED.test(current.message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Туннель не открылся в срок: нода молчит на CONNECT или сайт молчит в TLS. */
export function isProxyTunnelTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth += 1) {
    if (current instanceof ProxyTunnelError && current.message === 'proxy_tunnel_timeout') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function tunnelError(error: Error): Error {
  const code = errorCode(error);
  // Остальные коды undici и так снимают очередь клиента сайта.
  if (code !== 'UND_ERR_SOCKET' && code !== 'UND_ERR_INFO') return error;
  const wrapped = new ProxyTunnelError(`proxy_tunnel_failed: ${code}`, { cause: error });
  if (nodeFaults.has(error)) nodeFaults.add(wrapped);
  return wrapped;
}

/** Туннель к сайту с общим сроком. Поздний сокет закрывается сразу.
 * Висящий CONNECT к ноде закрывает headersTimeout её пула (тот же срок, шаг
 * таймера undici около секунды). Отменять его сигналом нельзя: в undici 7.25
 * отменённый запрос остаётся в очереди и открывает к ноде лишнее соединение. */
function boundedTunnel(tunnel: buildConnector.connector, timeoutMs: number): buildConnector.connector {
  return (options, callback) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      callback(new ProxyTunnelError('proxy_tunnel_timeout'), null);
    }, timeoutMs);
    tunnel(options, (...args) => {
      const [error, socket] = args;
      if (settled) {
        (socket as Socket | null)?.on('error', () => {}).destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) callback(tunnelError(error), null);
      else callback(...args);
    });
  };
}

export function createBoundedProxyAgent(uri: string, opts: BoundedProxyAgentOptions = {}): ProxyAgent {
  const protocol = new URL(uri).protocol;
  // SOCKS-нод в окружении нет; у них свой путь в undici.
  if (protocol === 'socks:' || protocol === 'socks5:') return new ProxyAgent(uri);
  const tunnelTimeoutMs = opts.tunnelTimeoutMs ?? 10_000;
  const nodeDialTimeoutMs = opts.nodeDialTimeoutMs ?? Math.min(3_000, tunnelTimeoutMs);
  const report = (kind: ProxyNodeResult, detail: string) => {
    try {
      opts.onNodeResult?.(kind, detail);
    } catch {
      // Учёт здоровья ноды не должен ломать соединение.
    }
  };
  return new ProxyAgent({
    uri,
    proxyTls: { timeout: nodeDialTimeoutMs },
    // servername не задаём: undici возьмёт имя сайта из адреса (SNI). TLS к
    // сайту — в сроке туннеля и не дольше прежних 10 с undici по умолчанию.
    requestTls: { timeout: Math.min(tunnelTimeoutMs, SITE_TLS_MAX_MS) },
    ...(opts.tunnelIdleMs !== undefined ? { keepAliveTimeout: opts.tunnelIdleMs, keepAliveMaxTimeout: opts.tunnelIdleMs } : {}),
    clientFactory: (origin, options) => {
      const pool = new Pool(origin, {
        ...options,
        ...(opts.connectionsPerNode ? { connections: opts.connectionsPerNode } : {}),
        headersTimeout: tunnelTimeoutMs,
      });
      // Ссылку берём без bind: у заглушки Pool в тестах метода нет.
      const connect = pool.connect as (params: Dispatcher.ConnectOptions) => Promise<Dispatcher.ConnectData>;
      // ProxyAgent зовёт connect(params) без колбэка и ждёт промис.
      pool.connect = ((params: Dispatcher.ConnectOptions) => connect.call(pool, params).then((data) => {
        report(data.statusCode === 407 ? 'auth' : 'answered', String(data.statusCode));
        return data;
      }, (error: unknown) => {
        const code = errorCode(error);
        if (NODE_DOWN_CODES.has(code) && error && typeof error === 'object') {
          nodeFaults.add(error);
          report('down', code);
        }
        throw error;
      })) as typeof pool.connect;
      return pool;
    },
    factory: (origin, options) => new Pool(origin, {
      ...options,
      connect: boundedTunnel((options as { connect: buildConnector.connector }).connect, tunnelTimeoutMs),
    }),
  });
}
