/**
 * TG User Parser – GramJS-based parser for chat messages, members, and comments.
 * All logic in TypeScript, no Python.
 */
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import type { ParsedUser, ParseOptions, ParseSource, OnlineStatus, TgParserAccount } from './types';

function getEnvCredentials(): { apiId: number; apiHash: string; proxyUrl: string } {
  return {
    apiId: Number(process.env.TGPARS_API_ID || process.env.TELEGRAM_API_ID || '0'),
    apiHash: process.env.TGPARS_API_HASH || process.env.TELEGRAM_API_HASH || '',
    proxyUrl: process.env.TGPARS_PROXY?.trim() || '',
  };
}

const MALE_NAMES = new Set([
  'александр', 'алексей', 'андрей', 'артём', 'артем', 'борис', 'вадим', 'виктор', 'владимир',
  'дмитрий', 'евгений', 'егор', 'иван', 'игорь', 'кирилл', 'максим', 'михаил', 'никита',
  'олег', 'павел', 'роман', 'сергей', 'юрий',
]);
const FEMALE_NAMES = new Set([
  'анастасия', 'анна', 'валентина', 'виктория', 'дарья', 'евгения', 'екатерина', 'елена',
  'мария', 'наталья', 'ольга', 'полина', 'светлана', 'татьяна', 'юлия',
]);

function detectGender(firstName: string | undefined): string {
  if (!firstName) return 'Не определён';
  const name = firstName.toLowerCase().trim();
  if (MALE_NAMES.has(name)) return 'Мужской';
  if (FEMALE_NAMES.has(name)) return 'Женский';
  if (/[ая]$/.test(name)) return 'Женский';
  if (/[йнр]$/.test(name)) return 'Мужской';
  return 'Не определён';
}

function getOnlineStatus(status: Api.TypeUserStatus | undefined): { status: OnlineStatus; lastSeen: Date | null } {
  if (!status) return { status: 'unknown', lastSeen: null };
  const className = status.className || '';
  if (className === 'UserStatusOnline') return { status: 'online', lastSeen: new Date() };
  if (className === 'UserStatusOffline') {
    const u = status as Api.UserStatusOffline;
    return { status: 'recently', lastSeen: u.wasOnline ? new Date(u.wasOnline * 1000) : null };
  }
  if (className === 'UserStatusRecently') return { status: 'recently', lastSeen: null };
  if (className === 'UserStatusLastWeek') return { status: 'within_week', lastSeen: null };
  if (className === 'UserStatusLastMonth') return { status: 'within_month', lastSeen: null };
  return { status: 'unknown', lastSeen: null };
}

function filterByOnline(
  status: OnlineStatus,
  lastSeen: Date | null,
  opts: ParseOptions
): boolean {
  if (opts.filter_online && status !== 'online') return false;
  if (opts.filter_recently && status !== 'online' && status !== 'recently') return false;
  if (opts.max_offline_days != null) {
    if (status === 'online') return true;
    if (lastSeen) {
      const days = (Date.now() - lastSeen.getTime()) / (24 * 60 * 60 * 1000);
      return days <= opts.max_offline_days;
    }
    if (status === 'recently') return opts.max_offline_days >= 1;
    if (status === 'within_week') return opts.max_offline_days >= 7;
    if (status === 'within_month') return opts.max_offline_days >= 30;
    return false;
  }
  return true;
}

function parseProxyUrl(proxyUrl: string): { ip: string; port: number; username?: string; password?: string; socksType: 4 | 5 } | undefined {
  if (!proxyUrl) return undefined;
  try {
    const u = new URL(proxyUrl);
    const protocol = u.protocol.replace(':', '').toLowerCase();
    return {
      ip: u.hostname,
      port: Number(u.port) || 1080,
      username: u.username || undefined,
      password: u.password || undefined,
      socksType: protocol === 'socks4' ? 4 : 5,
    };
  } catch {
    return undefined;
  }
}

