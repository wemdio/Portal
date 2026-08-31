/**
 * Проверка аккаунта: жив ли он и кто в нём ещё сидит.
 *
 * Расследование августа 2026 упёрлось в вопрос, который из логов не решается:
 * аккаунты теряют сессии пачками (SESSION_REVOKED) при нуле банов, и понять,
 * «нас разлогинили» или «номер забанили», можно только сходив в Telegram. Здесь
 * этот поход автоматизирован для всей партии сразу.
 *
 * Проверка намеренно ничего не меняет в аккаунте: только подключение, getMe и
 * список активных сеансов. Ни отправок, ни правок профиля — иначе проверка сама
 * становилась бы нагрузкой на аккаунт, который мы и так подозреваем в проблемах.
 */
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import { withTimeout } from './withTimeout';
import { classifyRestriction, describeRestriction, restrictionFromProfile } from './restriction';

export type AccountCheckStatus =
  | 'ok'
  | 'session_revoked'
  | 'banned'
  | 'session_duplicate'
  | 'restricted'
  | 'proxy_dead'
  | 'no_session'
  | 'error';

export interface OtherSession {
  device: string;
  platform: string;
  app: string;
  country: string;
  ip: string;
  /** Когда с этого устройства заходили в последний раз. */
  last_active: string;
  created: string;
}

export interface AccountCheckResult {
  status: AccountCheckStatus;
  detail: string;
  tg_user_id?: number | null;
  tg_username?: string | null;
  phone?: string | null;
  /** Чужие сеансы: наш собственный из списка исключён. */
  other_sessions?: OtherSession[];
}

function callTimeoutMs(): number {
  return Number(process.env.TG_OUTREACH_CHECK_TIMEOUT_MS) || 45_000;
}

/**
 * Разложить ошибку Telegram по итогам проверки.
 *
 * Отдельная чистая функция, потому что именно она отвечает на главный вопрос
 * расследования — и именно её проще всего сломать, добавив новый случай не в
 * тот порядок. Порядок здесь значим: AUTH_KEY_UNREGISTERED и SESSION_REVOKED
 * оба содержат слово SESSION, а бан номера важнее любой сетевой ошибки.
 */
export function classifyCheckError(rawMessage: string): { status: AccountCheckStatus; detail: string } {
  const msg = rawMessage;

  /**
   * Ограничения Telegram разбираем одной функцией — она же отвечает на главный
   * вопрос оператора: подождать или списывать аккаунт. Раньше здесь лежали три
   * ветки подряд, все со словом «забанил», и «бан навсегда» было не отличить от
   * «пауза на два часа»: и то, и другое приезжало в карточку одинаково.
   *
   * Стоит первым: бан номера важнее любой сетевой ошибки, а FLOOD_WAIT ниже
   * иначе перехватывался бы общей веткой «error».
   */
  const restriction = classifyRestriction(msg, Date.now());
  if (restriction) {
    return {
      status: restriction.kind === 'permanent' ? 'banned' : 'restricted',
      detail: describeRestriction(restriction),
    };
  }

  if (/AUTH_KEY_DUPLICATED/i.test(msg)) {
    return { status: 'session_duplicate', detail: 'в аккаунт зашли с другого устройства' };
  }
  if (/SESSION_REVOKED|AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|SESSION_EXPIRED/i.test(msg)) {
    return { status: 'session_revoked', detail: 'сессия отозвана — аккаунт разлогинили' };
  }
  if (/connect timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|socket hang up|нет ответа за/i.test(msg)) {
    return { status: 'proxy_dead', detail: 'прокси или Telegram не отвечают' };
  }
  // FLOOD_WAIT сюда уже не доходит: его разбирает classifyRestriction выше и
  // называет временным ограничением с точным сроком.
  return { status: 'error', detail: msg.slice(0, 300) };
}

/** Активные сеансы в человеческом виде, без нашего собственного. */
export function describeSessions(auths: Api.account.Authorizations): OtherSession[] {
  return auths.authorizations
    .filter((a) => !a.current)
    .map((a) => ({
      device: a.deviceModel || '—',
      platform: a.platform || '—',
      app: [a.appName, a.appVersion].filter(Boolean).join(' ') || '—',
      country: a.country || '—',
      ip: a.ip || '—',
      last_active: new Date(a.dateActive * 1000).toISOString(),
      created: new Date(a.dateCreated * 1000).toISOString(),
    }));
}

