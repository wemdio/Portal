/**
 * Shared types for the multi-page website signal extraction system.
 *
 * Design notes:
 * - `ExtractorKey` is the atomic unit the user picks via UI checkboxes.
 *   Each extractor maps to 0..N subpages it needs (see `EXTRACTOR_TO_SUBPAGES`).
 * - `SubpageKind` is the abstract notion of a "kind of page" we look for via
 *   anchor link discovery on the main page. Real URLs are resolved at runtime.
 * - `ExtractedData` is the full JSON shape stored in `result_text`. All fields
 *   except a few defaults are optional, so we can ship per-extractor without
 *   schema changes for each addition.
 */

export type SubpageKind =
  | 'pricing'
  | 'careers'
  | 'cases'
  | 'integrations'
  | 'about'
  | 'blog';

export const ALL_SUBPAGE_KINDS: SubpageKind[] = [
  'pricing',
  'careers',
  'cases',
  'integrations',
  'about',
  'blog',
];

export type ExtractorKey =
  | 'stack'
  | 'profile'
  | 'customers'        // legacy: не предлагается в UI, остаётся для рендера старых result_text
  | 'client_segment'   // наполняет столбец «Клиенты» сегментом ЦА (заменил список брендов)
  | 'cases_count'
  | 'case_industries'
  | 'enterprise_logos'
  | 'pricing_model'
  | 'pricing_min'
  | 'free_trial'
  | 'vacancies_count'
  | 'hiring_roles'
  | 'integrations'
  | 'founded_year'
  | 'team_size'
  | 'blog_last_post'
  | 'social_media'
  // LLM-picked single "most interesting post" from company socials.
  // Renders in xlsx as готовая строка "YYYY-MM-DD [url] — text" или DASH.
  // Заменил собой 8 event_* ключей (открытие/ребрендинг/ремонт/география +
  // их summaries) — на практике event-сигналы у большинства компаний были
  // Нет/Нет/Нет/—. Один читабельный пост даёт больше пользы для outreach.
  | 'social_latest_news';

export const ALL_EXTRACTOR_KEYS: ExtractorKey[] = [
  'stack',
  'profile',
  'client_segment',
  'cases_count',
  'case_industries',
  'enterprise_logos',
  'pricing_model',
  'pricing_min',
  'free_trial',
  'vacancies_count',
  'hiring_roles',
  'integrations',
  'founded_year',
  'team_size',
  'blog_last_post',
  'social_media',
  'social_latest_news',
];

/** Which subpages each extractor needs to be fetched. Empty = main page only. */
export const EXTRACTOR_TO_SUBPAGES: Record<ExtractorKey, SubpageKind[]> = {
  stack: [],
  profile: [],
  customers: ['cases'],
  client_segment: ['cases', 'about'],
  cases_count: ['cases'],
  case_industries: ['cases'],
  enterprise_logos: ['cases'],
  pricing_model: ['pricing'],
  pricing_min: ['pricing'],
  free_trial: ['pricing'],
  vacancies_count: ['careers'],
  hiring_roles: ['careers'],
  integrations: ['integrations'],
  founded_year: ['about'],
  team_size: ['about'],
  blog_last_post: ['blog'],
  // Соцсети традиционно живут в footer'е главной + в контактах. Подгружаем
  // about/contact-страницу как fallback, потому что у многих b2b-сайтов
  // главная — это лендинг с прицепами на «контакты» отдельно.
  social_media: ['about'],
  // social_latest_news = LLM picks best post out of last ~10 from socials.
  // Подстраницы те же что у social_media — нужно чтобы парсер нашёл ссылки
  // на TG/VK/OK; сами посты тянутся уже отдельным запросом по этим URL'ам.
  social_latest_news: ['about'],
};

/**
 * UI-only cascade rules: when the user enables key X, also auto-enable Y[]
 * and show a toast about it. Implementation must NOT use these to silently
 * change behavior — they exist only to keep the UI consistent.
 */
