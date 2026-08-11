/**
 * Проверка прокси кампании: два независимых вердикта на каждый прокси.
 *
 *   1) прокси вообще работает — принимает соединение и умеет прокладывать
 *      через себя туннель;
 *   2) через него доходит Telegram — туннель до адреса дата-центра Telegram
 *      действительно открывается.
 *
 * Разделение — это и есть весь смысл проверки. Мёртвый прокси — проблема
 * провайдера, её решает замена порта в пуле. Живой прокси, через который не
 * проходит Telegram, означает почти наверняка блокировку: аккаунты на нём
 * молча перестанут работать, и по логам это выглядит так же, как «сессия
 * отвалилась». Оператор должен видеть разницу сразу, а не гадать.
 *
 * Чего здесь намеренно НЕТ: никакого логина, никакой сессии аккаунта, никакого
 * рукопожатия MTProto. Подключение боевым ключом авторизации из неожиданного
 * места — ровно то, из-за чего у нас отзывают аккаунты (инцидент с
 * SESSION_REVOKED пачками, август 2026). Проверяем прокси, а не аккаунт:
 * установленный TCP-туннель до адреса дата-центра доказывает проходимость и не
 * посылает в сеть ни байта, по которому нас можно опознать.
 */

import net from 'net';
import { probeProxyTcp, parseProxyUrl, type ParsedProxy } from './gramClient';
import { openHttpConnectTunnel, HttpConnectRejectedError } from './httpProxySocket';
import { withTimeout } from './withTimeout';

/**
 * Куда стучимся, чтобы проверить проходимость Telegram: main-адрес DC 2
 * (`DC_MAPPING_PROD[2].main` из `@mtcute/convert`). Константа продублирована, а
 * не импортирована, чтобы ради двух чисел не тащить в серверную ручку пакет
 * конвертации tdata; совпадение с источником закреплено тестом.
 *
 * DC 2 — «дефолтный» дата-центр для наших номеров, и он же тот, куда пойдёт
 * реальное подключение аккаунта. Проверять DC, которым мы не пользуемся,
 * смысла нет: блокировки у провайдеров бывают точечные, по адресам.
 */
export const TELEGRAM_PROBE_TARGET = { host: '149.154.167.41', port: 443 } as const;

/** TCP-проба самого прокси. 5с — тот же порог, что у воркера (gramClient). */
export const PROXY_TCP_TIMEOUT_MS = Number(process.env.TG_OUTREACH_PROXY_CHECK_TCP_TIMEOUT_MS) || 5_000;

/**
 * Открытие туннеля до Telegram. 10с, а не 40с как у боевого подключения:
 * там мы боремся за живой аккаунт и готовы ждать занятый модем, здесь оператор
 * смотрит на экран. Прокси, которому не хватило 10с на CONNECT, для рассылки
 * всё равно непригоден.
 */
export const TELEGRAM_TUNNEL_TIMEOUT_MS = Number(process.env.TG_OUTREACH_PROXY_CHECK_TUNNEL_TIMEOUT_MS) || 10_000;

/**
 * Сколько прокси проверяем одновременно.
 *
 * По одному — 40 прокси в худшем случае это 40 × 15с = 10 минут, оператор
 * столько не ждёт. Все сразу — 40 одновременных CONNECT с одного нашего IP в
 * один мобильный пул выглядят как скан, а провайдеры на такое реагируют
 * блокировкой нашего IP (прецедент с err_protocol у Infatica). 10 — компромисс:
 * худший случай для 40 мёртвых прокси ≈ 4 волны × 15с ≈ минута, при этом
 * одновременно открыто не больше 10 сокетов.
 */
export const PROXY_CHECK_CONCURRENCY = 10;

export type ProxyCheckStatus =
  /** и прокси жив, и Telegram через него доступен */
  | 'ok'
  /** строку прокси не удалось разобрать — до сети даже не дошли */
  | 'bad_url'
  /** прокси не отвечает на TCP */
  | 'proxy_dead'
  /** прокси отвечает, но нас не пускает: учётка или белый список IP */
  | 'proxy_rejected'
  /** прокси работает, но туннель до Telegram не открылся */
  | 'telegram_unreachable'
  /** непредвиденный сбой самой проверки */
  | 'error';

