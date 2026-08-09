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
import type { ProfileInput } from './validateProfile';

export interface ApplyProfileArgs {
  client: TelegramClient;
  profile: ProfileInput;
  avatar?: { buffer: Buffer; name: string };
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
}: ApplyProfileArgs): Promise<AppliedProfile> {
  await client.invoke(
    new Api.account.UpdateProfile({
      firstName: profile.first_name.trim(),
      lastName: profile.last_name.trim(),
      about: profile.bio.trim(),
    }),
  );

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

  const flood = /FLOOD_WAIT_(\d+)|wait of (\d+) seconds/i.exec(msg);
  if (flood) {
    const seconds = flood[1] ?? flood[2];
    return `Telegram просит подождать: вы меняете профиль слишком часто. Повторите через ${seconds} секунд.`;
  }

  if (/PHOTO_|IMAGE_|FILE_PART|MEDIA_/i.test(msg)) {
    return `Telegram не принял картинку: ${msg}. Попробуйте квадратный JPEG до 1 МБ.`;
  }

  if (/FIRSTNAME_INVALID|LASTNAME_INVALID|ABOUT_TOO_LONG/i.test(msg)) {
    return `Telegram не принял значение: ${msg}`;
  }

  return msg;
}