/**
 * Сходить в Telegram и выяснить состояние аккаунта.
 *
 * Никогда не бросает: проверка идёт по всей партии сразу, и одна упавшая не
 * должна обрывать остальные — её результат просто станет строкой со статусом.
 */
export interface CheckAccountOptions {
  /**
   * Спросить у @SpamBot срок снятия ограничения.
   *
   * Вызывающий ставит `true`, когда аккаунт УЖЕ числится ограниченным: поймал
   * PEER_FLOOD на рассылке или так помечен в карточке. У здорового аккаунта
   * ответ бота предсказуем и не стоит лишнего исходящего сообщения с боевого
   * номера — а вот флаг `restricted` в профиле портал увидит и сам, и тогда
   * спросит независимо от этого параметра.
   */
  askSpamBotWhenRestricted?: boolean;
}

export async function checkAccount(
  client: TelegramClient,
  options: CheckAccountOptions = {},
): Promise<AccountCheckResult> {
  let me: Api.User | undefined;
  try {
    me = (await withTimeout(
      client.getMe() as Promise<Api.User | undefined>,
      callTimeoutMs(),
      'проверка аккаунта',
    )) as Api.User | undefined;
  } catch (e) {
    return classifyCheckError(e instanceof Error ? e.message : String(e));
  }

  if (!me) {
    return { status: 'error', detail: 'Telegram не вернул данные аккаунта' };
  }

  // Список сеансов не критичен: если он не пришёл, аккаунт всё равно проверен.
  // Ради него не стоит объявлять живой аккаунт сломанным.
  let otherSessions: OtherSession[] = [];
  try {
    const auths = await withTimeout(
      client.invoke(new Api.account.GetAuthorizations()),
      callTimeoutMs(),
      'список сеансов',
    );
    otherSessions = describeSessions(auths);
  } catch {
    otherSessions = [];
  }

  const identity = {
    tg_user_id: me.id != null ? Number(me.id) : null,
    tg_username: me.username ?? null,
    phone: me.phone ?? null,
    other_sessions: otherSessions,
  };

  if (me.restricted) {
    const restriction = restrictionFromProfile((me.restrictionReason ?? []).map((r) => r.text ?? ''));
    // Срок снятия у Telegram есть только в личке с антиспам-ботом. Раз аккаунт
    // и так ограничен — спрашиваем: одно сообщение против «когда отпустит?»
    // без ответа.
    const verdict = restriction.kind === 'permanent' ? null : await askSpamBot(client);
    return {
      // Бан и временное ограничение приезжают в одном флаге `restricted`, а
      // означают противоположное. Разводим их по статусам, чтобы сводка по
      // партии не считала забаненный номер «ограниченным на время».
      status: restriction.kind === 'permanent' ? 'banned' : 'restricted',
      detail: verdict
        ? `${describeRestriction(restriction)} ${describeSpamBotVerdict(verdict)}`
        : describeRestriction(restriction),
      ...identity,
    };
  }

  /**
   * Профиль чист, но снаружи известно, что аккаунт ограничен.
   *
   * Именно так выглядит спам-блок: PEER_FLOOD прилетает на отправке, а флаг
   * `restricted` в профиле при этом не поднимается вовсе. Без этой ветки
   * проверка бодро отвечала бы «жив» аккаунту, который уже неделю не может
   * написать ни одному незнакомому человеку.
   */
  if (options.askSpamBotWhenRestricted) {
    const verdict = await askSpamBot(client);
    if (verdict?.kind === 'limited') {
      return {
        status: 'restricted',
        detail: `ВРЕМЕННОЕ ограничение — Telegram закрыл переписку с незнакомыми. ${describeSpamBotVerdict(verdict)}`,
        ...identity,
      };
    }
    if (verdict?.kind === 'free') {
      return {
        status: 'ok',
        detail: `жив, ограничение снято — ${describeSpamBotVerdict(verdict)}`
          + (otherSessions.length ? ` В аккаунте ещё ${otherSessions.length} чужих сеансов.` : ''),
        ...identity,
      };
    }
  }

  return {
    status: 'ok',
    detail: otherSessions.length
      ? `жив, но в аккаунте ещё ${otherSessions.length} чужих сеансов`
      : 'жив, чужих сеансов нет',
    ...identity,
  };
}

