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

  if (/USER_DEACTIVATED_BAN/i.test(msg)) {
    return { status: 'banned', detail: 'Telegram забанил номер' };
  }
  if (/USER_DEACTIVATED/i.test(msg)) {
    return { status: 'banned', detail: 'аккаунт удалён или деактивирован' };
  }
  if (/PHONE_NUMBER_BANNED/i.test(msg)) {
    return { status: 'banned', detail: 'номер забанен при входе' };
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
  const flood = /FLOOD_WAIT_(\d+)/i.exec(msg);
  if (flood) {
    return { status: 'error', detail: `Telegram просит подождать ${flood[1]}с` };
  }

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
export async function checkAccount(client: TelegramClient): Promise<AccountCheckResult> {
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
    const reason = (me.restrictionReason ?? [])
      .map((r) => r.text)
      .filter(Boolean)
      .join('; ');
    return {
      status: 'restricted',
      detail: reason || 'Telegram ограничил аккаунт',
      ...identity,
    };
  }

  return {
    status: 'ok',
    detail: otherSessions.length
      ? `жив, но в аккаунте ещё ${otherSessions.length} чужих сеансов`
      : 'жив, чужих сеансов нет',
    ...identity,
  };
}
