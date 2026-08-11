/**
 * Чтение текущего профиля аккаунта из Telegram.
 *
 * Портал хранит имя, фамилию, описание и аватарку в своих колонках, но до
 * 06.08.2026 они заполнялись только при нажатии «Применить». У аккаунтов,
 * загруженных сессиями, поля оставались пустыми — карточка показывала пустоту,
 * хотя в самом Telegram профиль был настроен. Здесь мы спрашиваем Telegram, что
 * реально стоит в аккаунте.
 *
 * Каждый запрос ограничен по времени: мобильный прокси меняет IP в любой момент,
 * сокет при этом остаётся «живым» с точки зрения gramJS, и запрос уходит в
 * никуда, не таймаутясь (тот же класс проблемы, что и с getMe в прогреве).
 */
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import { withTimeout } from '../withTimeout';

export interface CurrentProfile {
  first_name: string;
  last_name: string;
  bio: string;
  tg_username: string;
  tg_user_id: number | null;
  /**
   * Номер как его отдаёт Telegram — без плюса, «79001234567».
   *
   * В tdata телефона нет, узнать его портал может только у Telegram: пустая
   * строка здесь означает «Telegram не сказал», а не «номера нет».
   */
  phone: string;
  /** JPEG аватарки; null — фото нет или скачать не удалось. */
  avatar: Buffer | null;
}

function readTimeoutMs(): number {
  return Number(process.env.TG_OUTREACH_PROFILE_READ_TIMEOUT_MS) || 30_000;
}

export async function readProfile(client: TelegramClient): Promise<CurrentProfile> {
  const ms = readTimeoutMs();

  // GetFullUser нужен ради about: в getMe описания нет.
  const full = (await withTimeout(
    client.invoke(new Api.users.GetFullUser({ id: new Api.InputUserSelf() })),
    ms,
    'чтение профиля',
  )) as Api.users.UserFull;

  const me = full.users.find((u): u is Api.User => u instanceof Api.User);

  // Аватарка не критична: профиль без фото — рабочий случай, а сбой скачивания
  // не повод отказать оператору в имени и описании.
  let avatar: Buffer | null = null;
  try {
    const photo = await withTimeout(
      client.downloadProfilePhoto('me', { isBig: true }) as Promise<Buffer | string | undefined>,
      ms,
      'скачивание аватарки',
    );
    if (photo && Buffer.isBuffer(photo) && photo.length > 0) avatar = photo;
  } catch {
    avatar = null;
  }

  return {
    first_name: me?.firstName ?? '',
    last_name: me?.lastName ?? '',
    bio: full.fullUser.about ?? '',
    tg_username: me?.username ?? '',
    tg_user_id: me?.id != null ? Number(me.id) : null,
    phone: me?.phone ?? '',
    avatar,
  };
}
