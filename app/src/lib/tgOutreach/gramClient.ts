import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import type { OutreachAccount, OutreachProxy } from './types';

export interface ActiveClient {
  client: TelegramClient;
  account: OutreachAccount;
}

function parseProxyUrl(url: string): { ip: string; port: number; username?: string; password?: string; socksType?: 4 | 5 } | undefined {
  try {
    const u = new URL(url);
    const protocol = u.protocol.replace(':', '');
    if (!['socks4', 'socks5', 'http', 'https'].includes(protocol)) return undefined;

    return {
      ip: u.hostname,
      port: Number(u.port) || (protocol.startsWith('socks') ? 1080 : 8080),
      username: u.username || undefined,
      password: u.password || undefined,
      socksType: protocol === 'socks4' ? 4 : protocol === 'socks5' ? 5 : undefined,
    };
  } catch {
    return undefined;
  }
}

export async function createGramClient(
  account: OutreachAccount,
  proxy: OutreachProxy | null,
): Promise<TelegramClient> {
  const session = new StringSession(account.session_data);
  const proxyConfig = proxy ? parseProxyUrl(proxy.url) : undefined;
  const proxyParams =
    proxyConfig && (proxyConfig.socksType === 4 || proxyConfig.socksType === 5)
      ? { proxy: { ...proxyConfig, socksType: proxyConfig.socksType } }
      : {};

  const client = new TelegramClient(session, account.api_id, account.api_hash, {
    connectionRetries: 3,
    ...proxyParams,
  });

  await client.connect();
  return client;
}

export async function buildClients(
  accounts: OutreachAccount[],
  proxies: OutreachProxy[],
  log: (level: 'info' | 'warning' | 'error', msg: string) => void,
): Promise<ActiveClient[]> {
  const proxyMap = new Map(proxies.map(p => [p.id, p]));
  const clients: ActiveClient[] = [];

  for (const acc of accounts) {
    if (!acc.is_active) continue;
    if (!acc.session_data) {
      log('warning', `Аккаунт ${acc.session_name}: нет session_data, пропуск`);
      continue;
    }

    try {
      const proxy = acc.proxy_id ? proxyMap.get(acc.proxy_id) ?? null : null;
      const client = await createGramClient(acc, proxy);
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
  const session = client.session as StringSession;
  return session.save();
}