export interface ProxyCheckResult {
  id: string;
  name: string | null;
  /** Прокси принимает соединения и готов прокладывать туннель. */
  proxy_ok: boolean;
  /** Сколько миллисекунд заняла проверка самого прокси; null — не проверяли. */
  proxy_latency_ms: number | null;
  /** Туннель до дата-центра Telegram через этот прокси открылся. */
  telegram_ok: boolean;
  /** Сколько миллисекунд заняло открытие туннеля; null — не пробовали. */
  telegram_latency_ms: number | null;
  status: ProxyCheckStatus;
  /** Человеческая причина отказа по-русски; null, когда всё хорошо. */
  reason: string | null;
}

export interface ProxyCheckInput {
  id: string;
  url: string;
  name?: string | null;
}

export interface ProxyCheckOptions {
  tcpTimeoutMs?: number;
  tunnelTimeoutMs?: number;
  /** Куда проверять проходимость. Подменяется в тестах на локальную заглушку. */
  target?: { host: string; port: number };
  concurrency?: number;
}

/** Прокси ответил, но пускать нас отказался (учётка, белый список, ACL). */
class ProxyRejectedError extends Error {}

/**
 * Коды сокета в человеческий текст. Оператор читает результат проверки сам, и
 * «ECONNREFUSED» ему ничего не говорит — но и выкидывать код нельзя, по нему
 * разработчик потом ищет проблему в логах провайдера.
 */
function humanizeNetError(raw: string): string {
  if (/ECONNREFUSED/i.test(raw)) return 'прокси не принимает соединения (ECONNREFUSED)';
  if (/ETIMEDOUT|таймаут|нет ответа за/i.test(raw)) return `нет ответа (${raw})`;
  if (/ECONNRESET/i.test(raw)) return 'прокси разорвал соединение (ECONNRESET)';
  if (/EHOSTUNREACH|ENETUNREACH/i.test(raw)) return 'до прокси нет маршрута (EHOSTUNREACH)';
  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) return 'не удалось разрешить адрес прокси (DNS)';
  return raw;
}

function isTimeout(raw: string): boolean {
  return /timeout|таймаут|нет ответа за/i.test(raw);
}

/** Установить TCP-соединение с ограничением по времени. */
function connectSocket(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.once('timeout', () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('timeout'));
    });
    socket.once('error', (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    });
    socket.connect(port, host);
  });
}

/**
 * Читалка «ровно N байт» поверх сокета. Нужна SOCKS-рукопожатию: ответы там
 * фиксированной длины, а TCP не обязан приносить их одним куском.
 */
function makeReader(socket: net.Socket): (need: number) => Promise<Buffer> {
  let buffer = Buffer.alloc(0);
  let pending: { need: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  let failure: Error | null = null;

  const flush = () => {
    if (!pending) return;
    if (buffer.length >= pending.need) {
      const { need, resolve } = pending;
      pending = null;
      const out = buffer.subarray(0, need);
      buffer = buffer.subarray(need);
      resolve(out);
      return;
    }
    if (failure) {
      const { reject } = pending;
      pending = null;
      reject(failure);
    }
  };

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    flush();
  });
  socket.on('error', (err) => {
    failure = err;
    flush();
  });
  socket.on('close', () => {
    failure ??= new Error('прокси закрыл соединение');
    flush();
  });

  return (need: number) =>
    new Promise<Buffer>((resolve, reject) => {
      pending = { need, resolve, reject };
      flush();
    });
}

/**
 * SOCKS5/SOCKS4: открыть туннель до target.
 *
 * Пишем руками, а не тянем библиотеку: адрес назначения у нас всегда
 * IPv4-литерал, поэтому от протокола нужен ровно один сценарий — CONNECT к
 * IPv4. Заодно это позволяет отличить «прокси не пустил нас» (провал
 * аутентификации) от «прокси не дотянулся до Telegram» (код ответа на CONNECT),
 * чего готовые клиенты в ошибке обычно не сохраняют.
 */
