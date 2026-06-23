/**
 * Реестр инструментов портала. Используется на странице /tools и в настройках видимости для пользователей.
 */

import type { UserRole } from '@/types';

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
  'base-constructor',
  'ai-caller',
  'ai-caller-v2',
  'databases',
  'database-review',
  'parsers',
  'email-sequence',
  'email-sequence-v2',
  'auto-report',
  'polza-reports',
  'audio-transcribe',
  'tg-transcribe',
  'rdp',
  'instantly',
  'tg-outreach',
  'habr-career',
  'tg-parser',
  'cis-lead-finder',
  'li-outreach',
  'li-outreach-v2',
  'sales-copilot',
  'sales-hypotheses',
  'knowledge-base',
  'bugor-outreach',
  'nash-outreach',
  'event-outreach',
  'reputation-finder',
  'our-bases',
  'sales-chat-analyzer',
] as const;

export type ToolId = (typeof ALL_TOOL_IDS)[number];

/** Tool IDs that are disabled by default (no visibility row = off). */
export const DEFAULT_OFF_TOOL_IDS: readonly ToolId[] = ['database-review', 'sales-chat-analyzer'] as const;

/**
 * Инструменты из DEFAULT_OFF_TOOL_IDS, которые всё же включены по умолчанию
 * для перечисленных ролей. Per-user настройка в админке имеет приоритет.
 */
export const DEFAULT_ON_TOOL_IDS_BY_ROLE: Partial<Record<UserRole, readonly ToolId[]>> = {
  technician: ['sales-chat-analyzer'],
  admin: ['sales-chat-analyzer'],
};

export interface ToolConfig {
  id: ToolId;
  title: string;
  title_en?: string;
  description: string;
  description_en?: string;
  href: string;
  badge?: string;
  badge_en?: string;
  badgeVariant?: 'amber' | 'emerald';
  accentColor?: 'blue' | 'emerald';
  disabled?: boolean;
  /** Внутрянка инструмента: какие вкладки, кнопки и шаги есть внутри. Не
   *  показывается на странице /tools — используется только Portal AI помощником,
   *  чтобы он мог отвечать на вопросы вида «где кнопка валидации почт». */
  details?: string;
}