async function getClient(account?: TgParserAccount): Promise<TelegramClient> {
  let apiId: number;
  let apiHash: string;
  let sessionStr: string;
  let proxyUrl: string;

  if (account) {
    apiId = account.api_id;
    apiHash = account.api_hash;
    sessionStr = account.session_data;
    proxyUrl = account.proxy_url ?? '';
  } else {
    throw new Error('Аккаунт обязателен. Добавьте Telegram-аккаунт через UI.');
  }

  if (!apiId || !apiHash) {
    throw new Error('API ID и API Hash обязательны. Добавьте аккаунт через UI.');
  }
  if (!sessionStr) {
    throw new Error('Session string обязателен. Добавьте аккаунт через UI.');
  }

  const proxy = parseProxyUrl(proxyUrl);

  const client = new TelegramClient(
    new StringSession(sessionStr),
    apiId,
    apiHash,
    { connectionRetries: 3, ...(proxy ? { proxy } : {}) }
  );
  await client.connect();
  if (!(await client.checkAuthorization())) {
    throw new Error('Сессия не авторизована. Session string мог истечь.');
  }
  return client;
}

async function userToParsed(
  client: TelegramClient,
  user: Api.User,
  sourceLink: string,
  sourceName: string,
  sourceType: ParseSource,
  messages: string[]
): Promise<ParsedUser> {
  const { status, lastSeen } = getOnlineStatus(user.status);
  const firstName = user.firstName || '';
  const lastName = user.lastName || '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'Без имени';
  let bio = '';
  let personalChannel = '';
  try {
    const inputUser = await client.getInputEntity(user);
    const result = await client.invoke(
      new Api.users.GetFullUser({ id: inputUser })
    ) as { fullUser?: { about?: string; personalChannelId?: bigint } };
    if (result?.fullUser?.about) bio = result.fullUser.about;
    const chId = result?.fullUser?.personalChannelId;
    if (chId) {
      try {
        const ch = await client.getEntity(Number(chId));
        const chUser = ch as Api.User;
        if (chUser?.username) personalChannel = `https://t.me/${chUser.username}`;
        else personalChannel = `ID: ${chId}`;
      } catch {
        personalChannel = `ID: ${chId}`;
      }
    }
  } catch {
    // ignore full user fetch errors
  }

  const displayId = user.username ? `@${user.username}` : String(user.id);
  return {
    'ID/Username': displayId,
    ID: Number(user.id),
    Username: user.username || '',
    Имя: firstName,
    Фамилия: lastName,
    'Полное имя': fullName,
    Пол: detectGender(firstName),
    Биография: bio,
    'Личный канал': personalChannel,
    'Статус онлайн': status,
    'Последний раз в сети': lastSeen ? lastSeen.toISOString().replace('T', ' ').slice(0, 19) : '',
    Сообщения: messages.join('\n---\n'),
    'Количество сообщений': messages.length,
    'Тип источника': sourceType,
    'Ссылка на источник': sourceLink,
    'Название источника': sourceName,
  };
}

async function parseChatMessages(
  client: TelegramClient,
  link: string,
  opts: ParseOptions
): Promise<ParsedUser[]> {
  const entity = await client.getEntity(link);
  const title = (entity as Api.Channel).title ?? (entity as Api.User).username ?? String((entity as Api.User).id);
  const usersMap = new Map<number, { user: Api.User; messages: string[] }>();

  let count = 0;
  for await (const msg of client.iterMessages(entity, { limit: opts.message_limit })) {
    if (!msg?.senderId || !msg.message) continue;
    const sender = await msg.getSender();
    if (!sender || (sender as Api.User).className !== 'User' || (sender as Api.User).bot) continue;

    const u = sender as Api.User;
    const existing = usersMap.get(Number(u.id));
    const text = String(msg.message).slice(0, 500);
    if (existing) {
      if (existing.messages.length < 50) existing.messages.push(text);
    } else {
      usersMap.set(Number(u.id), { user: u, messages: [text] });
    }
    count++;
  }

  const results: ParsedUser[] = [];
  for (const [_, { user, messages }] of usersMap) {
    const { status, lastSeen } = getOnlineStatus(user.status);
    if (!filterByOnline(status, lastSeen, opts)) continue;
    results.push(await userToParsed(client, user, link, title, 'chat_messages', messages));
    await new Promise((r) => setTimeout(r, 100)); // rate limit
  }
  return results;
}

