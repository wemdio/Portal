import 'server-only';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TelegramClient } = require('telegram');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { StringSession } = require('telegram/sessions');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Api } = require('telegram/tl');

const API_ID = Number(process.env.TG_API_ID ?? '0');
const API_HASH = process.env.TG_API_HASH ?? '';

interface ProxyConfig {
  ip?: string;
  port?: number;
  type?: string;
  login?: string;
  password?: string;
}

function buildProxyOptions(proxy?: ProxyConfig | null) {
  if (!proxy?.ip) return undefined;
  const socksTypes = ['SOCKS4', 'SOCKS5'];
  return {
    ip: proxy.ip,
    port: proxy.port ?? 80,
    socksType: socksTypes.includes(proxy.type ?? '') ? (proxy.type === 'SOCKS4' ? 4 : 5) : undefined,
    MTProxy: proxy.type === 'HTTP',
    username: proxy.login || undefined,
    password: proxy.password || undefined,
  };
}

export interface SessionSource {
  session_data?: Record<string, unknown> | null;
  proxy?: ProxyConfig | null;
}

function extractSessionString(source: SessionSource): string {
  const sd = source.session_data;
  if (!sd) return '';
  if (typeof sd === 'string') return sd;
  return (sd.session_string as string) ?? '';
}

async function createClient(source: SessionSource) {
  const sessionString = extractSessionString(source);
  if (!sessionString) throw new Error('Аккаунт не имеет session_string');

  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 3,
    proxy: buildProxyOptions(source.proxy),
  });

  await client.connect();
  return client;
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

export async function sendMessageViaAccount(
  source: SessionSource,
  tgUserId: number,
  text: string,
  clearDraft: boolean = false,
): Promise<SendResult> {
  if (!API_ID || !API_HASH) {
    return { ok: false, error: 'TG_API_ID / TG_API_HASH не заданы в .env' };
  }

  let client: InstanceType<typeof TelegramClient> | null = null;
  try {
    client = await createClient(source);
    await client.getDialogs({ limit: 50 });
    const entity = await client.getEntity(tgUserId);
    await client.sendMessage(entity, { message: text });

    if (clearDraft) {
      try {
        await client.invoke(new Api.messages.SaveDraft({ peer: entity, message: '' }));
      } catch {
        // non-critical
      }
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (client) {
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  }
}