/**
 * Завершить все сеансы аккаунта, кроме нашего.
 *
 * Чужой сеанс — это не «след прошлого владельца», а действующий доступ:
 * продавец читает переписку с клиентами, видит коды входа и в любой момент
 * может выкинуть нас из аккаунта. Одна кнопка на партию дешевле, чем заходить
 * в каждый аккаунт руками.
 *
 * `auth.ResetAuthorizations` рубит именно чужие — наш сеанс остаётся живым,
 * поэтому переподключаться после вызова не нужно.
 */
export async function resetOtherSessions(client: TelegramClient): Promise<void> {
  await withTimeout(
    client.invoke(new Api.auth.ResetAuthorizations()) as Promise<unknown>,
    30_000,
    'Telegram не ответил на сброс сеансов',
  );
}

/** Отказ на сбросе сеансов — в понятную оператору фразу. */
export function describeResetError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);

  // Свежая сессия не имеет права выкидывать остальные — защита Telegram от
  // угона. Для только что залитых аккаунтов это штатный ответ, а не поломка.
  if (/FRESH_RESET_AUTHORISATION_FORBIDDEN/i.test(msg)) {
    return 'Telegram запрещает сбрасывать чужие сеансы с сессии моложе суток. Повторите через 24 часа после первого входа в аккаунт.';
  }
  const flood = /FLOOD_WAIT_(\d+)/i.exec(msg);
  if (flood) {
    return `Telegram просит подождать ${flood[1]} секунд — слишком часто.`;
  }
  if (/SESSION_REVOKED|AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID/i.test(msg)) {
    return 'Сессия отозвана — аккаунт уже разлогинили, сбрасывать нечего.';
  }
  return msg.slice(0, 300);
}

/* =================== @SpamBot =================== */

/**
 * Ответ @SpamBot — единственный источник срока снятия спам-блока.
 *
 * PEER_FLOOD Telegram выдаёт без даты: в ошибке её нет, в профиле нет, в API
 * нет вообще нигде. Знает её только антиспам, и рассказывает он её ровно одному
 * собеседнику — самому аккаунту, в личке со своим ботом. Поэтому «когда
 * отпустит» и «отпустит ли вообще» приходится спрашивать сообщением.
 *
 * Спрашиваем ТОЛЬКО у аккаунтов, которые уже ограничены. У здорового ответ
 * предсказуем («ограничений нет») и не стоит лишнего исходящего сообщения с
 * боевого номера.
 */
export interface SpamBotVerdict {
  /** Ответ бота дословно. Показываем его же: это слова Telegram, не наши. */
  text: string;
  kind: 'free' | 'limited' | 'unknown';
  /** Дата снятия, ISO. null — бот срока не назвал (бывает при бессрочном). */
  until: string | null;
}

const EN_MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const RU_MONTHS: Record<string, number> = {
  январ: 0, феврал: 1, март: 2, апрел: 3, ма: 4, июн: 5,
  июл: 6, август: 7, сентябр: 8, октябр: 9, ноябр: 10, декабр: 11,
};

/**
 * Дата из текста бота. Формат он меняет от языка к языку и от случая к случаю,
 * поэтому пробуем несколько написаний подряд, а не одно «правильное».
 *
 * Не нашли — возвращаем null и показываем текст как есть. Выдуманная дата хуже
 * отсутствующей: её запомнят как обещание.
 */
