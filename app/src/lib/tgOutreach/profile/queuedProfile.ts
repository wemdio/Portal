/**
 * Применение заказанной правки профиля соединением воркера.
 *
 * Ручка профиля открывала своё подключение и потому работала только на
 * остановленной кампании: второе подключение к той же сессии Telegram встречает
 * AUTH_KEY_DUPLICATED и выключает аккаунт. Чтобы настроить один аккаунт,
 * оператор останавливал рассылку всем.
 *
 * Здесь та же механика, что у проверки аккаунта и обжалования: заказ лежит в
 * строке аккаунта, а выполняет его круг тем соединением, которое уже открыто.
 */
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';

import { applyProfile, describeTelegramError } from './applyProfile';
import { normalizeUsername } from './autofill';

export interface QueuedProfilePayload {
  first_name?: string;
  last_name?: string;
  bio?: string;
  /** Желаемый ник. Пустая строка — снять ник, отсутствие — не трогать. */
  username?: string;
  /** Запасные ники по убыванию предпочтения. */
  username_candidates?: string[];
}

/**
 * Сколько аккаунт отлёживается после смены имени или ника.
 *
 * Правило из руководства TgNinja: после смены имени дать аккаунту отлежаться.
 * Для Telegram свежепереименованный аккаунт, тут же ушедший писать незнакомым,
 * — характерный признак подготовки к рассылке, и платим за это тем самым
 * бюджетом в тридцать писем.
 *
 * Отлёжка запрещает боевую рассылку, но НЕ прогрев: греться между своими
 * аккаунтами в эти сутки можно и нужно — именно этим пауза и наполняется.
 *
 * Описание в правило не входит намеренно: правка биографии не меняет того, как
 * аккаунт выглядит в списке контактов, и терять из-за опечатки сутки не за что.
 */
export const PROFILE_REST_HOURS = Number(process.env.TG_OUTREACH_PROFILE_REST_HOURS) || 24;

export interface QueuedProfileResult {
  status: 'applied' | 'failed';
  detail: string;
  /** Сменилось ли имя — по этому признаку аккаунт уходит на отлёжку. */
  identityChanged?: boolean;
  applied?: {
    first_name: string;
    last_name: string;
    bio: string;
    tg_username: string;
    tg_user_id: number | null;
  };
}

/**
 * Первый ник, который Telegram отдаёт.
 *
 * Между подбором в модалке и применением проходят минуты, а на длинном круге и
 * часы: желаемый ник за это время могли занять. Поэтому проверяем по порядку и
 * берём первый свободный, а не падаем на занятом первом.
 */
async function pickUsername(
  client: TelegramClient,
  wanted: string,
  candidates: string[],
): Promise<string | null> {
  const list = [wanted, ...candidates].map(normalizeUsername).filter(Boolean);
  for (const candidate of [...new Set(list)]) {
    try {
      const free = await client.invoke(new Api.account.CheckUsername({ username: candidate }));
      if (free === true) return candidate;
    } catch {
      // Занят, невалиден или флуд — следующий.
    }
  }
  return null;
}

export async function applyQueuedProfile(args: {
  client: TelegramClient;
  payload: QueuedProfilePayload;
  currentUsername?: string;
}): Promise<QueuedProfileResult> {
  const { client, payload } = args;

  try {
    let username = payload.username;

    // Ник трогаем, только если его заказывали. Смена ника ограничена Telegram по
    // частоте, и лишний вызов приближает «подождите N часов» без всякой пользы.
    if (typeof username === 'string' && username.trim()) {
      const chosen = await pickUsername(client, username, payload.username_candidates ?? []);
      if (!chosen) {
        return {
          status: 'failed',
          detail:
            `Ник «${username}» занят, запасные тоже. Профиль не менял: имя без ника оставлять `
            + 'не стал, чтобы не применять заказ наполовину.',
        };
      }
      username = chosen;
    }

    const applied = await applyProfile({
      client,
      profile: {
        first_name: payload.first_name ?? '',
        last_name: payload.last_name ?? '',
        bio: payload.bio ?? '',
        ...(username === undefined ? {} : { username }),
      },
      currentUsername: args.currentUsername,
    });

    const note = username && username !== payload.username
      ? ` Заказанный ник «${payload.username}» был занят, поставил «${username}».`
      : '';
    const identityChanged = Boolean(
      (payload.first_name ?? '') || (payload.last_name ?? '') || username,
    );
    return {
      status: 'applied',
      detail:
        `Профиль применён в Telegram.${note}`
        + (identityChanged ? ` Аккаунт отлёживается ${PROFILE_REST_HOURS} ч перед рассылкой (прогрев при этом разрешён).` : ''),
      applied,
      identityChanged,
    };
  } catch (e) {
    return { status: 'failed', detail: describeTelegramError(e).slice(0, 500) };
  }
}
