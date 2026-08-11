/**
 * TG User Parser – GramJS-based parser for chat messages, members, and comments.
 * All logic in TypeScript, no Python.
 */
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import type { ParsedUser, ParseOptions, ParseSource, OnlineStatus, TgParserAccount } from './types';
import { withTimeout } from '@/lib/tgOutreach/withTimeout';

function _getEnvCredentials(): { apiId: number; apiHash: string; proxyUrl: string } {
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

function normalizeTelegramLink(rawLink: string): string {
  const trimmed = String(rawLink).trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^t\.me\//i.test(trimmed) || /^telegram\.me\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

function getChatIdFromInternalMessageLink(link: string): string | null {
  const m = link.match(/^https?:\/\/(?:t\.me|telegram\.me)\/c\/(\d+)(?:\/\d+)?(?:\?.*)?$/i);
  return m?.[1] ?? null;
}

function extractPublicChatRefFromMessageLink(link: string): string | null {
  const m = link.match(/^https?:\/\/(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{5,})(?:\/\d+)(?:\?.*)?$/i);
  return m?.[1] ?? null;
}

/**
 * Сколько ждать ответа Telegram на один запрос парсера.
 *
 * До 10.08.2026 таймаутов здесь не было вовсе, и зависший запрос вешал задачу
 * навсегда: gramJS сам вызовы не таймаутит, а мобильный прокси меняет IP под
 * живым соединением — запрос уходит в никуда и не возвращается. Ровно этот
 * класс проблем всю неделю ронял прогрев, там лечение то же.
 */
function callTimeoutMs(): number {
  return Number(process.env.TG_PARSER_CALL_TIMEOUT_MS) || 90_000;
}

/**
 * Сколько этап может не подавать признаков жизни, прежде чем его бросить.
 *
 * Именно простой, а не общее время: с включённым расширенным профилем Telegram
 * душит users.GetFullUser флуд-лимитом по 24-28 секунд на вызов, и обход идёт
 * со скоростью пользователь в полминуты. 10.08.2026 такая задача честно
 * работала полтора часа — фиксированный потолок на этап зарубил бы её вместе с
 * результатом. Здоровый медленный обход отличается от зависшего тем, что в нём
 * что-то происходит.
 */
function stageIdleMs(): number {
  return Number(process.env.TG_PARSER_STAGE_IDLE_MS) || 15 * 60_000;
}

async function resolveEntityByLink(client: TelegramClient, rawLink: string): Promise<Api.TypeEntityLike> {
  const link = normalizeTelegramLink(rawLink);
  const internalChatId = getChatIdFromInternalMessageLink(link);
  const t = callTimeoutMs();

  if (internalChatId) {
    const peerId = Number(`-100${internalChatId}`);
    try {
      return await withTimeout(client.getEntity(peerId), t, 'поиск чата');
    } catch {
      // In some sessions GramJS has no local entity cache yet, so warm it up first.
      await withTimeout(client.getDialogs({ limit: 200 }), t, 'загрузка диалогов');
      return await withTimeout(client.getEntity(peerId), t, 'поиск чата');
    }
  }

  const publicRef = extractPublicChatRefFromMessageLink(link);
  if (publicRef) return withTimeout(client.getEntity(publicRef), t, 'поиск чата');

  // Private invite links: t.me/+hash or t.me/joinchat/hash
  const privateInviteMatch = link.match(/^https?:\/\/(?:t\.me|telegram\.me)\/(?:joinchat\/|\+)([A-Za-z0-9_-]+)/i);
  if (privateInviteMatch) {
    const hash = privateInviteMatch[1];
    try {
      const info = await withTimeout(
        client.invoke(new Api.messages.CheckChatInvite({ hash })),
        t,
        'проверка приглашения',
      );
      if (info instanceof Api.ChatInviteAlready) {
        // Already a member — entity is directly available
        return info.chat;
      }
      // Not yet a member — join the chat
      const joined = await withTimeout(
        client.invoke(new Api.messages.ImportChatInvite({ hash })),
        t,
        'вступление по приглашению',
      );
      const chats = (joined as { chats?: Api.TypeChat[] }).chats;
      if (chats?.length) return chats[0];
    } catch (e) {
      if (String(e).includes('USER_ALREADY_PARTICIPANT')) {
        // Joined via another path — warm cache and retry
        await withTimeout(client.getDialogs({ limit: 500 }), t, 'загрузка диалогов');
        return withTimeout(client.getEntity(link), t, 'поиск чата');
      }
      throw e;
    }
  }

  return withTimeout(client.getEntity(link), t, 'поиск чата');
}

async function userToParsed(
  client: TelegramClient,
  user: Api.User,
  sourceLink: string,
  sourceName: string,
  sourceType: ParseSource,
  messages: string[],
  enrichProfile: boolean,
): Promise<ParsedUser> {
  const { status, lastSeen } = getOnlineStatus(user.status);
  const firstName = user.firstName || '';
  const lastName = user.lastName || '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'Без имени';
  let bio = '';
  let personalChannel = '';
  if (enrichProfile) {
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
      // Ignore profile enrichment errors: contact collection should continue.
    }
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

export type ParseStopReason = 'contact_limit' | 'error';

export type ParseResult =
  | { status: 'ok'; users: ParsedUser[] }
  | { status: 'partial'; users: ParsedUser[]; stop_reason: ParseStopReason; error?: string }
  | { status: 'error'; error: string };

/**
 * Отчёт о ходе работы, который не может навредить сбору.
 *
 * Колбэк приходит снаружи (воркер пишет из него в журнал и в БД), и его сбой —
 * не повод терять уже собранные контакты. Поэтому глотаем всё.
 */
async function report(
  opts: ParseOptions,
  p: Parameters<NonNullable<ParseOptions['onProgress']>>[0],
): Promise<void> {
  try {
    await opts.onProgress?.(p);
  } catch {
    /* отчётность не должна ронять сбор */
  }
}

/** Как часто отчитываться внутри длинного обхода. */
const PROGRESS_TICK_EVERY = 25;

async function parseChatMessages(
  client: TelegramClient,
  link: string,
  opts: ParseOptions,
  mergeUser: (u: ParsedUser) => Promise<boolean>,
  enrichProfile: boolean,
  totalSoFar: () => number,
  /** Признак жизни для сторожевого таймера простоя — на каждом шаге. */
  beat: () => void,
): Promise<void> {
  const entity = await resolveEntityByLink(client, link);
  const title = (entity as Api.Channel).title ?? (entity as Api.User).username ?? String((entity as Api.User).id);
  await report(opts, { link, title, stage: 'messages', phase: 'start', total: totalSoFar() });
  const usersMap = new Map<number, { user: Api.User; messages: string[] }>();

  for await (const msg of client.iterMessages(entity, { limit: opts.message_limit })) {
    beat();
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
  }

  let done = 0;
  for (const [, { user, messages }] of usersMap) {
    beat();
    const { status, lastSeen } = getOnlineStatus(user.status);
    if (!filterByOnline(status, lastSeen, opts)) continue;
    const parsed = await userToParsed(client, user, link, title, 'chat_messages', messages, enrichProfile);
    if (!(await mergeUser(parsed))) return;
    done += 1;
    if (done % PROGRESS_TICK_EVERY === 0) {
      await report(opts, { link, title, stage: 'messages', phase: 'tick', total: totalSoFar() });
    }
    await new Promise((r) => setTimeout(r, 100)); // rate limit
  }
  await report(opts, { link, title, stage: 'messages', phase: 'done', total: totalSoFar() });
}

async function parseChatMembers(
  client: TelegramClient,
  link: string,
  opts: ParseOptions,
  mergeUser: (u: ParsedUser) => Promise<boolean>,
  enrichProfile: boolean,
  totalSoFar: () => number,
  /** Признак жизни для сторожевого таймера простоя — на каждом шаге. */
  beat: () => void,
): Promise<void> {
  const entity = await resolveEntityByLink(client, link);
  const title = (entity as Api.Channel).title ?? (entity as Api.User).username ?? String((entity as Api.User).id);
  await report(opts, { link, title, stage: 'members', phase: 'start', total: totalSoFar() });
  let count = 0;
  try {
    for await (const participant of client.iterParticipants(entity, { limit: opts.message_limit })) {
      beat();
      const u = participant as Api.User;
      if (!u || u.className !== 'User' || u.bot) continue;
      const { status, lastSeen } = getOnlineStatus(u.status);
      if (!filterByOnline(status, lastSeen, opts)) continue;
      const parsed = await userToParsed(client, u, link, title, 'chat_members', [], enrichProfile);
      if (!(await mergeUser(parsed))) return;
      count++;
      if (count % PROGRESS_TICK_EVERY === 0) {
        await report(opts, { link, title, stage: 'members', phase: 'tick', total: totalSoFar() });
      }
      if (count % 50 === 0) await new Promise((r) => setTimeout(r, 100));
    }
  } catch (e) {
    if (String(e).includes('CHAT_ADMIN_REQUIRED') || String(e).includes('CHANNEL_PRIVATE')) {
      // Закрытый чат или нужны права админа — не ошибка задачи, просто этот
      // источник не отдаёт список участников. Отчитываемся и идём дальше.
      await report(opts, { link, title, stage: 'members', phase: 'done', total: totalSoFar() });
      return;
    }
    throw e;
  }
  await report(opts, { link, title, stage: 'members', phase: 'done', total: totalSoFar() });
}

async function parsePostComments(
  client: TelegramClient,
  link: string,
  opts: ParseOptions,
  mergeUser: (u: ParsedUser) => Promise<boolean>,
  enrichProfile: boolean,
  totalSoFar: () => number,
  /** Признак жизни для сторожевого таймера простоя — на каждом шаге. */
  beat: () => void,
): Promise<void> {
  const entity = await resolveEntityByLink(client, link);
  const ch = entity as Api.Channel;
  // Не канал — комментировать нечего, и это нормальный случай, а не сбой.
  if (!ch || ch.className !== 'Channel' || !ch.broadcast) return;
  const title = ch.title ?? ch.username ?? String(ch.id);
  await report(opts, { link, title, stage: 'comments', phase: 'start', total: totalSoFar() });
  const usersMap = new Map<number, { user: Api.User; messages: string[] }>();
  for await (const post of client.iterMessages(entity, { limit: opts.message_limit })) {
    beat();
    if (!post?.replies?.comments) continue;
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

  let done = 0;
  for (const [, { user, messages }] of usersMap) {
    beat();
    const { status, lastSeen } = getOnlineStatus(user.status);
    if (!filterByOnline(status, lastSeen, opts)) continue;
    const parsed = await userToParsed(client, user, link, title, 'post_comments', messages, enrichProfile);
    if (!(await mergeUser(parsed))) return;
    done += 1;
    if (done % PROGRESS_TICK_EVERY === 0) {
      await report(opts, { link, title, stage: 'comments', phase: 'tick', total: totalSoFar() });
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await report(opts, { link, title, stage: 'comments', phase: 'done', total: totalSoFar() });
}

function buildMergeUser(
  opts: ParseOptions,
  allUsers: Map<number, ParsedUser>,
  stopRef: { reason: ParseStopReason | null },
): (u: ParsedUser) => Promise<boolean> {
  return async (u: ParsedUser) => {
    if (stopRef.reason) return false;
    const ex = allUsers.get(u.ID);
    if (ex) {
      ex.Сообщения = [ex.Сообщения, u.Сообщения].filter(Boolean).join('\n---\n');
      ex['Количество сообщений'] += u['Количество сообщений'];
      return true;
    }
    if (opts.max_contacts != null && allUsers.size >= opts.max_contacts) {
      stopRef.reason = 'contact_limit';
      return false;
    }
    allUsers.set(u.ID, u);
    return true;
  };
}

export async function parseTgUsers(opts: ParseOptions): Promise<ParseResult> {
  if (!opts.links?.length) return { status: 'error', error: 'links is empty' };
  if (!opts.parse_chat_messages && !opts.parse_chat_members && !opts.parse_post_comments) {
    return { status: 'error', error: 'At least one parse mode must be enabled' };
  }

  const client = await getClient(opts.account);
  const enrichProfile =
    opts.enrich_profile ?? String(process.env.TG_PARSER_ENRICH_PROFILE ?? '').trim().toLowerCase() === 'true';
  const allUsers = new Map<number, ParsedUser>();
  const stopRef: { reason: ParseStopReason | null } = { reason: null };
  const mergeUser = buildMergeUser(opts, allUsers, stopRef);

  try {
    for (const link of opts.links) {
      if (stopRef.reason) break;
      const trimmed = String(link).trim();
      if (!trimmed) continue;

      // Счётчик отдаём функцией, а не числом: этапы длинные, и к моменту
      // отчёта в карте уже не то количество, что было на входе.
      const totalSoFar = () => allUsers.size;

      /**
       * Этап под сторожевым таймером простоя.
       *
       * Считаем не длительность, а тишину: обход с расширенным профилем идёт
       * часами и это нормально, а вот пятнадцать минут без единого обработанного
       * пользователя означают, что этап встал. Брошенный этап — не ошибка
       * задачи: собранное уже в allUsers, парсер отчитывается и берёт следующий
       * источник.
       */
      const runStage = async (
        stage: 'messages' | 'members' | 'comments',
        fn: (beat: () => void) => Promise<void>,
      ): Promise<void> => {
        let lastBeat = Date.now();
        const idleMs = stageIdleMs();
        let timer: ReturnType<typeof setInterval> | undefined;

        const idleGuard = new Promise<never>((_, reject) => {
          timer = setInterval(() => {
            if (Date.now() - lastBeat > idleMs) {
              reject(new Error(`обход источника (${stage}): нет движения ${Math.round(idleMs / 60_000)} мин`));
            }
          }, 30_000);
        });

        try {
          await Promise.race([fn(() => { lastBeat = Date.now(); }), idleGuard]);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!msg.includes('нет движения')) throw e;
          await report(opts, { link: trimmed, stage, phase: 'done', total: totalSoFar() });
        } finally {
          if (timer) clearInterval(timer);
        }
      };

      if (opts.parse_chat_messages) {
        await runStage('messages', (beat) =>
          parseChatMessages(client, trimmed, opts, mergeUser, enrichProfile, totalSoFar, beat));
        if (stopRef.reason) break;
      }
      if (opts.parse_chat_members) {
        await runStage('members', (beat) =>
          parseChatMembers(client, trimmed, opts, mergeUser, enrichProfile, totalSoFar, beat));
        if (stopRef.reason) break;
      }
      if (opts.parse_post_comments) {
        await runStage('comments', (beat) =>
          parsePostComments(client, trimmed, opts, mergeUser, enrichProfile, totalSoFar, beat));
        if (stopRef.reason) break;
      }
    }
    await client.disconnect();
  } catch (e) {
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : String(e);
    const users = [...allUsers.values()];
    if (users.length > 0) {
      return { status: 'partial', users, stop_reason: 'error', error: msg };
    }
    return { status: 'error', error: msg };
  }

  const users = [...allUsers.values()];
  if (stopRef.reason) {
    return { status: 'partial', users, stop_reason: stopRef.reason };
  }
  return { status: 'ok', users };
}
