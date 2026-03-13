/**
 * Реестр инструментов портала. Используется на странице /tools и в настройках видимости для пользователей.
 */

/** Идентификаторы вкладок боковой панели, управляемых через admin */
export const ALL_NAV_TAB_IDS = ['nav-tasks-board'] as const;
export type NavTabId = (typeof ALL_NAV_TAB_IDS)[number];

export interface NavTabConfig {
  id: NavTabId;
  title: string;
  description: string;
}

export const NAV_TABS_CONFIG: Record<NavTabId, NavTabConfig> = {
  'nav-tasks-board': {
    id: 'nav-tasks-board',
    title: 'Доска',
    description: 'Отдельный пункт в боковой панели для открытия доски задач',
  },
};

export const ALL_TOOL_IDS = [
  'done-for-you',
  'ai-caller',
  'ai-caller-v2',
  'databases',
  'database-review',
  'parsers',
  'email-sequence',
  'auto-report',
  'audio-transcribe',
  'tg-transcribe',
  'rdp',
  'instantly',
  'tg-outreach',
  'habr-career',
  'linkedin-bot',
  'tg-parser',
  'cis-lead-finder',
] as const;

export type ToolId = (typeof ALL_TOOL_IDS)[number];

/** Tool IDs that are disabled by default (no visibility row = off). */
export const DEFAULT_OFF_TOOL_IDS: readonly ToolId[] = ['database-review'] as const;

export interface ToolConfig {
  id: ToolId;
  title: string;
  description: string;
  href: string;
  badge?: string;
  badgeVariant?: 'amber' | 'emerald';
  accentColor?: 'blue' | 'emerald';
  disabled?: boolean;
}

export const TOOLS_CONFIG: Record<ToolId, ToolConfig> = {
  'done-for-you': {
    id: 'done-for-you',
    title: 'Done For You База',
    description: 'AI соберет, очистит и персонализирует базу автоматически по брифу.',
    href: '/tools/done-for-you',
    badge: 'В разработке',
    badgeVariant: 'amber',
    accentColor: 'blue',
  },
  'ai-caller': {
    id: 'ai-caller',
    title: 'AI Звонилка',
    description: 'AI-ассистенты для обзвона: тестовые звонки, управление промптами и история.',
    href: '/tools/ai-caller',
    accentColor: 'blue',
  },
  'ai-caller-v2': {
    id: 'ai-caller-v2',
    title: 'AI Звонилка v2',
    description: 'Естественный голос через ElevenLabs Conversational AI.',
    href: '/tools/ai-caller-v2',
    badge: 'ElevenLabs',
    badgeVariant: 'emerald',
    accentColor: 'emerald',
  },
  databases: {
    id: 'databases',
    title: 'Работа с базами',
    description: 'Табличный редактор с вкладками и копированием.',
    href: '/tools/databases',
    accentColor: 'blue',
  },
  'database-review': {
    id: 'database-review',
    title: 'Проверка баз',
    description: 'Проверка и согласование баз: комментарии, пометки цветом, отправка клиенту.',
    href: '/tools/databases/review',
    accentColor: 'blue',
  },
  parsers: {
    id: 'parsers',
    title: 'Парсеры',
    description: 'Набор парсеров для сбора данных, запусков и выгрузки результатов.',
    href: '/parsers',
    accentColor: 'blue',
  },
  'email-sequence': {
    id: 'email-sequence',
    title: 'Цепочки писем',
    description: 'Генерация ресёрча по сегменту и цепочки холодных писем.',
    href: '/tools/email-sequence',
    accentColor: 'blue',
  },
  'auto-report': {
    id: 'auto-report',
    title: 'Автоотчёты',
    description:
      'Отчёт по кампаниям Instantly: подгрузка кампаний, выбор проектов, статистика и детализация по письмам.',
    href: '/tools/auto-report',
    accentColor: 'blue',
  },
  'audio-transcribe': {
    id: 'audio-transcribe',
    title: 'Расшифровка видео и аудио',
    description: 'Загрузка документа получение расшифровки при помощи AI.',
    href: '/tools/audio-transcribe',
    accentColor: 'blue',
  },
  'tg-transcribe': {
    id: 'tg-transcribe',
    title: 'Транскрибации из ТГ',
    description: 'Автоматическая расшифровка видео из Telegram-группы с разделением по авторам.',
    href: '/tools/tg-transcribe',
    accentColor: 'blue',
  },
  'cis-lead-finder': {
    id: 'cis-lead-finder',
    title: 'CIS Lead Finder',
    description: 'Импорт таблиц (ИНН/телефоны) → нормализация компаний → пробив Telegram → контакты ЛПР.',
    href: '/tools/cis-lead-finder',
    badge: 'В разработке',
    badgeVariant: 'amber',
    accentColor: 'blue',
    disabled: true,
  },
  rdp: {
    id: 'rdp',
    title: 'Удалённый рабочий стол',
    description: 'Подключение к удалённому ПК через браузер.',
    href: '/tools/rdp',
    accentColor: 'emerald',
  },
  instantly: {
    id: 'instantly',
    title: 'Instantly',
    description: 'Управление email-аутричем: кампании, аккаунты, лиды, аналитика.',
    href: '/instantly',
    accentColor: 'blue',
  },
  'tg-outreach': {
    id: 'tg-outreach',
    title: 'TG Аутрич',
    description: 'Массовый Telegram-аутрич: кампании, автоответы GPT, квалификация лидов.',
    href: '/tools/tg-outreach',
    accentColor: 'blue',
  },
  'habr-career': {
    id: 'habr-career',
    title: 'Habr Career',
    description: 'Парсинг вакансий и компаний с career.habr.com с экспортом в таблицу.',
    href: '/tools/habr-career',
    accentColor: 'blue',
  },
  'linkedin-bot': {
    id: 'linkedin-bot',
    title: 'LinkedIn Companies',
    description: 'Парсинг компаний по поисковому URL LinkedIn с экспортом в CSV, Excel или Google Sheets.',
    href: '/tools/linkedin-bot',
    accentColor: 'blue',
  },
  'tg-parser': {
    id: 'tg-parser',
    title: 'TG User Parser',
    description: 'Парсинг пользователей из Telegram: сообщения в чатах, участники, комментарии. Экспорт в Excel/CSV.',
    href: '/tools/tg-parser',
    accentColor: 'blue',
  },
};