async function parseChatMembers(client: TelegramClient, link: string, opts: ParseOptions): Promise<ParsedUser[]> {
  const entity = await client.getEntity(link);
  const title = (entity as Api.Channel).title ?? (entity as Api.User).username ?? String((entity as Api.User).id);
  const results: ParsedUser[] = [];
  let count = 0;
  try {
    for await (const participant of client.iterParticipants(entity, { limit: opts.message_limit })) {
      const u = participant as Api.User;
      if (!u || u.className !== 'User' || u.bot) continue;
      const { status, lastSeen } = getOnlineStatus(u.status);
      if (!filterByOnline(status, lastSeen, opts)) continue;
      results.push(await userToParsed(client, u, link, title, 'chat_members', []));
      count++;
      if (count % 50 === 0) await new Promise((r) => setTimeout(r, 100));
    }
  } catch (e) {
    if (String(e).includes('CHAT_ADMIN_REQUIRED') || String(e).includes('CHANNEL_PRIVATE')) {
      // skip members if no access
      return [];
    }
    throw e;
  }
  return results;
}

async function parsePostComments(client: TelegramClient, link: string, opts: ParseOptions): Promise<ParsedUser[]> {
  const entity = await client.getEntity(link);
  const ch = entity as Api.Channel;
  if (!ch || ch.className !== 'Channel' || !ch.broadcast) return []; // only broadcast channels have comments
  const title = ch.title ?? ch.username ?? String(ch.id);
  const usersMap = new Map<number, { user: Api.User; messages: string[] }>();
  let postCount = 0;

  for await (const post of client.iterMessages(entity, { limit: opts.message_limit })) {
    if (!post?.replies?.comments) continue;
    postCount++;
    try {
      for await (const reply of client.iterMessages(entity, { replyTo: post.id, limit: 100 })) {
        if (!reply?.senderId || !reply.message) continue;
        const sender = await reply.getSender();
        if (!sender || (sender as Api.User).className !== 'User' || (sender as Api.User).bot) continue;
        const u = sender as Api.User;
        const text = String(reply.message).slice(0, 500);
        const existing = usersMap.get(Number(u.id));
        if (existing) {
          if (existing.messages.length < 50) existing.messages.push(text);
        } else {
          usersMap.set(Number(u.id), { user: u, messages: [text] });
        }
      }
    } catch {
      // skip posts without comment access
    }
  }

  const results: ParsedUser[] = [];
  for (const [_, { user, messages }] of usersMap) {
    const { status, lastSeen } = getOnlineStatus(user.status);
    if (!filterByOnline(status, lastSeen, opts)) continue;
    results.push(await userToParsed(client, user, link, title, 'post_comments', messages));
    await new Promise((r) => setTimeout(r, 100));
  }
  return results;
}

export type ParseResult = { status: 'ok'; users: ParsedUser[] } | { status: 'error'; error: string };

export async function parseTgUsers(opts: ParseOptions): Promise<ParseResult> {
  if (!opts.links?.length) return { status: 'error', error: 'links is empty' };
  if (!opts.parse_chat_messages && !opts.parse_chat_members && !opts.parse_post_comments) {
    return { status: 'error', error: 'At least one parse mode must be enabled' };
  }

  const client = await getClient(opts.account);
  const allUsers = new Map<number, ParsedUser>();

  try {
    for (const link of opts.links) {
      const trimmed = String(link).trim();
      if (!trimmed) continue;

      if (opts.parse_chat_messages) {
        const msgs = await parseChatMessages(client, trimmed, opts);
        for (const u of msgs) {
          const ex = allUsers.get(u.ID);
          if (ex) {
            ex.Сообщения = [ex.Сообщения, u.Сообщения].filter(Boolean).join('\n---\n');
            ex['Количество сообщений'] += u['Количество сообщений'];
          } else {
            allUsers.set(u.ID, u);
          }
        }
      }
      if (opts.parse_chat_members) {
        const mems = await parseChatMembers(client, trimmed, opts);
        for (const u of mems) {
          if (!allUsers.has(u.ID)) allUsers.set(u.ID, u);
        }
      }
      if (opts.parse_post_comments) {
        const comments = await parsePostComments(client, trimmed, opts);
        for (const u of comments) {
          const ex = allUsers.get(u.ID);
          if (ex) {
            ex.Сообщения = [ex.Сообщения, u.Сообщения].filter(Boolean).join('\n---\n');
            ex['Количество сообщений'] += u['Количество сообщений'];
          } else {
            allUsers.set(u.ID, u);
          }
        }
      }
    }
    await client.disconnect();
  } catch (e) {
    try {
      await client.disconnect();
    } catch {}
    return { status: 'error', error: e instanceof Error ? e.message : String(e) };
  }

  return { status: 'ok', users: [...allUsers.values()] };
}
