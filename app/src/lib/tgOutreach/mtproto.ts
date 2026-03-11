import 'server-only';

/**
 * MTProto operations for TG Outreach accounts.
 * Uses the `telegram` (GramJS) package for Telegram API interactions.
 *
 * Each function accepts session data (stored per account) and optional proxy config,
 * establishes a connection, performs the operation, then disconnects.
 */

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

async function createClient(sessionData: Record<string, unknown>, proxy?: ProxyConfig | null) {
  const sessionString = (sessionData?.session_string as string) ?? '';
  const session = new StringSession(sessionString);

  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 3,
    proxy: buildProxyOptions(proxy),
  });

  await client.connect();
  return client;
}

export async function checkAccountStatus(
  sessionData: Record<string, unknown>,
  proxy?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let client;
  try {
    client = await createClient(sessionData, proxy as ProxyConfig);
    const me = await client.getMe();
    const restricted = me?.restricted ?? false;
    let status: string = 'active';
    if (restricted) status = 'limited';
    if (me?.deleted) status = 'banned';

    return {
      success: true,
      status,
      phone: me?.phone ?? '',
      username: me?.username ?? '',
      first_name: me?.firstName ?? '',
      last_name: me?.lastName ?? '',
      restricted,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('USER_DEACTIVATED') || msg.includes('AUTH_KEY_UNREGISTERED')) {
      return { success: false, status: 'banned', error: msg };
    }
    return { success: false, error: msg };
  } finally {
    if (client) await client.disconnect().catch(() => {});
  }
}

export async function checkViaSpambot(
  sessionData: Record<string, unknown>,
  proxy?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let client;
  try {
    client = await createClient(sessionData, proxy as ProxyConfig);

    const spamBot = await client.getEntity('SpamBot');
    await client.sendMessage(spamBot, { message: '/start' });

    await new Promise((r) => setTimeout(r, 3000));

    const messages = await client.getMessages(spamBot, { limit: 1 });
    const response = messages?.[0]?.message ?? '';

    let status: string | undefined;
    if (response.includes('free') || response.includes('нет ограничений')) {
      status = 'active';
    } else if (response.includes('limit') || response.includes('ограничен')) {
      status = 'limited';
    }

    return { success: true, response, status };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (client) await client.disconnect().catch(() => {});
  }
}

export async function syncProfileFromTelegram(
  sessionData: Record<string, unknown>,
  proxy?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let client;
  try {
    client = await createClient(sessionData, proxy as ProxyConfig);
    const me = await client.getMe();
    const fullUser = await client.invoke(new Api.users.GetFullUser({ id: new Api.InputUserSelf() }));
    const about = fullUser?.fullUser?.about ?? '';

    return {
      success: true,
      profile: {
        first_name: me?.firstName ?? '',
        last_name: me?.lastName ?? '',
        username: me?.username ?? '',
        bio: about,
        phone: me?.phone ?? '',
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (client) await client.disconnect().catch(() => {});
  }
}

export async function requestUnfreeze(
  sessionData: Record<string, unknown>,
  proxy?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let client;
  try {
    client = await createClient(sessionData, proxy as ProxyConfig);
    const result = await client.invoke(new Api.account.ResetAuthorization({ hash: BigInt(0) })).catch(() => null);
    return { success: true, message: 'Unfreeze request sent', result };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (client) await client.disconnect().catch(() => {});
  }
}

export async function removeSpamblock(
  sessionData: Record<string, unknown>,
  proxy?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let client;
  try {
    client = await createClient(sessionData, proxy as ProxyConfig);

    const spamBot = await client.getEntity('SpamBot');
    await client.sendMessage(spamBot, { message: '/start' });
    await new Promise((r) => setTimeout(r, 2000));

    const msgs = await client.getMessages(spamBot, { limit: 3 });
    const lastMsg = msgs?.[0];

    if (lastMsg?.buttons?.length) {
      for (const row of lastMsg.buttons) {
        for (const btn of row) {
          const text = (btn.text ?? '').toLowerCase();
          if (text.includes('dispute') || text.includes('оспорить') || text.includes('это ошибка')) {
            await btn.click();
            return { success: true, message: 'Spamblock dispute submitted' };
          }
        }
      }
    }

    return { success: true, message: 'No dispute button found in SpamBot response' };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (client) await client.disconnect().catch(() => {});
  }
}

export async function unblockAccount(
  sessionData: Record<string, unknown>,
  proxy?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let client;
  try {
    client = await createClient(sessionData, proxy as ProxyConfig);
    const me = await client.getMe();
    if (!me) {
      return { success: false, error: 'Cannot retrieve account info — account may be permanently banned' };
    }
    return {
      success: true,
      message: 'Account is accessible',
      status: me.restricted ? 'limited' : 'active',
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (client) await client.disconnect().catch(() => {});
  }
}
