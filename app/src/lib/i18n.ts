export const LOCALES = ['ru', 'en'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'ru';
export const LOCALE_COOKIE = 'x-portal-locale';

export function normalizeLocale(value: unknown): Locale {
  return value === 'en' ? 'en' : DEFAULT_LOCALE;
}

export function toIntlLocale(locale: Locale): string {
  return locale === 'en' ? 'en-US' : 'ru-RU';
}

export const commonDictionary = {
  portal: { ru: 'Portal', en: 'Portal' },
  openMenu: { ru: 'Открыть меню', en: 'Open menu' },
  closeMenu: { ru: 'Закрыть меню', en: 'Close menu' },
  openProfile: { ru: 'Открыть профиль', en: 'Open profile' },
  signOut: { ru: 'Выйти', en: 'Sign out' },
  userFallback: { ru: 'Пользователь', en: 'User' },
  unknownRole: { ru: 'Без роли', en: 'No role' },
  language: { ru: 'Язык', en: 'Language' },
  retry: { ru: 'Попробовать снова', en: 'Try again' },
  somethingWentWrong: { ru: 'Что-то пошло не так', en: 'Something went wrong' },
  unexpectedError: {
    ru: 'Произошла непредвиденная ошибка. Попробуйте обновить страницу.',
    en: 'An unexpected error occurred. Please try refreshing the page.',
  },
  login: { ru: 'Вход', en: 'Login' },
  maintenance: { ru: 'Обновление портала', en: 'Portal maintenance' },
  reviewBase: { ru: 'Просмотр базы', en: 'Database review' },
  projects: { ru: 'Проекты', en: 'Projects' },
  settings: { ru: 'Настройки', en: 'Settings' },
  regulation: { ru: 'Регламент', en: 'Regulation' },
} as const;

type DictEntry = (typeof commonDictionary)[keyof typeof commonDictionary];

export function dict(entry: DictEntry, locale: Locale): string {
  return entry[locale];
}

export function switchLocaleLabel(locale: Locale): string {
  return locale === 'en' ? 'EN' : 'RU';
}