export const CASCADE_RULES: Partial<Record<ExtractorKey, ExtractorKey[]>> = {
  pricing_min: ['pricing_model'],
  free_trial: ['pricing_model'],
  hiring_roles: ['vacancies_count'],
  // social_latest_news берёт посты из соцсетей — без social_media парсер
  // не знает где их искать. При включении автоматически подсветим social_media.
  social_latest_news: ['social_media'],
};

/**
 * Default user-facing labels for each extractor. Used as both the spreadsheet
 * column header and the checkbox label in the UI. Keeping them centralized
 * ensures the modal preview, request payload, and applied column header all
 * stay in sync (DRY).
 */
export const EXTRACTOR_LABELS: Record<ExtractorKey, string> = {
  stack: 'Стек',
  profile: 'Профиль',
  customers: 'Клиенты',
  client_segment: 'Клиенты',
  cases_count: 'Кол-во кейсов',
  case_industries: 'Отрасли в кейсах',
  enterprise_logos: 'Enterprise-логотипы',
  pricing_model: 'Модель продаж',
  pricing_min: 'Мин. цена услуг',
  free_trial: 'Free trial',
  vacancies_count: 'Открытых вакансий',
  hiring_roles: 'Кого нанимают',
  integrations: 'Интеграции',
  founded_year: 'Год основания',
  team_size: 'Размер команды',
  blog_last_post: 'Последний пост',
  social_media: 'Соцсети',
  social_latest_news: 'Последняя новость из соц сетей',
};

/**
 * Built-in presets the user sees as quick-start buttons. Custom user presets
 * are persisted to localStorage on top of these.
 */
export type SignalPresetId = 'basic' | 'outreach' | 'audit' | 'all';

export interface SignalPreset {
  id: SignalPresetId;
  name: string;
  description: string;
  extractors: ExtractorKey[];
}

export const BUILTIN_PRESETS: Readonly<Record<SignalPresetId, SignalPreset>> = {
  basic: {
    id: 'basic',
    name: 'Базовый',
    description: 'Только Стек + Профиль (быстро, без подстраниц).',
    extractors: ['stack', 'profile'],
  },
  outreach: {
    id: 'outreach',
    name: 'Outreach',
    description: 'Стек + Профиль + клиенты, отрасли в кейсах, цены, найм — для персонализации писем.',
    extractors: [
      'stack',
      'profile',
      'client_segment',
      'case_industries',
      'pricing_model',
      'hiring_roles',
      'vacancies_count',
    ],
  },
  audit: {
    id: 'audit',
    name: 'Аудит',
    description: 'Максимум сигналов: клиенты, кейсы, отрасли, цены, интеграции, найм, возраст компании, последний пост, соцсети.',
    extractors: [
      'stack',
      'profile',
      'client_segment',
      'cases_count',
      'case_industries',
      'enterprise_logos',
      'pricing_model',
      'pricing_min',
      'free_trial',
      'vacancies_count',
      'hiring_roles',
      'integrations',
      'founded_year',
      'blog_last_post',
      'social_media',
    ],
  },
  // Полный набор: все доступные сигналы разом. Удобно когда оператор хочет
  // максимум данных без выборки чекбоксов вручную. Включает
  // social_latest_news — LLM-выбор лучшего поста из соцсетей, самая дорогая
  // часть пайплайна по LLM-стоимости (~$0.003/URL extra).
  all: {
    id: 'all',
    name: 'Все',
    description: 'Все доступные сигналы — включая последнюю новость из соцсетей (LLM выбирает один лучший пост из последних). Самый полный набор.',
    extractors: [...ALL_EXTRACTOR_KEYS],
  },
};

/**
 * UI accordion grouping. Order here drives the order of sections in the modal.
 * Within a section, order drives the order of checkboxes.
 */
export interface ExtractorGroup {
  id: string;
  title: string;
  description: string;
  extractors: ExtractorKey[];
}

