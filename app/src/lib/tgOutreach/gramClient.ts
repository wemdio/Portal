import fs from 'fs';
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

  const CONNECT_TIMEOUT_MS = 15_000;
  await Promise.race([
    client.connect(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`connect timeout (${CONNECT_TIMEOUT_MS / 1000}s)`)), CONNECT_TIMEOUT_MS),
    ),
  ]);
  return client;
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

    try {
      const proxy = acc.proxy_id ? proxyMap.get(acc.proxy_id) ?? null : null;
      const client = await createGramClient(acc, proxy, downloadSessionFile);
      clients.push({ client, account: acc });
      log('info', `Аккаунт ${acc.session_name}: подключён`);

      // Reset the duplicated-session counter on any successful connect.
      // We only do the DB round-trip when there's something to clear, since
      // the common case is "counter was already 0".
      if (db && (acc.auth_key_dup_count ?? 0) > 0) {
        await db
          .from('tg_outreach_accounts')
          .update({ auth_key_dup_count: 0 })
          .eq('id', acc.id)
          .then(() => {});
        acc.auth_key_dup_count = 0;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log('error', `Аккаунт ${acc.session_name}: ошибка подключения — ${errMsg}`);

      // AUTH_KEY_DUPLICATED means Telegram sees a parallel login on this
      // session. It will never recover from retries — the user has to
      // re-authenticate. We track consecutive failures so a single dead
      // session doesn't keep poisoning every worker restart.
      if (db && errMsg.includes('AUTH_KEY_DUPLICATED')) {
        const next = (acc.auth_key_dup_count ?? 0) + 1;
        if (next >= AUTH_KEY_DUP_DISABLE_THRESHOLD) {
          await db
            .from('tg_outreach_accounts')
            .update({ is_active: false, auth_key_dup_count: next })
            .eq('id', acc.id)
            .then(() => {});
          log(
            'warning',
            `${acc.session_name}: ${next} подряд AUTH_KEY_DUPLICATED → аккаунт выключен. ` +
              `Перелогиньте сессию (Telegram → Settings → Active Sessions → terminate others), ` +
              `затем заново загрузите session_data в UI.`,
          );
        } else {
          await db
            .from('tg_outreach_accounts')
            .update({ auth_key_dup_count: next })
            .eq('id', acc.id)
            .then(() => {});
          log(
            'warning',
            `${acc.session_name}: AUTH_KEY_DUPLICATED (${next}/${AUTH_KEY_DUP_DISABLE_THRESHOLD}) — ` +
              `после ${AUTH_KEY_DUP_DISABLE_THRESHOLD} подряд выключим автоматически.`,
          );
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
