import fs from 'fs';
import net from 'net';
import { TelegramClient } from 'telegram';
import { ConnectionTCPObfuscated } from 'telegram/network';
import { StringSession } from 'telegram/sessions';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readSqliteSession } from '@/lib/telegram/sessionUtils';
import { HttpConnectSocket } from './httpProxySocket';
import type { OutreachAccount, OutreachProxy } from './types';

/**
 * Threshold for auto-disabling an account that keeps getting
 * 406: AUTH_KEY_DUPLICATED from Telegram (session is shared with another
 * login and can never recover until the user re-authenticates).
 *
 * The counter is persisted in tg_outreach_accounts.auth_key_dup_count and
 * resets to 0 on any successful connect.
 */
const AUTH_KEY_DUP_DISABLE_THRESHOLD = 3;

/**
 * Translate raw gramJS / MTProto error messages into something a non-developer
 * can read while keeping the original technical token in parentheses so
 * engineers can still grep for it.
 *
 * Used by buildClients when logging connection failures to tg_outreach_logs.
 */
function humanizeConnectError(rawMsg: string): string {
  if (rawMsg.includes('AUTH_KEY_DUPLICATED')) {
    return `сессия параллельно открыта с другого устройства (AUTH_KEY_DUPLICATED)`;
  }
  if (rawMsg.includes('AUTH_KEY_UNREGISTERED')) {
    return `Telegram больше не признаёт эту сессию (AUTH_KEY_UNREGISTERED — обычно после смены пароля или ручного выхода)`;
  }
  if (rawMsg.includes('USER_DEACTIVATED_BAN') || rawMsg.includes('USER_DEACTIVATED')) {
    return `Telegram забанил этот номер (${rawMsg.includes('USER_DEACTIVATED_BAN') ? 'USER_DEACTIVATED_BAN' : 'USER_DEACTIVATED'})`;
  }
  if (rawMsg.includes('FLOOD_WAIT')) {
    return `Telegram временно блокирует подключение из-за частых запросов (FLOOD_WAIT)`;
  }
  if (rawMsg.includes('connect timeout')) {
    // rawMsg already contains the actual duration, e.g. "connect timeout (30s)".
    return `прокси или Telegram не отвечают (${rawMsg.trim()} — проверьте прокси или временные проблемы Telegram)`;
  }
  if (rawMsg.includes('PHONE_NUMBER_BANNED')) {
    return `Telegram забанил этот номер при попытке логина (PHONE_NUMBER_BANNED)`;
  }
  if (rawMsg.includes('SESSION_REVOKED')) {
    return `сессия отозвана пользователем вручную (SESSION_REVOKED)`;
  }
  return rawMsg.trim();
}

export const HEARTBEAT_PATH = '/tmp/tg-outreach-heartbeat';
export function writeHeartbeat() {
  try { fs.writeFileSync(HEARTBEAT_PATH, Date.now().toString()); } catch { /* ignore */ }
}

export interface ActiveClient {
  client: TelegramClient;
  account: OutreachAccount;
}

interface ParsedProxy {
  ip: string;
  port: number;
  username?: string;
  password?: string;
  socksType?: 4 | 5;
  protocol: 'http' | 'https' | 'socks4' | 'socks5';
}

function parseProxyUrl(url: string): ParsedProxy | undefined {
  try {
    const u = new URL(url);
    const protocol = u.protocol.replace(':', '') as ParsedProxy['protocol'];
    if (!['socks4', 'socks5', 'http', 'https'].includes(protocol)) return undefined;

    return {
      ip: u.hostname,
      port: Number(u.port) || (protocol.startsWith('socks') ? 1080 : 8080),
      username: u.username || undefined,
      password: u.password || undefined,
      socksType: protocol === 'socks4' ? 4 : protocol === 'socks5' ? 5 : undefined,
      protocol,
    };
  } catch {
    return undefined;
  }
}

