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
import bigInt from 'big-integer';
import { withTimeout } from '../withTimeout';
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
  /** Новая аватарка уже стоит, но очистка старых фото завершилась не полностью. */
  photo_cleanup_error?: string;
}

/** Уже скрытый номер не перенастраиваем; разрешающие исключения тоже убираем. */
async function hidePhoneNumber(client: TelegramClient): Promise<void> {
  const key = new Api.InputPrivacyKeyPhoneNumber();
  const hidden = (rules: Api.TypePrivacyRule[]) =>
    rules.length === 1 && rules[0] instanceof Api.PrivacyValueDisallowAll;
  const current = await withTimeout(
    client.invoke(new Api.account.GetPrivacy({ key })), 30_000, 'проверка видимости номера',
  );
  if (hidden(current.rules)) return;

  const updated = await withTimeout(
    client.invoke(new Api.account.SetPrivacy({ key, rules: [new Api.InputPrivacyValueDisallowAll()] })),
    30_000, 'скрытие номера',
  );
  if (!hidden(updated.rules)) throw new Error('Telegram не подтвердил скрытие номера телефона.');
}

/** Снимок ДО загрузки: новая фотография никогда не попадёт в список удаления. */
async function oldProfilePhotos(client: TelegramClient): Promise<Api.InputPhoto[]> {
  const photos = new Map<string, Api.Photo>();
  let offset = 0;
  while (true) {
    const page = await withTimeout(
      client.invoke(new Api.photos.GetUserPhotos({
        userId: new Api.InputUserSelf(), offset, maxId: bigInt.zero, limit: 100,
      })),
      30_000, 'чтение старых фото профиля',
    );
    if (!page.photos.length) break;
    const previousSize = photos.size;
    for (const photo of page.photos) {
      if (photo instanceof Api.Photo) photos.set(photo.id.toString(), photo);
    }
    offset += page.photos.length;
    if (!(page instanceof Api.photos.PhotosSlice) || offset >= page.count) break;
    if (photos.size === previousSize) throw new Error('Telegram не вернул следующую страницу старых фото.');
  }

  // Отдельное публичное фото может показываться вместо основного из-за
  // приватности аватарки и не входить в её обычную историю.
  const full = await withTimeout(
    client.invoke(new Api.users.GetFullUser({ id: new Api.InputUserSelf() })),
    30_000, 'чтение публичного фото профиля',
  );
  const fallback = full.fullUser.fallbackPhoto;
  if (fallback instanceof Api.Photo) photos.set(fallback.id.toString(), fallback);
  return [...photos.values()].map((photo) => new Api.InputPhoto({
    id: photo.id, accessHash: photo.accessHash, fileReference: photo.fileReference,
  }));
}

export async function applyProfile({
  client,
  profile,
  avatar,
  currentUsername,
}: ApplyProfileArgs): Promise<AppliedProfile> {
  // Выполняется и для одиночного/массового сохранения, и для заказа в круге.
  await hidePhoneNumber(client);
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

  let photoCleanupError: string | undefined;
  if (avatar) {
    const oldPhotos = await oldProfilePhotos(client);
    const file = await client.uploadFile({
      file: new CustomFile(avatar.name, avatar.buffer.length, avatar.name, avatar.buffer),
      workers: 1,
    });
    const uploaded = await client.invoke(new Api.photos.UploadProfilePhoto({ file }));
    if (!(uploaded.photo instanceof Api.Photo)) {
      throw new Error('Telegram не подтвердил установку новой аватарки. Старые фото сохранены.');
    }
    // Дополнительная защита на случай, если Telegram вернул уже существующее фото.
    const removable = oldPhotos.filter((photo) => !photo.id.equals(uploaded.photo.id));
    try {
      for (let i = 0; i < removable.length; i += 100) {
        const batch = removable.slice(i, i + 100);
        const deleted = await withTimeout(
          client.invoke(new Api.photos.DeletePhotos({ id: batch })), 30_000, 'удаление старых фото профиля',
        );
        const deletedIds = new Set(deleted.map((id) => id.toString()));
        if (batch.some((photo) => !deletedIds.has(photo.id.toString()))) {
          throw new Error('Telegram не подтвердил удаление всех старых фото.');
        }
      }
    } catch (err) {
      // Фото уже загружено: возвращаем реальный профиль, чтобы портал сохранил
      // аватарку и отлёжку, а оператор увидел незавершённую очистку.
      photoCleanupError = `Новая аватарка установлена, но старые фото удалены не полностью: ${describeTelegramError(err)}`;
    }
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
    ...(photoCleanupError ? { photo_cleanup_error: photoCleanupError } : {}),
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

  /**
   * Заморозка. Оператор видел голое «420: FROZEN_METHOD_INVALID (caused by
   * account.UpdateProfile)» и шёл выяснять, что сломалось в портале, — хотя
   * портал тут ни при чём и чинить нечего.
   *
   * Это и не бан, и не спам-блок: Telegram ограничил аккаунт целиком за
   * подозрение в нарушении правил. Профиль не меняется, отметка «прочитано» не
   * ставится, незнакомым не написать. Само не проходит — снимается только
   * обращением в поддержку из самого аккаунта, и то не всегда.
   *
   * Формулировка намеренно называет действие: держать замороженный аккаунт в
   * рассылке бессмысленно, он всё равно ничего не отправит.
   */
  if (/FROZEN_METHOD_INVALID|FROZEN/i.test(msg)) {
    return 'Telegram заморозил этот аккаунт — менять профиль он не даёт. '
      + 'Это не бан и не спам-блок: аккаунт цел, но ограничен целиком, и рассылать с него не получится. '
      + 'Само не пройдёт — нужно обжалование из самого аккаунта (в официальном приложении будет баннер с кнопкой). '
      + 'Пока заморозка держится, аккаунт стоит выключить в кампании.';
  }

  return msg;
}
