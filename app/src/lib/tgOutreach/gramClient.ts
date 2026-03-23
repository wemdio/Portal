import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import type { OutreachAccount, OutreachProxy } from './types';

export interface ActiveClient {
  client: TelegramClient;
  account: OutreachAccount;
}

/**
 * Read a Telethon/GramJS .session SQLite file and return a StringSession.
 * Avoids gramjs-sqlitesession which is incompatible with newer GramJS versions.
 */
function readSqliteSession(filePath: string): Promise<StringSession> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqlite3Module = require('sqlite3') as typeof import('sqlite3');

  return new Promise((resolve, reject) => {
    const db = new sqlite3Module.Database(filePath, sqlite3Module.OPEN_READONLY, (err) => {
      if (err) return reject(err);

      db.get(
        'SELECT dc_id, server_address, port, auth_key FROM sessions LIMIT 1',
        (err2: Error | null, row?: { dc_id: number; server_address: string; port: number; auth_key: Buffer }) => {
          db.close();
          if (err2) return reject(err2);
          if (!row?.auth_key) return reject(new Error('Пустая сессия в SQLite файле'));

          const isIPv6 = row.server_address.includes(':');
          const addressBuf = isIPv6
            ? Buffer.from(
                row.server_address.split(':').flatMap((p) => {
                  const n = parseInt(p, 16);
                  return [(n >> 8) & 255, n & 255];
                }),
              )
            : Buffer.from(row.server_address.split('.').map((p) => parseInt(p, 10)));

          const dcBuf = Buffer.from([row.dc_id]);
          const portBuf = Buffer.alloc(2);
          portBuf.writeInt16BE(row.port, 0);
          const keyBuf = Buffer.isBuffer(row.auth_key) ? row.auth_key : Buffer.from(row.auth_key);

          const result = Buffer.concat([dcBuf, addressBuf, portBuf, keyBuf.subarray(0, 256)]);
          resolve(new StringSession('1' + result.toString('base64')));
        },
      );
    });
  });
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
  downloadSessionFile?: SessionFactory,
): Promise<ActiveClient[]> {
  const proxyMap = new Map(proxies.map(p => [p.id, p]));
  const clients: ActiveClient[] = [];

  for (const acc of accounts) {
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
