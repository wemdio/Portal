import 'server-only';

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { getSalesChatApiCreds, getSalesChatProxyUrl } from './config';

/**
 * Изолированная фабрика GramJS-клиента для инструмента «Анализатор сейлз-переписок».
 * НЕ переиспользует tgOutreach/gramClient.ts — это полностью отдельный код.
 */

function parseSocksProxy(proxyUrl: string) {
  if (!proxyUrl) return undefined;
  try {
    const u = new URL(proxyUrl);
    const protocol = u.protocol.replace(':', '').toLowerCase();
    if (protocol !== 'socks4' && protocol !== 'socks5') return undefined;
    return {
      ip: u.hostname,
      port: Number(u.port) || 1080,
      username: u.username || undefined,
      password: u.password || undefined,
      socksType: (protocol === 'socks4' ? 4 : 5) as 4 | 5,
    };
  } catch {
    return undefined;
  }
}

/** Создаёт (не подключённый) TelegramClient из строки сессии. */
export function createSalesChatClient(sessionString: string): TelegramClient {
  const { apiId, apiHash } = getSalesChatApiCreds();
  const proxy = parseSocksProxy(getSalesChatProxyUrl());
  const session = new StringSession(sessionString);
  return new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    deviceModel: 'Portal Sales Analyzer',
    systemVersion: 'Windows 11',
    appVersion: '1.0.0',
    langCode: 'ru',
    systemLangCode: 'ru',
    ...(proxy ? { proxy } : {}),
  });
}