async function openSocksTunnel(
  parsed: ParsedProxy,
  target: { host: string; port: number },
  timeoutMs: number,
): Promise<net.Socket> {
  const socket = await connectSocket(parsed.ip, parsed.port, timeoutMs);
  const read = makeReader(socket);
  const ipBytes = target.host.split('.').map((p) => Number(p));
  const portBytes = Buffer.from([target.port >> 8, target.port & 0xff]);

  const handshake = async () => {
    if (parsed.socksType === 4) {
      // SOCKS4: VN=4, CD=1 (CONNECT), порт, IP, userid, 0x00.
      const userId = Buffer.from(parsed.username ?? '', 'utf8');
      socket.write(Buffer.concat([
        Buffer.from([0x04, 0x01]),
        portBytes,
        Buffer.from(ipBytes),
        userId,
        Buffer.from([0x00]),
      ]));
      const reply = await read(8);
      if (reply[1] !== 0x5a) {
        // 0x5b — отказ (в том числе по идентификации), 0x5c/0x5d — проблемы с
        // identd, то есть всё это про сам прокси, а не про Telegram.
        throw new ProxyRejectedError(`SOCKS4 отказал, код ${reply[1]}`);
      }
      return;
    }

    // SOCKS5. Предлагаем «без аутентификации» и «логин/пароль» — какой из них
    // выберет прокси, зависит от его настроек, а не от наличия у нас учётки.
    const methods = parsed.username ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, methods.length, ...methods]));
    const greeting = await read(2);
    if (greeting[1] === 0xff) {
      throw new ProxyRejectedError('SOCKS5 не принял ни один способ авторизации');
    }
    if (greeting[1] === 0x02) {
      if (!parsed.username) throw new ProxyRejectedError('SOCKS5 требует логин и пароль, а их нет в строке прокси');
      const user = Buffer.from(parsed.username, 'utf8');
      const pass = Buffer.from(parsed.password ?? '', 'utf8');
      socket.write(Buffer.concat([
        Buffer.from([0x01, user.length]), user,
        Buffer.from([pass.length]), pass,
      ]));
      const authReply = await read(2);
      if (authReply[1] !== 0x00) throw new ProxyRejectedError('SOCKS5 не принял логин и пароль');
    }

    socket.write(Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x01]),
      Buffer.from(ipBytes),
      portBytes,
    ]));
    // Ответ на CONNECT для ATYP=IPv4 — ровно 10 байт.
    const reply = await read(10);
    if (reply[1] !== 0x00) {
      // Код 0x02 (доступ запрещён правилами) — про прокси. Остальное
      // (host unreachable, connection refused, TTL expired) — про цель.
      if (reply[1] === 0x02) throw new ProxyRejectedError('SOCKS5 запретил соединение правилами (код 2)');
      throw new Error(`SOCKS5 не смог соединиться с адресом Telegram (код ${reply[1]})`);
    }
  };

  try {
    await withTimeout(handshake(), timeoutMs, 'туннель до Telegram');
    return socket;
  } catch (e) {
    socket.destroy();
    throw e;
  }
}

/** Открыть туннель нужным способом в зависимости от типа прокси. */
function openTunnel(
  parsed: ParsedProxy,
  target: { host: string; port: number },
  timeoutMs: number,
): Promise<net.Socket> {
  if (parsed.protocol === 'socks4' || parsed.protocol === 'socks5') {
    return openSocksTunnel(parsed, target, timeoutMs);
  }
  return openHttpConnectTunnel(
    { ip: parsed.ip, port: parsed.port, username: parsed.username, password: parsed.password },
    target.host,
    target.port,
    timeoutMs,
  );
}

/**
 * Проверить один прокси. Никогда не бросает: проверка идёт пачкой, и один
 * сломанный прокси не должен обрывать остальные — его беда становится строкой
 * результата.
 */
