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
}

export type ProfileValidation =
  | { ok: true }
  | { ok: false; field: keyof ProfileInput; reason: string };

export function validateProfile(input: ProfileInput): ProfileValidation {
  const first = (input.first_name ?? '').trim();
  if (!first) {
    return { ok: false, field: 'first_name', reason: 'Имя не может быть пустым' };
  }

  const fields: Array<keyof ProfileInput> = ['first_name', 'last_name', 'bio'];
  const labels: Record<keyof ProfileInput, string> = {
    first_name: 'Имя',
    last_name: 'Фамилия',
    bio: 'Описание',
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