export const TOOLS_CONFIG: Record<ToolId, ToolConfig> = {
  'done-for-you': {
    id: 'done-for-you',
    title: 'Done For You База',
    title_en: 'Done For You Database',
    description: 'AI соберет, очистит и персонализирует базу автоматически по брифу.',
    description_en: 'AI collects, cleans, and personalizes a database automatically from your brief.',
    href: '/tools/done-for-you',
    badge: 'В разработке',
    badge_en: 'In development',
    badgeVariant: 'amber',
    accentColor: 'blue',
    disabled: true,
  },
  'base-constructor': {
    id: 'base-constructor',
    title: 'Конструктор баз',
    title_en: 'Base Constructor',
    description: 'Загрузите CSV/Excel, выберите шаги обработки — очистка, обогащение, оценка ЦА — всё автоматически.',
    description_en: 'Upload CSV/Excel, pick processing steps — cleanup, enrichment, ICP scoring — all automated.',
    href: '/tools/base-constructor',
    accentColor: 'blue',
  },
  'ai-caller': {
    id: 'ai-caller',
    title: 'AI Звонилка',
    title_en: 'AI Caller',
    description: 'AI-ассистенты для обзвона: тестовые звонки, управление промптами и история.',
    description_en: 'AI assistants for calling: test calls, prompt management, and history.',
    href: '/tools/ai-caller',
    accentColor: 'blue',
  },
  'ai-caller-v2': {
    id: 'ai-caller-v2',
    title: 'AI Звонилка v2',
    title_en: 'AI Caller v2',
    description: 'Естественный голос через ElevenLabs Conversational AI.',
    description_en: 'Natural voice powered by ElevenLabs Conversational AI.',
    href: '/tools/ai-caller-v2',
    badge: 'В разработке',
    badge_en: 'In development',
    badgeVariant: 'amber',
    accentColor: 'emerald',
    disabled: true,
  },
  databases: {
    id: 'databases',
    title: 'Работа с базами',
    title_en: 'Database work',
    description: 'Табличный редактор с вкладками и копированием.',
    description_en: 'Spreadsheet-style editor with tabs and copy workflows.',
    href: '/tools/databases',
    accentColor: 'blue',
  },
  'database-review': {
    id: 'database-review',
    title: 'Проверка баз',
    title_en: 'Database review',
    description: 'Проверка и согласование баз: комментарии, пометки цветом, отправка клиенту.',
    description_en: 'Review and approve databases: comments, color marks, and client handoff.',
    href: '/tools/databases/review',
    accentColor: 'blue',
  },
  parsers: {
    id: 'parsers',
    title: 'Парсеры',
    title_en: 'Parsers',
    description: 'Набор парсеров для сбора данных, запусков и выгрузки результатов.',
    description_en: 'A parser toolbox for data collection, runs, and result exports.',
    href: '/parsers',
    accentColor: 'blue',
  },
  'email-sequence': {
    id: 'email-sequence',
    title: 'Цепочки писем',
    title_en: 'Email sequences',
    description: 'Генерация ресёрча по сегменту и цепочки холодных писем.',
    description_en: 'Generate segment research and cold email sequences.',
    href: '/tools/email-sequence',
    accentColor: 'blue',
  },
  'email-sequence-v2': {
    id: 'email-sequence-v2',
    title: 'Цепочки писем 2.0',
    title_en: 'Email sequences 2.0',
    description: 'Бриф → ценности → цепочка писем под сегмент. Многоступенчатый AI промптинг и редактор писем.',
    description_en: 'Brief → values → email chain for the segment. Multi-step AI prompting with letter editor.',
    href: '/tools/email-sequence-v2',
    badge: 'Новое',
    badge_en: 'New',
    badgeVariant: 'emerald',
    accentColor: 'emerald',
  },
  'auto-report': {
    id: 'auto-report',
    title: 'Автоотчёты',
    title_en: 'Auto reports',
    description:
      'Отчёт по кампаниям Instantly: подгрузка кампаний, выбор проектов, статистика и детализация по письмам.',
    description_en:
      'Instantly campaign reports: campaign loading, project selection, stats, and email-level details.',
    href: '/tools/auto-report',
    accentColor: 'blue',
  },
  'polza-reports': {
    id: 'polza-reports',
    title: 'Отчёты по рассылкам (Coldy / Trigga)',
    title_en: 'Outreach reports (Coldy / Trigga)',
    description:
      'Excel-отчёты по email-кампаниям: Coldy через автоматический заход в кабинет и Trigga через загрузку CSV.',
    description_en:
      'Excel reports for email campaigns: Coldy via automated cabinet login and Trigga via CSV upload.',
    href: '/tools/polza-reports',
    accentColor: 'blue',
  },
  'audio-transcribe': {
    id: 'audio-transcribe',
    title: 'Расшифровка видео и аудио',
    title_en: 'Audio & video transcription',
    description: 'Загрузка документа получение расшифровки при помощи AI.',
    description_en: 'Upload a file and get an AI transcription.',
    href: '/tools/audio-transcribe',
    accentColor: 'blue',
  },
  'tg-transcribe': {
    id: 'tg-transcribe',
    title: 'Транскрибации из ТГ',
    title_en: 'TG transcriptions',
    description: 'Автоматическая расшифровка видео из Telegram-группы с разделением по авторам.',
    description_en: 'Automatic transcription of Telegram group videos with author split.',
    href: '/tools/tg-transcribe',
    accentColor: 'blue',
  },
  'cis-lead-finder': {
    id: 'cis-lead-finder',
    title: 'CIS Lead Finder',
    description: 'Ищет ЛПР по ИНН и телефонам: нормализует компании и находит контакты.',
    description_en: 'Finds decision makers by tax ID and phone numbers: normalizes companies and contacts.',
    href: '/tools/cis-lead-finder',
    accentColor: 'blue',
    badge: 'В разработке',
    badge_en: 'In development',
    badgeVariant: 'amber',
    disabled: true,
  },
  'li-outreach': {
    id: 'li-outreach',
    title: 'LinkedIn Outreach',
    description: 'LinkedIn-аутрич: кампании, AI-персонализация, скрапинг лидов через Unipile.',
    description_en: 'LinkedIn outreach: campaigns, AI personalization, and lead scraping via Unipile.',
    href: '/tools/li-outreach',
    accentColor: 'blue',
  },
  'li-outreach-v2': {
    id: 'li-outreach-v2',
    title: 'LinkedIn Outreach 2.0',
    description: 'OpenOutreach runtime: продукт и ICP на входе, автономный поиск, квалификация и LinkedIn-диалоги на выходе.',
    description_en: 'OpenOutreach runtime: product and ICP in, autonomous LinkedIn discovery, qualification, and conversations out.',
    href: '/tools/li-outreach-v2',
    badge: 'В разработке',
    badge_en: 'In development',
    badgeVariant: 'amber',
    accentColor: 'emerald',
    disabled: true,
  },
  rdp: {
    id: 'rdp',
    title: 'Удалённый рабочий стол',
    title_en: 'Remote desktop',
    description: 'Подключение к удалённому ПК через браузер.',
    description_en: 'Connect to a remote PC directly from your browser.',
    href: '/tools/rdp',
    accentColor: 'emerald',
  },
  instantly: {
    id: 'instantly',
    title: 'Instantly',
    description: 'Управление email-аутричем: кампании, аккаунты, лиды, аналитика.',
    description_en: 'Email outreach management: campaigns, accounts, leads, and analytics.',
    href: '/instantly',
    accentColor: 'blue',
  },
  'tg-outreach': {
    id: 'tg-outreach',
    title: 'TG Аутрич',
    title_en: 'TG Outreach',
    description: 'Массовый Telegram-аутрич: кампании, автоответы GPT, квалификация лидов.',
    description_en: 'Bulk Telegram outreach: campaigns, GPT auto-replies, and lead qualification.',
    href: '/tools/tg-outreach',
    accentColor: 'blue',
  },
  'habr-career': {
    id: 'habr-career',
    title: 'Habr Career',
    description: 'Парсинг вакансий и компаний с career.habr.com с экспортом в таблицу.',
    description_en: 'Parse vacancies and companies from career.habr.com with table export.',
    href: '/tools/habr-career',
    accentColor: 'blue',
  },
  'tg-parser': {
    id: 'tg-parser',
    title: 'TG User Parser',
    description: 'Парсинг пользователей из Telegram: сообщения в чатах, участники, комментарии. Экспорт в Excel/CSV.',
    description_en: 'Telegram user parsing: chat messages, participants, comments. Export to Excel/CSV.',
    href: '/tools/tg-parser',
    accentColor: 'blue',
  },
  'sales-copilot': {
    id: 'sales-copilot',
    title: 'Sales Copilot',
    description: 'AI-подсказки для менеджеров: черновики ответов в TG и реанимация холодных диалогов.',
    description_en: 'AI hints for managers: TG draft replies and revival of cold conversations.',
    href: '/tools/sales-copilot',
    accentColor: 'blue',
  },
  'sales-hypotheses': {
    id: 'sales-hypotheses',
    title: 'Гипотезы по сайту',
    title_en: 'Hypotheses from website',
    description: 'Вставьте сайт компании — AI заполнит бриф и выдаст готовые гипотезы по сбору базы.',
    description_en: 'Paste a company website — AI fills the brief and returns ready lead-source hypotheses.',
    href: '/tools/sales-hypotheses',
    badge: 'Новое',
    badge_en: 'New',
    badgeVariant: 'emerald',
    accentColor: 'emerald',
  },
  'knowledge-base': {
    id: 'knowledge-base',
    title: 'База знаний',
    title_en: 'Knowledge base',
    description: 'Документы, переписки, расшифровки встреч — контекст для AI-инструментов.',
    description_en: 'Documents, chats, and meeting transcripts as context for AI tools.',
    href: '/tools/knowledge-base',
    accentColor: 'emerald',
  },
  'bugor-outreach': {
    id: 'bugor-outreach',
    title: 'Наш бугор аутрич',
    title_en: 'Global outreach',
    description: 'Ежедневный автосбор горячих лидов: раунды, найм SDR, YC-батчи, запуски.',
    description_en: 'Daily auto-collection of hot leads: rounds, SDR hiring, YC batches, launches.',
    href: '/tools/bugor-outreach',
    accentColor: 'blue',
  },
  'nash-outreach': {
    id: 'nash-outreach',
    title: 'Наш аутрич',
    title_en: 'Local outreach',
    description: 'Автосбор российских B2B-лидов: HH.ru наём, VC.ru фандинг, запуски.',
    description_en: 'Auto-collection of Russian B2B leads: HH.ru hiring, VC.ru funding, launches.',
    href: '/tools/nash-outreach',
    accentColor: 'blue',
  },
  'event-outreach': {
    id: 'event-outreach',
    title: 'Ивент аутрич',
    title_en: 'Event Outreach',
    description: 'Сбор базы под ивент-агентство: фильтр реестра, сигналы (юбилей, HH, размер) и персонализированный hook.',
    description_en: 'Base building for event agencies: registry filter, signals (anniversary, HH, size), and a personalized hook.',
    href: '/tools/event-outreach',
    accentColor: 'blue',
  },
  'reputation-finder': {
    id: 'reputation-finder',
    title: 'Reputation Finder',
    description: 'Поиск компаний с плохой репутацией: низкие рейтинги, негативная выдача, без SERM.',
    href: '/tools/reputation-finder',
    accentColor: 'blue',
    badge: 'Beta',
    badgeVariant: 'amber',
  },
  'our-bases': {
    id: 'our-bases',
    title: 'Наша база баз',
    title_en: 'Company Directory',
    description: 'Поиск компаний по реестру: регионы, виды деятельности, фильтры, ИНН.',
    description_en: 'Company registry search: regions, activity types, filters, tax IDs.',
    href: '/tools/our-bases',
    accentColor: 'blue',
  },
  'sales-chat-analyzer': {
    id: 'sales-chat-analyzer',
    title: 'Анализатор сейлз-переписок',
    title_en: 'Sales chat analyzer',
    description: 'Подключение Telegram-аккаунтов сейлз-менеджеров и запись всех их диалогов в базу.',
    description_en: 'Connect sales managers’ Telegram accounts and log all their dialogs.',
    href: '/tools/sales-chat-analyzer',
    accentColor: 'emerald',
  },
};

