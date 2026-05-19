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
  | 'customers'
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
  | 'blog_last_post';

export const ALL_EXTRACTOR_KEYS: ExtractorKey[] = [
  'stack',
  'profile',
  'customers',
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
];

/** Which subpages each extractor needs to be fetched. Empty = main page only. */
export const EXTRACTOR_TO_SUBPAGES: Record<ExtractorKey, SubpageKind[]> = {
  stack: [],
  profile: [],
  customers: ['cases'],
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
};

/**
 * Built-in presets the user sees as quick-start buttons. Custom user presets
 * are persisted to localStorage on top of these.
 */
export type SignalPresetId = 'basic' | 'outreach' | 'audit';

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
      'customers',
      'case_industries',
      'pricing_model',
      'hiring_roles',
      'vacancies_count',
    ],
  },
  audit: {
    id: 'audit',
    name: 'Аудит',
    description: 'Максимум сигналов: клиенты, кейсы, отрасли, цены, интеграции, найм, возраст компании.',
    extractors: [
      'stack',
      'profile',
      'customers',
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
    ],
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
    extractors: ['customers', 'cases_count', 'case_industries', 'enterprise_logos'],
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
    extractors: ['integrations', 'founded_year', 'team_size', 'blog_last_post'],
  },
];

export type PricingModel = 'self-serve' | 'sales-led' | 'enterprise' | 'freemium' | 'unknown';

export type Currency = 'RUB' | 'USD' | 'EUR' | 'unknown';

export interface PriceValue {
  value: number;
  currency: Currency;
}

export interface HiringRoles {
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
  cases_count?: number;
  case_industries?: string[];
  enterprise_logos?: boolean;

  pricing_model?: PricingModel;
  pricing_min?: PriceValue;
  free_trial?: boolean;

  vacancies_count?: number;
  hiring_roles?: HiringRoles;

  integrations?: string[];
  founded_year?: number;
  team_size?: number;
  blog_last_post?: string;
}
