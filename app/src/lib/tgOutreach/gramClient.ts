import fs from 'fs';
import { TelegramClient } from 'telegram';
import { ConnectionTCPObfuscated } from 'telegram/network';
import { StringSession } from 'telegram/sessions';
import { readSqliteSession } from '@/lib/telegram/sessionUtils';
import { HttpConnectSocket } from './httpProxySocket';
import type { OutreachAccount, OutreachProxy } from './types';

const HEARTBEAT_PATH = '/tmp/tg-outreach-heartbeat';
function writeHeartbeat() {
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
    } catch (err) {
      log('error', `Аккаунт ${acc.session_name}: ошибка подключения — ${err instanceof Error ? err.message : String(err)}`);
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