export interface ToolGroup {
  label: string;
  label_en?: string;
  toolIds: ToolId[];
}

export const TOOL_GROUPS: ToolGroup[] = [
  {
    label: 'Аутрич',
    label_en: 'Outreach',
    toolIds: ['instantly', 'li-outreach', 'li-outreach-v2', 'tg-outreach', 'email-sequence', 'email-sequence-v2', 'sales-copilot', 'sales-hypotheses', 'ai-caller', 'ai-caller-v2', 'bugor-outreach', 'nash-outreach', 'event-outreach', 'sales-chat-analyzer'],
  },
  {
    label: 'Базы и данные',
    label_en: 'Databases and data',
    toolIds: ['done-for-you', 'base-constructor', 'databases', 'database-review', 'our-bases'],
  },
  {
    label: 'Парсеры и поиск лидов',
    label_en: 'Parsers and lead search',
    toolIds: ['parsers', 'habr-career', 'tg-parser', 'cis-lead-finder', 'reputation-finder'],
  },
  {
    label: 'Утилиты',
    label_en: 'Utilities',
    toolIds: ['auto-report', 'polza-reports', 'audio-transcribe', 'tg-transcribe', 'rdp'],
  },
  {
    label: 'AI и знания',
    label_en: 'AI and knowledge',
    toolIds: ['knowledge-base'],
  },
];