export function parseSpamBotDate(text: string): string | null {
  const time = /(\d{1,2}):(\d{2})/.exec(text);
  const hh = time ? Number(time[1]) : 0;
  const mm = time ? Number(time[2]) : 0;

  // 27.09.2026 и 27/09/2026
  const numeric = /(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(text);
  if (numeric) {
    return new Date(Date.UTC(Number(numeric[3]), Number(numeric[2]) - 1, Number(numeric[1]), hh, mm)).toISOString();
  }

  // 27 September 2026 / 27 Sep 2026
  const dayFirst = /(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/.exec(text);
  if (dayFirst) {
    const month = EN_MONTHS[dayFirst[2].slice(0, 3).toLowerCase()];
    if (month !== undefined) {
      return new Date(Date.UTC(Number(dayFirst[3]), month, Number(dayFirst[1]), hh, mm)).toISOString();
    }
  }

  // September 27, 2026 / Sep 27 2026
  const monthFirst = /([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})/.exec(text);
  if (monthFirst) {
    const month = EN_MONTHS[monthFirst[1].slice(0, 3).toLowerCase()];
    if (month !== undefined) {
      return new Date(Date.UTC(Number(monthFirst[3]), month, Number(monthFirst[2]), hh, mm)).toISOString();
    }
  }

  // 27 сентября 2026
  const ru = /(\d{1,2})\s+([А-Яа-яЁё]{3,})\s+(\d{4})/.exec(text);
  if (ru) {
    const word = ru[2].toLowerCase();
    for (const [stem, index] of Object.entries(RU_MONTHS)) {
      if (word.startsWith(stem)) {
        return new Date(Date.UTC(Number(ru[3]), index, Number(ru[1]), hh, mm)).toISOString();
      }
    }
  }

  return null;
}

/** Разобрать ответ бота: свободен, ограничен, непонятно. */
export function parseSpamBotReply(text: string): SpamBotVerdict {
  const clean = (text ?? '').trim();
  if (!clean) return { text: '', kind: 'unknown', until: null };

  // «Свободен» проверяем первым: фраза про отсутствие ограничений содержит
  // слово «ограничен», и обратный порядок читал бы её как ограничение.
  if (/no limits|free as a bird|нет никаких ограничений|никаких ограничений|не наложено/i.test(clean)) {
    return { text: clean, kind: 'free', until: null };
  }

  if (/limited|restricted|ограничен|ограничени/i.test(clean)) {
    return { text: clean, kind: 'limited', until: parseSpamBotDate(clean) };
  }

  return { text: clean, kind: 'unknown', until: null };
}

/** Сколько ждём ответа бота, прежде чем считать, что его не будет. */
const SPAMBOT_REPLY_WAIT_MS = 4_000;

/**
 * Спросить @SpamBot о состоянии аккаунта.
 *
 * Одно исходящее сообщение — `/start`, ровно то, что делает любой человек,
 * зашедший к этому боту. Никогда не бросает: ответ бота — приятное дополнение
 * к проверке, а не сама проверка, и его отсутствие не повод объявлять аккаунт
 * сломанным.
 */
export async function askSpamBot(client: TelegramClient): Promise<SpamBotVerdict | null> {
  try {
    const bot = await withTimeout(
      client.getEntity('SpamBot') as Promise<unknown>,
      callTimeoutMs(),
      'поиск @SpamBot',
    );
    await withTimeout(
      client.sendMessage(bot as never, { message: '/start' }) as Promise<unknown>,
      callTimeoutMs(),
      'сообщение @SpamBot',
    );
    // Бот отвечает не мгновенно, а подписки на апдейты у проверки нет —
    // ждём фиксированную паузу и читаем последнее сообщение диалога.
    await new Promise((resolve) => setTimeout(resolve, SPAMBOT_REPLY_WAIT_MS));
    const messages = await withTimeout(
      client.getMessages(bot as never, { limit: 1 }) as Promise<Array<{ message?: string }>>,
      callTimeoutMs(),
      'ответ @SpamBot',
    );
    const reply = messages?.[0]?.message ?? '';
    return reply ? parseSpamBotReply(reply) : null;
  } catch {
    return null;
  }
}

/** Ответ бота в одну строку для карточки аккаунта. */
export function describeSpamBotVerdict(v: SpamBotVerdict, tzOffsetHours = 3): string {
  if (v.kind === 'free') return '@SpamBot: ограничений на аккаунте нет.';
  if (v.kind === 'limited') {
    if (!v.until) {
      return `@SpamBot: аккаунт ограничен, срок не назван — возможно, бессрочно. Ответ бота: «${v.text.slice(0, 200)}»`;
    }
    const local = new Date(new Date(v.until).getTime() + tzOffsetHours * 3_600_000).toISOString();
    return `@SpamBot: ограничение снимется ${local.slice(8, 10)}.${local.slice(5, 7)}.${local.slice(0, 4)} в ${local.slice(11, 16)} МСК.`;
  }
  return `@SpamBot ответил непонятно: «${v.text.slice(0, 200)}»`;
}
