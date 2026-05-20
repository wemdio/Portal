export const LOCALES = ['ru', 'en', 'de', 'fr', 'es', 'it'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'ru';
export const LOCALE_COOKIE = 'x-portal-locale';

/**
 * Target languages for the on-the-fly translator: every locale EXCEPT the
 * source language (Russian). Used by the API route and the client translator
 * to validate input and decide whether to call the LLM at all.
 */
export const TRANSLATABLE_TARGET_LOCALES = ['en', 'de', 'fr', 'es', 'it'] as const;
export type TargetLocale = (typeof TRANSLATABLE_TARGET_LOCALES)[number];

const LOCALE_SET = new Set<string>(LOCALES);

export function normalizeLocale(value: unknown): Locale {
  if (typeof value !== 'string') return DEFAULT_LOCALE;
  return LOCALE_SET.has(value) ? (value as Locale) : DEFAULT_LOCALE;
}

export function isTargetLocale(value: unknown): value is TargetLocale {
  return typeof value === 'string' && (TRANSLATABLE_TARGET_LOCALES as readonly string[]).includes(value);
}

// Intl.DateTimeFormat / Intl.NumberFormat locale tags. Keeps the BCP-47 form
// in one place so callers don't sprinkle hand-built "ru-RU" / "en-US" strings.
const INTL_LOCALE_BY_KEY: Record<Locale, string> = {
  ru: 'ru-RU',
  en: 'en-US',
  de: 'de-DE',
  fr: 'fr-FR',
  es: 'es-ES',
  it: 'it-IT',
};

export function toIntlLocale(locale: Locale): string {
  return INTL_LOCALE_BY_KEY[locale];
}

export interface LocaleDescriptor {
  /** Short uppercase code shown in the language switcher. */
  code: string;
  /** Native-language name for the menu item label. */
  nativeName: string;
  /** Flag emoji shown in the dropdown trigger. */
  flag: string;
}

export const LOCALE_DESCRIPTORS: Record<Locale, LocaleDescriptor> = {
  ru: { code: 'RU', nativeName: 'Русский',   flag: '🇷🇺' },
  en: { code: 'EN', nativeName: 'English',   flag: '🇬🇧' },
  de: { code: 'DE', nativeName: 'Deutsch',   flag: '🇩🇪' },
  fr: { code: 'FR', nativeName: 'Français',  flag: '🇫🇷' },
  es: { code: 'ES', nativeName: 'Español',   flag: '🇪🇸' },
  it: { code: 'IT', nativeName: 'Italiano',  flag: '🇮🇹' },
};

export const commonDictionary = {
  portal:        { ru: 'Portal',          en: 'Portal',          de: 'Portal',          fr: 'Portal',           es: 'Portal',           it: 'Portal' },
  openMenu:      { ru: 'Открыть меню',    en: 'Open menu',       de: 'Menü öffnen',     fr: 'Ouvrir le menu',   es: 'Abrir menú',       it: 'Apri menu' },
  closeMenu:     { ru: 'Закрыть меню',    en: 'Close menu',      de: 'Menü schließen',  fr: 'Fermer le menu',   es: 'Cerrar menú',      it: 'Chiudi menu' },
  openProfile:   { ru: 'Открыть профиль', en: 'Open profile',    de: 'Profil öffnen',   fr: 'Ouvrir le profil', es: 'Abrir perfil',     it: 'Apri profilo' },
  signOut:       { ru: 'Выйти',           en: 'Sign out',        de: 'Abmelden',        fr: 'Déconnexion',      es: 'Cerrar sesión',    it: 'Esci' },
  userFallback:  { ru: 'Пользователь',    en: 'User',            de: 'Benutzer',        fr: 'Utilisateur',      es: 'Usuario',          it: 'Utente' },
  unknownRole:   { ru: 'Без роли',        en: 'No role',         de: 'Keine Rolle',     fr: 'Sans rôle',        es: 'Sin rol',          it: 'Nessun ruolo' },
  language:      { ru: 'Язык',            en: 'Language',        de: 'Sprache',         fr: 'Langue',           es: 'Idioma',           it: 'Lingua' },
  retry:         { ru: 'Попробовать снова', en: 'Try again',     de: 'Erneut versuchen', fr: 'Réessayer',       es: 'Reintentar',       it: 'Riprova' },
  somethingWentWrong: { ru: 'Что-то пошло не так', en: 'Something went wrong', de: 'Etwas ist schiefgelaufen', fr: 'Une erreur est survenue', es: 'Algo salió mal', it: 'Qualcosa è andato storto' },
  unexpectedError: {
    ru: 'Произошла непредвиденная ошибка. Попробуйте обновить страницу.',
    en: 'An unexpected error occurred. Please try refreshing the page.',
    de: 'Ein unerwarteter Fehler ist aufgetreten. Bitte aktualisieren Sie die Seite.',
    fr: 'Une erreur inattendue s’est produite. Veuillez actualiser la page.',
    es: 'Se produjo un error inesperado. Intenta actualizar la página.',
    it: 'Si è verificato un errore imprevisto. Prova ad aggiornare la pagina.',
  },
  login:         { ru: 'Вход',            en: 'Login',           de: 'Anmeldung',       fr: 'Connexion',        es: 'Inicio de sesión', it: 'Accesso' },
  maintenance:   { ru: 'Обновление портала', en: 'Portal maintenance', de: 'Portal-Wartung', fr: 'Maintenance du portail', es: 'Mantenimiento del portal', it: 'Manutenzione del portale' },
  reviewBase:    { ru: 'Просмотр базы',   en: 'Database review', de: 'Datenbankprüfung', fr: 'Revue de la base', es: 'Revisión de base', it: 'Revisione database' },
  projects:      { ru: 'Проекты',         en: 'Projects',        de: 'Projekte',        fr: 'Projets',          es: 'Proyectos',        it: 'Progetti' },
  settings:      { ru: 'Настройки',       en: 'Settings',        de: 'Einstellungen',   fr: 'Paramètres',       es: 'Configuración',    it: 'Impostazioni' },
  regulation:    { ru: 'Регламент',       en: 'Regulation',      de: 'Regelwerk',       fr: 'Règlement',        es: 'Reglamento',       it: 'Regolamento' },
  notifications: { ru: 'Уведомления',     en: 'Notifications',   de: 'Benachrichtigungen', fr: 'Notifications', es: 'Notificaciones',   it: 'Notifiche' },
  noNotifications: { ru: 'Уведомлений пока нет', en: 'No notifications yet', de: 'Noch keine Benachrichtigungen', fr: 'Aucune notification pour le moment', es: 'Aún no hay notificaciones', it: 'Nessuna notifica per ora' },
  noNotificationsHint: {
    ru: 'Здесь будут появляться уведомления о задачах, кампаниях и событиях.',
    en: 'Notifications about tasks, campaigns, and events will appear here.',
    de: 'Hier erscheinen Benachrichtigungen zu Aufgaben, Kampagnen und Ereignissen.',
    fr: 'Les notifications sur les tâches, campagnes et événements apparaîtront ici.',
    es: 'Aquí aparecerán las notificaciones sobre tareas, campañas y eventos.',
    it: 'Qui appariranno le notifiche su attività, campagne ed eventi.',
  },
  translatingPage: {
    ru: 'Перевод страницы…',
    en: 'Translating page…',
    de: 'Seite wird übersetzt…',
    fr: 'Traduction de la page…',
    es: 'Traduciendo la página…',
    it: 'Traduzione della pagina…',
  },
  translatingHint: {
    ru: 'Подождите несколько секунд, мы переводим интерфейс.',
    en: 'Hold on a moment — we’re translating the interface.',
    de: 'Einen Moment bitte – die Oberfläche wird übersetzt.',
    fr: 'Patientez quelques secondes, nous traduisons l’interface.',
    es: 'Un momento, estamos traduciendo la interfaz.',
    it: 'Un momento, stiamo traducendo l’interfaccia.',
  },
} as const;

type DictEntry = (typeof commonDictionary)[keyof typeof commonDictionary];

export function dict(entry: DictEntry, locale: Locale): string {
  return entry[locale];
}

/** Short uppercase code (RU/EN/DE/…) used in compact UI. */
export function switchLocaleLabel(locale: Locale): string {
  return LOCALE_DESCRIPTORS[locale].code;
}
