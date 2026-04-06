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
  'tg-parser',
  'cis-lead-finder',
  'li-outreach',
  'sales-copilot',
  'knowledge-base',
  'bugor-outreach',
  'nash-outreach',
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
    disabled: true,
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
    badge: 'В разработке',
    badgeVariant: 'amber',
    accentColor: 'emerald',
    disabled: true,
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
    description: 'Ищет ЛПР по ИНН и телефонам: нормализует компании и находит контакты.',
    href: '/tools/cis-lead-finder',
    accentColor: 'blue',
  },
  'li-outreach': {
    id: 'li-outreach',
    title: 'LinkedIn Outreach',
    description: 'LinkedIn-аутрич: кампании, AI-персонализация, скрапинг лидов через Unipile.',
    href: '/tools/li-outreach',
    accentColor: 'blue',
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
  'tg-parser': {
    id: 'tg-parser',
    title: 'TG User Parser',
    description: 'Парсинг пользователей из Telegram: сообщения в чатах, участники, комментарии. Экспорт в Excel/CSV.',
    href: '/tools/tg-parser',
    accentColor: 'blue',
  },
  'sales-copilot': {
    id: 'sales-copilot',
    title: 'Sales Copilot',
    description: 'AI-подсказки для менеджеров: черновики ответов в TG и реанимация холодных диалогов.',
    href: '/tools/sales-copilot',
    accentColor: 'blue',
  },
  'knowledge-base': {
    id: 'knowledge-base',
    title: 'База знаний',
    description: 'Документы, переписки, расшифровки встреч — контекст для AI-инструментов.',
    href: '/tools/knowledge-base',
    accentColor: 'emerald',
  },
  'bugor-outreach': {
    id: 'bugor-outreach',
    title: 'Наш бугор аутрич',
    description: 'Ежедневный автосбор горячих лидов: раунды, найм SDR, YC-батчи, запуски.',
    href: '/tools/bugor-outreach',
    accentColor: 'blue',
  },
  'nash-outreach': {
    id: 'nash-outreach',
    title: 'Наш аутрич',
    description: 'Автосбор российских B2B-лидов: HH.ru наём, VC.ru фандинг, запуски.',
    href: '/tools/nash-outreach',
    accentColor: 'blue',
  },
};

export interface ToolGroup {
  label: string;
  toolIds: ToolId[];
}

export const TOOL_GROUPS: ToolGroup[] = [
  {
    label: 'Аутрич',
    toolIds: ['instantly', 'li-outreach', 'tg-outreach', 'email-sequence', 'sales-copilot', 'ai-caller', 'ai-caller-v2', 'bugor-outreach', 'nash-outreach'],
  },
  {
    label: 'Базы и данные',
    toolIds: ['done-for-you', 'databases', 'database-review'],
  },
  {
    label: 'Парсеры и поиск лидов',
    toolIds: ['parsers', 'habr-career', 'tg-parser', 'cis-lead-finder'],
  },
  {
    label: 'Утилиты',
    toolIds: ['auto-report', 'audio-transcribe', 'tg-transcribe', 'rdp'],
  },
  {
    label: 'AI и знания',
    toolIds: ['knowledge-base'],
  },
];
