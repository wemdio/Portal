/**
 * Обжалование заморозки — тем соединением, которое уже открыто.
 *
 * Заморозку Telegram снимает по обращению, а не по таймеру: у спам-блока есть
 * срок и он проходит сам, у заморозки срока нет, зато есть кнопка обжалования.
 * Подать его должен сам аккаунт — а зайти в него оператор не может: телефон
 * остался у продавца, на руках только сессия в портале.
 *
 * Отсюда всё устройство: обращение отправляет воркер своим соединением, как и
 * проверку аккаунта. Подключиться отдельно нельзя — второе подключение к той же
 * сессии Telegram встречает AUTH_KEY_DUPLICATED и выключает аккаунт.
 *
 * Текст пишет оператор. Обращение читает живой человек в поддержке, и шаблон
 * «снимите ограничение» на все случаи был бы хуже отсутствия кнопки.
 */
import type { TelegramClient } from 'telegram';

import { withTimeout } from './withTimeout';

/** Куда Telegram предлагает обжаловать — и можем ли мы туда написать. */
export type AppealTarget =
  | { kind: 'chat'; peer: string }
  | { kind: 'web'; url: string }
  | { kind: 'unknown' };

/**
 * Разобрать адрес обжалования.
 *
 * Telegram отдаёт его строкой и формат меняет свободно, поэтому разбираем по
 * форме, а не по списку известных адресов: `t.me/<имя>` и `@имя` — чат, в
 * который можно написать этой же сессией; всё остальное — веб-страница, и её
 * оператор открывает сам.
 *
 * Ссылки со стартовым параметром (`t.me/bot?start=xxx`) сводим к имени: в чат
 * мы пишем обычным сообщением, а не запуском бота — запуск требует своей RPC и
 * не всегда уместен, если диалог уже открыт.
 */
export function parseAppealTarget(raw: string | null | undefined): AppealTarget {
  const url = (raw ?? '').trim();
  if (!url) return { kind: 'unknown' };

  if (url.startsWith('@')) {
    const name = url.slice(1).split(/[/?#]/)[0];
    return name ? { kind: 'chat', peer: name } : { kind: 'unknown' };
  }

  const m = url.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\/([^/?#]+)/i);
  if (m) {
    const name = m[1];
    // «+abc» и «joinchat/…» — приглашения в группу, писать туда нечего.
    if (name.startsWith('+') || name.toLowerCase() === 'joinchat') return { kind: 'web', url };
    return { kind: 'chat', peer: name };
  }

  if (/^https?:\/\//i.test(url)) return { kind: 'web', url };
  return { kind: 'unknown' };
}

export interface AppealResult {
  status: 'sent' | 'failed';
  detail: string;
}

const APPEAL_TIMEOUT_MS = Number(process.env.TG_OUTREACH_APPEAL_TIMEOUT_MS) || 60_000;

/**
 * Отправить обращение.
 *
 * Ошибку не глотаем и не переводим в «отправлено»: обжалование подают один раз
 * и ждут ответа неделями, поэтому ложное «ушло» дороже честного отказа.
 */
export async function sendFreezeAppeal(args: {
  client: TelegramClient;
  appealUrl: string | null | undefined;
  text: string;
}): Promise<AppealResult> {
  const text = (args.text ?? '').trim();
  if (!text) {
    return { status: 'failed', detail: 'Пустой текст обращения — писать нечего.' };
  }

  const target = parseAppealTarget(args.appealUrl);
  if (target.kind === 'web') {
    return {
      status: 'failed',
      detail:
        `Telegram предлагает обжаловать на странице ${target.url} — из аккаунта туда не написать. `
        + 'Откройте ссылку в браузере и подайте обращение вручную.',
    };
  }
  if (target.kind === 'unknown') {
    return {
      status: 'failed',
      detail:
        'Telegram не дал адреса обжалования для этого аккаунта. '
        + 'Проверьте аккаунт заново — адрес появляется вместе с заморозкой.',
    };
  }

  try {
    const entity = await withTimeout(
      args.client.getEntity(target.peer),
      APPEAL_TIMEOUT_MS,
      'поиск адресата обжалования',
    );
    await withTimeout(
      args.client.sendMessage(entity, { message: text }),
      APPEAL_TIMEOUT_MS,
      'отправка обжалования',
    );
    return { status: 'sent', detail: `Обращение отправлено в @${target.peer}.` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Заморозка запрещает часть методов, и отправка может оказаться среди них.
    // Тогда обжаловать из аккаунта нельзя вовсе — говорим это прямо, чтобы
    // оператор не жал кнопку по второму разу.
    if (/FROZEN_METHOD_INVALID|FrozenMethodInvalid/i.test(msg)) {
      return {
        status: 'failed',
        detail:
          'Telegram запрещает этому аккаунту отправку сообщений — обжаловать из портала нельзя. '
          + 'Остаётся официальное приложение: выключите аккаунт в портале и войдите в него с TData.',
      };
    }
    return { status: 'failed', detail: `Не отправилось — ${msg}`.slice(0, 500) };
  }
}

/** Заготовка обращения: оператор правит её перед отправкой. */
export function defaultAppealText(): string {
  return (
    'Здравствуйте! Мой аккаунт ограничен: не работает поиск пользователей и отправка сообщений. '
    + 'Я использую его для деловой переписки с партнёрами, рассылок и спама не веду. '
    + 'Прошу пересмотреть ограничение. Спасибо!'
  );
}