export function describeProxyForLog(proxy: OutreachProxy): string {
  const parsed = parseProxyUrl(proxy.url);
  if (!parsed) return `proxy_id=${proxy.id}${proxy.name ? ` "${proxy.name}"` : ''}, url не разобран`;
  return [
    `proxy_id=${proxy.id}`,
    proxy.name ? `name="${proxy.name}"` : null,
    `type=${parsed.protocol}`,
    `host=${parsed.ip}`,
    `port=${parsed.port}`,
    parsed.username ? 'auth=yes' : 'auth=no',
  ].filter(Boolean).join(', ');
}

/**
 * Низкоуровневая TCP-проверка прокси: открываем сокет к host:port прокси и
 * ждём ответа на TCP-уровне. Не проверяет ни SOCKS-handshake, ни HTTP CONNECT —
 * только то, что прокси-сервер вообще принимает соединения.
 *
 * Нужно для диагностики: если connect через gramJS падает по таймауту, нам
 * важно понять — прокси мёртвая (TCP не отвечает) или дело в Telegram
 * (TCP жив, но Telegram не пускает / тормозит).
 */
export async function probeProxyTcp(
  proxy: OutreachProxy,
  timeoutMs = 5_000,
): Promise<{ alive: boolean; latencyMs: number; error?: string }> {
  const parsed = parseProxyUrl(proxy.url);
  if (!parsed) return { alive: false, latencyMs: 0, error: 'не удалось разобрать URL прокси' };

  const start = Date.now();
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result: { alive: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...result, latencyMs: Date.now() - start });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ alive: true }));
    socket.once('timeout', () => finish({ alive: false, error: `TCP таймаут ${timeoutMs / 1000}с` }));
    socket.once('error', (err) => finish({ alive: false, error: err.message }));

    socket.connect(parsed.port, parsed.ip);
  });
}

export type SessionFactory = (storagePath: string) => Promise<string>;

export async function createGramClient(
  account: OutreachAccount,
  proxy: OutreachProxy | null,
  downloadSessionFile?: SessionFactory,
): Promise<TelegramClient> {
  let session: import('telegram/sessions').Session;
  if (account.session_data?.trim()) {
    session = new StringSession(account.session_data);
  } else if (account.session_file_path && downloadSessionFile) {
    const localPath = await downloadSessionFile(account.session_file_path);
    session = await readSqliteSession(localPath);
  } else {
    throw new Error('Нет session_data или session_file_path');
  }

  const proxyConfig = proxy ? parseProxyUrl(proxy.url) : undefined;
  const isHttp = proxyConfig && (proxyConfig.protocol === 'http' || proxyConfig.protocol === 'https');
  const isSocks = proxyConfig && (proxyConfig.socksType === 4 || proxyConfig.socksType === 5);

  const clientOpts: ConstructorParameters<typeof TelegramClient>[3] = {
    connectionRetries: 3,
  };

  if (isHttp && proxyConfig) {
    // HTTP CONNECT tunnel: pass our custom socket class that handles CONNECT handshake.
    // CRITICAL: also use ConnectionTCPObfuscated (port 443, TLS-looking traffic).
    // Without it, gramJS defaults to ConnectionTCPFull on port 80 — which is the
    // HTTP port from the proxy provider's perspective. Infatica/etc see "non-HTTP
    // bytes on port 80" via DPI, log err_protocol, and auto-block our IP.
    const httpProxy = {
      ip: proxyConfig.ip,
      port: proxyConfig.port,
      username: proxyConfig.username,
      password: proxyConfig.password,
    };
    clientOpts.networkSocket = class extends HttpConnectSocket {
      constructor() { super(httpProxy); }
    } as never;
    clientOpts.connection = ConnectionTCPObfuscated;
  } else if (isSocks && proxyConfig) {
    clientOpts.proxy = { ...proxyConfig, socksType: proxyConfig.socksType! };
    clientOpts.connection = ConnectionTCPObfuscated;
  }

  const client = new TelegramClient(session, account.api_id, account.api_hash, clientOpts);

  // 30s default — 15s was too aggressive for mobile proxies that need a TLS
  // handshake + obfuscated MTProto negotiation. Override via env if needed.
  const CONNECT_TIMEOUT_MS = Number(process.env.TG_OUTREACH_CONNECT_TIMEOUT_MS) || 30_000;
  await Promise.race([
    client.connect(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`connect timeout (${CONNECT_TIMEOUT_MS / 1000}s)`)), CONNECT_TIMEOUT_MS),
    ),
  ]);
  return client;
}