export async function checkProxy(
  proxy: ProxyCheckInput,
  opts: ProxyCheckOptions = {},
): Promise<ProxyCheckResult> {
  const base = { id: proxy.id, name: proxy.name ?? null };
  const parsed = parseProxyUrl(proxy.url);
  if (!parsed) {
    return {
      ...base,
      proxy_ok: false,
      proxy_latency_ms: null,
      telegram_ok: false,
      telegram_latency_ms: null,
      status: 'bad_url',
      reason: 'не удалось разобрать строку прокси — проверьте формат',
    };
  }

  const tcpTimeout = opts.tcpTimeoutMs ?? PROXY_TCP_TIMEOUT_MS;
  const tunnelTimeout = opts.tunnelTimeoutMs ?? TELEGRAM_TUNNEL_TIMEOUT_MS;
  const target = opts.target ?? TELEGRAM_PROBE_TARGET;

  // Вердикт 1. Сначала самое дешёвое: отвечает ли прокси на TCP вообще.
  // Если нет — второй вердикт выносить не по чему, туннель строить не из чего.
  const probe = await probeProxyTcp(proxy, tcpTimeout);
  if (!probe.alive) {
    return {
      ...base,
      proxy_ok: false,
      proxy_latency_ms: probe.latencyMs,
      telegram_ok: false,
      telegram_latency_ms: null,
      status: 'proxy_dead',
      reason: `прокси не отвечает: ${humanizeNetError(probe.error ?? 'нет ответа')}`,
    };
  }

  // Вердикт 2. Туннель до дата-центра Telegram. Дальше открытия туннеля не
  // идём принципиально — см. шапку файла.
  const startedAt = Date.now();
  try {
    const socket = await openTunnel(parsed, target, tunnelTimeout);
    const latency = Date.now() - startedAt;
    socket.destroy();
    return {
      ...base,
      proxy_ok: true,
      proxy_latency_ms: probe.latencyMs,
      telegram_ok: true,
      telegram_latency_ms: latency,
      status: 'ok',
      reason: null,
    };
  } catch (e) {
    const latency = Date.now() - startedAt;
    const raw = e instanceof Error ? e.message : String(e);

    // Прокси ответил, но пускать нас отказался — это про прокси, а не про
    // Telegram: менять его надо, но провайдер тут ни при чём, скорее учётка
    // или наш IP вне белого списка.
    const rejectedByProxy =
      e instanceof ProxyRejectedError ||
      (e instanceof HttpConnectRejectedError && [401, 403, 407].includes(e.statusCode));
    if (rejectedByProxy) {
      const detail = e instanceof HttpConnectRejectedError
        ? `HTTP ${e.statusCode} — неверный логин/пароль или наш IP не в белом списке`
        : raw;
      return {
        ...base,
        proxy_ok: false,
        proxy_latency_ms: probe.latencyMs,
        telegram_ok: false,
        telegram_latency_ms: null,
        status: 'proxy_rejected',
        reason: `прокси отвечает, но не пускает: ${detail}`,
      };
    }

    // Всё остальное: прокси живой (TCP прошёл, а часто и HTTP-ответ пришёл), но
    // канал до Telegram не встал. Это и есть «прокси заблокирован» — аккаунты
    // на нём молча перестанут работать.
    const detail = e instanceof HttpConnectRejectedError
      ? `прокси ответил ${e.statusCode} на запрос туннеля`
      : isTimeout(raw)
        ? `туннель не открылся за ${Math.round(tunnelTimeout / 1000)}с`
        : humanizeNetError(raw);
    return {
      ...base,
      proxy_ok: true,
      proxy_latency_ms: probe.latencyMs,
      telegram_ok: false,
      telegram_latency_ms: latency,
      status: 'telegram_unreachable',
      reason: `прокси жив, но Telegram через него недоступен: ${detail}`,
    };
  }
}

/**
 * Проверить пачку прокси с ограничением на число одновременных проверок.
 * Порядок результатов совпадает с порядком входа — интерфейсу не приходится
 * пересобирать список по id.
 */
export async function checkProxies(
  proxies: ProxyCheckInput[],
  opts: ProxyCheckOptions = {},
): Promise<ProxyCheckResult[]> {
  const limit = Math.max(1, opts.concurrency ?? PROXY_CHECK_CONCURRENCY);
  const results: ProxyCheckResult[] = new Array(proxies.length);
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= proxies.length) return;
      try {
        results[index] = await checkProxy(proxies[index], opts);
      } catch (e) {
        // checkProxy обещает не бросать, но если однажды нарушит обещание —
        // проверка остальных прокси всё равно не должна разваливаться.
        results[index] = {
          id: proxies[index].id,
          name: proxies[index].name ?? null,
          proxy_ok: false,
          proxy_latency_ms: null,
          telegram_ok: false,
          telegram_latency_ms: null,
          status: 'error',
          reason: `сбой проверки: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, proxies.length) }, worker));
  return results;
}
