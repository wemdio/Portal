/**
 * Проверка профиля до похода в Telegram.
 *
 * Сервер отвечает кодами вроде FIRSTNAME_INVALID — оператору они ничего не
 * объясняют, а каждая попытка стоит подключения через мобильный прокси.
 * Дешевле отсечь очевидное здесь.
 */

/** Лимиты Telegram на длину полей профиля. */
export const PROFILE_LIMITS = { first_name: 64, last_name: 64, bio: 70 } as const;

export interface ProfileInput {
  first_name: string;
  last_name: string;
  bio: string;
  /** Пустая строка означает «снять юзернейм», а не «оставить как было». */
  username?: string;
}

export type ProfileValidation =
  | { ok: true }
  | { ok: false; field: keyof ProfileInput; reason: string };

/**
 * Привести юзернейм к тому виду, в котором его ждёт Telegram.
 *
 * Оператор копирует имя из чата вместе с «@», а иногда и целой ссылкой —
 * отрезаем и то, и другое, чтобы не ловить отказ на ровном месте.
 */
export function normalizeUsername(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '')
    .replace(/^@/, '')
    .trim();
}

/**
 * Правила Telegram: 5–32 знака, латиница, цифры и подчёркивание, начинается с
 * буквы. Подряд идущие подчёркивания и подчёркивание в конце отвергает и сам
 * клиент — проверяем здесь, чтобы не тратить подключение через мобильный прокси
 * на заведомо отказной запрос.
 */
export function validateUsername(raw: string): string | null {
  const value = normalizeUsername(raw);
  if (!value) return null; // пусто — это снятие юзернейма, оно допустимо
  if (value.length < 5) return 'Юзернейм: не короче 5 знаков';
  if (value.length > 32) return 'Юзернейм: не больше 32 знаков';
  if (!/^[A-Za-z]/.test(value)) return 'Юзернейм: должен начинаться с латинской буквы';
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    return 'Юзернейм: только латиница, цифры и подчёркивание';
  }
  if (value.endsWith('_')) return 'Юзернейм: не может заканчиваться подчёркиванием';
  if (value.includes('__')) return 'Юзернейм: два подчёркивания подряд Telegram не примет';
  return null;
}

export function validateProfile(input: ProfileInput): ProfileValidation {
  const first = (input.first_name ?? '').trim();
  if (!first) {
    return { ok: false, field: 'first_name', reason: 'Имя не может быть пустым' };
  }

  const usernameError = validateUsername(input.username ?? '');
  if (usernameError) {
    return { ok: false, field: 'username', reason: usernameError };
  }

  // Только поля с лимитом длины — у юзернейма своя проверка выше.
  const fields: Array<keyof typeof PROFILE_LIMITS> = ['first_name', 'last_name', 'bio'];
  const labels: Record<keyof ProfileInput, string> = {
    first_name: 'Имя',
    last_name: 'Фамилия',
    bio: 'Описание',
    username: 'Юзернейм',
  };

  for (const field of fields) {
    const value = (input[field] ?? '').trim();
    const limit = PROFILE_LIMITS[field];
    if (value.length > limit) {
      return { ok: false, field, reason: `${labels[field]}: не больше ${limit} знаков` };
    }
  }

  return { ok: true };
}
