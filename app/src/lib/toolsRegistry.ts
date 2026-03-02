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
  'parsers',
  'email-sequence',
  'auto-report',
  'rdp',
] as const;

export type ToolId = (typeof ALL_TOOL_IDS)[number];

export interface ToolConfig {
  id: ToolId;
  title: string;
  description: string;
  href: string;
  badge?: string;
  badgeVariant?: 'amber' | 'emerald';
  accentColor?: 'blue' | 'emerald';
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
  rdp: {
    id: 'rdp',
    title: 'Удалённый рабочий стол',
    description: 'Подключение к удалённому ПК через браузер.',
    href: '/tools/rdp',
    accentColor: 'emerald',
  },
};