export const EXTRACTOR_GROUPS: ExtractorGroup[] = [
  {
    id: 'base',
    title: 'Основное',
    description: 'Главная страница. Без обращений к подстраницам.',
    extractors: ['stack', 'profile'],
  },
  {
    id: 'customers',
    title: 'Клиенты и кейсы',
    description: 'Подгружает /cases, /clients, /portfolio.',
    extractors: ['client_segment', 'cases_count', 'case_industries', 'enterprise_logos'],
  },
  {
    id: 'pricing',
    title: 'Pricing',
    description: 'Подгружает /pricing, /tariffs.',
    extractors: ['pricing_model', 'pricing_min', 'free_trial'],
  },
  {
    id: 'hiring',
    title: 'Найм',
    description: 'Подгружает /careers, /jobs, /vacancies.',
    extractors: ['vacancies_count', 'hiring_roles'],
  },
  {
    id: 'company',
    title: 'Компания и интеграции',
    description: 'Подгружает /about, /integrations, /blog.',
    extractors: ['integrations', 'founded_year', 'team_size', 'blog_last_post', 'social_media', 'social_latest_news'],
  },
];

export type PricingModel = 'self-serve' | 'sales-led' | 'enterprise' | 'freemium' | 'unknown';

export type Currency = 'RUB' | 'USD' | 'EUR' | 'unknown';

export interface PriceValue {
  value: number;
  currency: Currency;
}

// Legacy 5-category shape — kept ONLY so formatExtraValue can recognise old
// result_text payloads from before the 09.06 industrial-segment rewrite and
// render them as the old comma-joined RU labels. New extractor runs produce
// string[] (top-5 concrete profession names) — see HiringResult.professions.
export interface LegacyHiringRoles {
  marketing: boolean;
  engineering: boolean;
  sales: boolean;
  design: boolean;
  product: boolean;
}

/** Full shape of the JSON we store in `website_enrichment_queue.result_text`. */
export interface ExtractedData {
  stack?: string;
  profile?: string;
  signalIds?: string[];
  method?: 'http' | 'playwright';

  customers?: string[];
  /** Сегмент клиентов компании («стоматологии», «B2B-стройка») — наполнение столбца «Клиенты». */
  client_segment?: string;
  /** Точное число (23) ИЛИ строка-оценка «N+» (20+) от LLM-счётчика. */
  cases_count?: number | string;
  case_industries?: string[];
  enterprise_logos?: boolean;

  pricing_model?: PricingModel;
  pricing_min?: PriceValue;
  free_trial?: boolean;

  /** Точное число (12) ИЛИ строка-оценка «N+» (10+) от LLM-счётчика вакансий. */
  vacancies_count?: number | string;
  /**
   * Top-up to 5 concrete profession names extracted from vacancy titles
   * ("Лифтёры, Монтажники, Диспетчеры" for МОСЛИФТ; "Разработчики,
   * Продактмены" for SaaS). Replaces the legacy 5-bool-categories shape
   * (LegacyHiringRoles) which couldn't represent blue-collar / HoReCa /
   * construction segments. formatExtraValue handles both shapes for
   * backward-compat with stored result_text from earlier jobs.
   */
  hiring_roles?: string[] | LegacyHiringRoles;

  integrations?: string[];
  founded_year?: number;
  team_size?: number;
  blog_last_post?: string;
  /** Список нормализованных URL'ов всех найденных соцсетей компании. */
  social_media?: string[];
  /**
   * LLM-выбранный «лучший» пост из соцсетей в виде готовой строки для ячейки
   * Excel — `"YYYY-MM-DD [url] — текст до 300 символов..."`. Если LLM ничего
   * не выбрал / постов нет — поле undefined и formatExtraValue даст DASH.
   * Заменил собой event_* (открытие/ребрендинг/ремонт/география).
   */
  social_latest_news?: string;
}