/**
 * Force-rebuild a client whose MTProto connection has wedged. Residential/mobile
 * proxies (Infatica) silently drop the long-lived TCP socket half-open (no RST),
 * so gramJS's recvLoop waits forever on bytes that never arrive and its auto-
 * reconnect never fires — every subsequent `getDialogs` hangs until the campaign
 * loop's per-account timeout fires, round after round. The proxy itself is fine
 * (its TCP probe passes); only this stale socket is dead.
 *
 * We tear the old client down — bounding the disconnect so we don't hang on the
 * dead socket — then create a fresh connection through the same proxy. A brand-
 * new socket clears the wedge. createGramClient already bounds the reconnect
 * with its own connect-timeout race, so this call is time-bounded overall.
 */
export async function reconnectClient(
  account: OutreachAccount,
  proxy: OutreachProxy | null,
  oldClient: TelegramClient | null,
  downloadSessionFile?: SessionFactory,
): Promise<TelegramClient> {
  if (oldClient) {
    // disconnect() on a half-open socket can itself stall; race it so a dead
    // connection can't block the rebuild.
    await Promise.race([
      oldClient.disconnect().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  return createGramClient(account, proxy, downloadSessionFile);
}

export async function buildClients(
  accounts: OutreachAccount[],
  proxies: OutreachProxy[],
  log: (level: 'info' | 'warning' | 'error', msg: string) => void,
  downloadSessionFile?: SessionFactory,
  db?: SupabaseClient,
): Promise<ActiveClient[]> {
  const proxyMap = new Map(proxies.map(p => [p.id, p]));
  const clients: ActiveClient[] = [];

  for (const acc of accounts) {
    writeHeartbeat();
    if (!acc.is_active) continue;
    const hasSession = (acc.session_data?.trim()) || (acc.session_file_path && downloadSessionFile);
    if (!hasSession) {
      log('warning', `Аккаунт ${acc.session_name}: нет session_data или .session файла, пропуск`);
      continue;
    }

    const proxy = acc.proxy_id ? proxyMap.get(acc.proxy_id) ?? null : null;
    const proxyParsed = proxy ? parseProxyUrl(proxy.url) : undefined;
    const proxyLabel = proxy
      ? proxyParsed
        ? `${proxyParsed.protocol}://${proxyParsed.ip}:${proxyParsed.port}${proxy.name ? ` «${proxy.name}»` : ''}`
        : `(не удалось разобрать URL прокси)${proxy.name ? ` «${proxy.name}»` : ''}`
      : 'без прокси';
    const accountLabel = `acc_id=${acc.id}${acc.phone ? ` тел=${acc.phone}` : ''}${proxy?.id ? ` proxy_id=${proxy.id}` : ''}`;

    let client: TelegramClient | null = null;
    let lastErr: unknown = null;
    let probeNote = '';
    let retried = false;

    try {
      client = await createGramClient(acc, proxy, downloadSessionFile);
    } catch (err) {
      lastErr = err;
      const errMsg = err instanceof Error ? err.message : String(err);
      const looksLikeConnectIssue = errMsg.includes('connect timeout')
        || errMsg.toLowerCase().includes('timeout')
        || errMsg.toLowerCase().includes('econnrefused')
        || errMsg.toLowerCase().includes('econnreset');

      // Если есть прокси и ошибка похожа на сетевую — диагностируем:
      // TCP-проверка прокси отделяет «прокси мёртвая» от «Telegram временно недоступен».
      if (proxy && looksLikeConnectIssue) {
        const probe = await probeProxyTcp(proxy);
        if (probe.alive) {
          probeNote = ` (TCP-проверка прокси прошла за ${probe.latencyMs}мс — похоже временная проблема Telegram, делаю повторную попытку)`;
          log('warning', `Аккаунт ${acc.session_name}: первая попытка подключения упала — ${humanizeConnectError(errMsg)}.${probeNote} Прокси: ${proxyLabel}.`);
          retried = true;
          try {
            client = await createGramClient(acc, proxy, downloadSessionFile);
            lastErr = null;
          } catch (retryErr) {
            lastErr = retryErr;
          }
        } else {
          probeNote = ` (TCP-проверка прокси не прошла: ${probe.error ?? 'нет ответа'} — прокси мёртвая, ретрай не делаю)`;
        }
      }
    }

    if (client) {
      clients.push({ client, account: acc });
      log('info', `Аккаунт ${acc.session_name}: подключён${retried ? ' со второй попытки' : ''}`);

      // Reset the duplicated-session counter on any successful connect.
      // We only do the DB round-trip when there's something to clear, since
      // the common case is "counter was already 0".
      if (db && (acc.auth_key_dup_count ?? 0) > 0) {
        const { error: resetErr } = await db
          .from('tg_outreach_accounts')
          .update({ auth_key_dup_count: 0 })
          .eq('id', acc.id);
        if (resetErr) {
          log('warning', `Аккаунт ${acc.session_name}: не смог сбросить счётчик ошибок подключения в базе данных — ${resetErr.message}`);
        } else {
          acc.auth_key_dup_count = 0;
        }
      }
    } else {
      const errMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      log('error', `Аккаунт ${acc.session_name}: не удалось подключиться к Telegram${retried ? ' (даже после повторной попытки)' : ''} — ${humanizeConnectError(errMsg)}.${probeNote} Прокси: ${proxyLabel}. [${accountLabel}]`);

      // AUTH_KEY_DUPLICATED means Telegram sees a parallel login on this
      // session. It will never recover from retries — the user has to
      // re-authenticate. We track consecutive failures so a single dead
      // session doesn't keep poisoning every worker restart.
      if (db && errMsg.includes('AUTH_KEY_DUPLICATED')) {
        const next = (acc.auth_key_dup_count ?? 0) + 1;
        if (next >= AUTH_KEY_DUP_DISABLE_THRESHOLD) {
          const { error: updErr } = await db
            .from('tg_outreach_accounts')
            .update({ is_active: false, auth_key_dup_count: next })
            .eq('id', acc.id);
          if (updErr) {
            log('error', `Аккаунт ${acc.session_name}: не смог выключить аккаунт в базе данных — ${updErr.message}`);
          } else {
            log(
              'warning',
              `Аккаунт ${acc.session_name}: 3 неудачные попытки подряд (AUTH_KEY_DUPLICATED) — выключаю автоматически. ` +
                `Чтобы вернуть в работу: на телефоне с этим номером откройте Telegram → Настройки → Конфиденциальность → ` +
                `Активные сеансы → завершите чужие сессии. Затем перевыпустите session_data в UI.`,
            );
          }
        } else {
          const { error: updErr } = await db
            .from('tg_outreach_accounts')
            .update({ auth_key_dup_count: next })
            .eq('id', acc.id);
          if (updErr) {
            log('warning', `Аккаунт ${acc.session_name}: не смог записать счётчик ошибок подключения в базу данных — ${updErr.message}`);
          } else {
            log(
              'warning',
              `Аккаунт ${acc.session_name}: сессия параллельно открыта с другого устройства ` +
                `(AUTH_KEY_DUPLICATED, попытка ${next}/${AUTH_KEY_DUP_DISABLE_THRESHOLD} подряд). ` +
                `После 3 подряд аккаунт будет выключен автоматически.`,
            );
          }
        }
      }
    }
  }

  return clients;
}

export async function disconnectAll(clients: ActiveClient[]) {
  for (const { client, account: _account } of clients) {
    try {
      await client.disconnect();
    } catch {
      // ignore disconnect errors
    }
  }
}

export async function getUpdatedSessionString(client: TelegramClient): Promise<string> {
  const session = client.session;
  if (session instanceof StringSession) {
    return session.save();
  }
  if (typeof (session as { save?: () => unknown }).save === 'function') {
    const out = (session as { save: () => unknown }).save();
    return typeof out === 'string' ? out : '';
  }
  return '';
}
