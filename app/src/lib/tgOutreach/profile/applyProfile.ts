/**
 * Применение профиля в Telegram и перечитывание результата.
 *
 * Перечитываем намеренно: Telegram может подрезать значение или отказать
 * частично, и список должен показывать то, что реально стоит в аккаунте, а не
 * то, что мы отправили.
 */
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import { CustomFile } from 'telegram/client/uploads';
import { normalizeUsername, type ProfileInput } from './validateProfile';

export interface ApplyProfileArgs {
  client: TelegramClient;
  profile: ProfileInput;
  avatar?: { buffer: Buffer; name: string };
  /**
   * Юзернейм, который портал знает за аккаунтом. Нужен, чтобы не дёргать
   * Telegram, когда поле не меняли: смена юзернейма ограничена по частоте, и
   * лишний запрос приближает «подождите N часов» без всякой пользы.
   */
  currentUsername?: string;
}

export interface AppliedProfile {
  first_name: string;
  last_name: string;
  bio: string;
  tg_username: string;
  tg_user_id: number | null;
}

export async function applyProfile({
  client,
  profile,
  avatar,
  currentUsername,
}: ApplyProfileArgs): Promise<AppliedProfile> {
  await client.invoke(
    new Api.account.UpdateProfile({
      firstName: profile.first_name.trim(),
      lastName: profile.last_name.trim(),
      about: profile.bio.trim(),
    }),
  );

  // Юзернейм — отдельный метод, UpdateProfile его не трогает. Пустая строка
  // здесь означает «снять юзернейм»: Telegram это умеет и ждёт именно её.
  const wanted = normalizeUsername(profile.username);
  if (profile.username !== undefined && wanted !== normalizeUsername(currentUsername)) {
    try {
      await client.invoke(new Api.account.UpdateUsername({ username: wanted }));
    } catch (err) {
      // «Не изменилось» — не отказ: значит в Telegram уже стоит то, что просим,
      // а разошлась лишь наша копия. Всё остальное поднимаем наверх.
      if (!/USERNAME_NOT_MODIFIED/i.test(err instanceof Error ? err.message : String(err))) {
        throw err;
      }
    }
  }

  if (avatar) {
    const file = await client.uploadFile({
      file: new CustomFile(avatar.name, avatar.buffer.length, avatar.name, avatar.buffer),
      workers: 1,
    });
    await client.invoke(new Api.photos.UploadProfilePhoto({ file }));
  }

  const me = (await client.getEntity('me')) as {
    id?: unknown;
    firstName?: string;
    lastName?: string;
    username?: string;
  };

  return {
    first_name: me.firstName ?? '',
    last_name: me.lastName ?? '',
    // about в getEntity не приходит — оставляем то, что отправили: Telegram
    // описание не подрезает, а лишний запрос GetFullUser ради него не нужен.
    bio: profile.bio.trim(),
    tg_username: me.username ?? '',
    tg_user_id: me.id != null ? Number(me.id) : null,
  };
}

/** Ошибку Telegram переводим в понятную оператору фразу. */
export function describeTelegramError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);

  // Не Telegram, а хранилище портала: файл сессии не скачался. Отдельная ветка
  // нужна потому, что вызывающий код оборачивает ответ во фразу про прокси, и
  // оператор шёл проверять прокси вместо перезаливки сессии.
  if (/Object not found|The resource was not found/i.test(msg)) {
    return 'файл сессии не найден в хранилище портала — перезалейте аккаунт';
  }

  const flood = /FLOOD_WAIT_(\d+)|wait of (\d+) seconds/i.exec(msg);
  if (flood) {
    const seconds = flood[1] ?? flood[2];
    return `Telegram просит подождать: вы меняете профиль слишком часто. Повторите через ${seconds} секунд.`;
  }

  if (/PHOTO_|IMAGE_|FILE_PART|MEDIA_/i.test(msg)) {
    return `Telegram не принял картинку: ${msg}. Попробуйте квадратный JPEG до 1 МБ.`;
  }

  // Юзернеймы глобально уникальны, поэтому «занят» — штатный исход, а не сбой.
  // Без перевода оператор видел бы голое USERNAME_OCCUPIED и шёл спрашивать.
  if (/USERNAME_OCCUPIED/i.test(msg)) {
    return 'Такой юзернейм уже занят — придумайте другой.';
  }
  if (/USERNAME_PURCHASE_AVAILABLE/i.test(msg)) {
    return 'Этот юзернейм свободен, но Telegram отдаёт его только за деньги на аукционе — возьмите другой.';
  }
  if (/USERNAME_INVALID/i.test(msg)) {
    return 'Telegram не принял юзернейм: допустимы латиница, цифры и подчёркивание, 5–32 знака, начинается с буквы.';
  }
  if (/USERNAMES_(ACTIVE|UNAVAILABLE)_TOO_MUCH/i.test(msg)) {
    return 'У аккаунта уже максимум юзернеймов — освободите один в самом Telegram.';
  }

  if (/FIRSTNAME_INVALID|LASTNAME_INVALID|ABOUT_TOO_LONG/i.test(msg)) {
    return `Telegram не принял значение: ${msg}`;
  }

  return msg;
}
