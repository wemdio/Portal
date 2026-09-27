/**
 * «Наш автоаутрич» — русский сигнальный аутрич Polza. Общие типы конвейера.
 *
 * Тип цепочки система выбирает сама по главному поводу компании
 * (RU_OUTREACH_HANDOFF CEO, 23.09.2026): reactivation → hiring → ad_budget →
 * event → growth_event → icp_only. Во всех цепочках четыре письма:
 * повод → боль и что делает Polza → доказательство → мягкое закрытие.
 * Половина подходящих компаний (кроме SDR) вместо своей цепочки получает
 * оффер «Автоматизированный аутрич» — сплит 50/50 по домену (25.09.2026).
 *
 * Дизайн: docs/superpowers/specs/2026-09-23-polza-ru-outreach-chain-router-design.md.
 */

import { sanitizeLlmBudgetUsd } from '@/lib/outreachLlm/types';

export const RU_OUTREACH_PARSER_TYPE = 'polza_ru_outreach' as const;

export const CHAIN_TYPES = ['reactivation', 'hiring', 'ad_budget', 'event', 'growth_event', 'icp_only', 'automation'] as const;
export type ChainType = (typeof CHAIN_TYPES)[number];

export const CHAIN_LABELS: Record<ChainType, string> = {
  reactivation: 'Возврат (старый отказ в AMO)',
  hiring: 'Найм SDR/BDR',
  ad_budget: 'Рекламный бюджет',
  event: 'Выставка / событие',
  growth_event: 'Рост: продукт, регион, контракт, грант',
  icp_only: 'Только профиль (высокий ЦА-балл)',
  automation: 'Автоматизированный аутрич (50/50)',
};

export const LETTER_COUNT = 4;
/**
 * Версия писем строки (template_version). С 26.09.2026 письма — шаблон цепочки
 * оффера от писателя (letters/templateWriter.ts) с подставленными фактами
 * компании; прежние детерминированные цепочки (chains_v4) — только его образец.
 */
export const TEMPLATE_VERSION = 'offer_templates_v1@2026-09-26';

/** Писем в цепочке: во всех цепочках четыре, как у CEO (решение 26.09.2026). */
export function letterCountFor(_chain: ChainType): number {
  return LETTER_COUNT;
}

/**
 * Плейсхолдеры шаблона цепочки — только они меняются от компании к компании
 * (спека 2026-09-26-outreach-to-sender-design.md §4): бренд, фраза-повод из
 * проверенных фактов (openingSentence), текст утверждённого кейса, гипотеза
 * сегментов и подпись отправителя.
 */
export const TEMPLATE_PLACEHOLDERS = {
  brand: '{{бренд}}',
  opening: '{{повод}}',
  case: '{{кейс}}',
  hypothesis: '{{гипотеза}}',
  signature: '{{подпись}}',
} as const;
export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[keyof typeof TEMPLATE_PLACEHOLDERS];

/** Конец каждого письма шаблона — как у signed(): подпись подставляется целиком. */
export const TEMPLATE_SIGN_OFF = `С уважением,\n${TEMPLATE_PLACEHOLDERS.signature}`;

/**
 * Шаблон цепочки оффера в разобранном виде (в базе — polza_chain_templates.letters
 * по контракту писателя). Письмо 1 — в двух вариантах: лично ЛПР и «перешлите
 * ответственному» для общей почты; письмо 3 — с кейсом и без него (гипотеза
 * сегментов и механика). У SDR-цепочки кейса нет — нет и варианта с кейсом.
 */
export interface ChainTemplateLetters {
  subject: string;
  bodyDirect: string;
  bodyRouting: string;
  letter2: string;
  bodyWithCase: string | null;
  bodyWithoutCase: string;
  letter4: string;
}

/** Кейс по отрасли подбирается всем цепочкам, кроме SDR (router.routeCase). */
export function chainUsesCase(chain: ChainType): boolean {
  return chain !== 'hiring';
}

/**
 * Гипотеза сегментов — только у цепочек CEO: в письме 3 SDR-цепочки —
 * утверждённая фраза о ролях и процесс, у «Автоматизации» — механика формата.
 * Там её не считаем и за неё не платим.
 */
export function chainUsesHypothesis(chain: ChainType): boolean {
  return chain !== 'hiring' && chain !== 'automation';
}

/** Плейсхолдеры, которые может использовать шаблон оффера. */
export function templatePlaceholdersFor(chain: ChainType): TemplatePlaceholder[] {
  const p = TEMPLATE_PLACEHOLDERS;
  return [
    p.brand,
    p.opening,
    ...(chainUsesCase(chain) ? [p.case] : []),
    ...(chainUsesHypothesis(chain) ? [p.hypothesis] : []),
    p.signature,
  ];
}

/** Отраслевые группы роутера кейсов (таблица CEO). */
export const INDUSTRY_GROUPS = ['it_saas', 'manufacturing', 'hr_education', 'horeca', 'auto_logistics', 'digital_agency'] as const;
export type IndustryGroup = (typeof INDUSTRY_GROUPS)[number];

export const INDUSTRY_GROUP_LABELS: Record<IndustryGroup, string> = {
  it_saas: 'SaaS / IT / автоматизация',
  manufacturing: 'производство / оборудование / стройка',
  hr_education: 'HR / рекрутинг / обучение',
  horeca: 'HoReCa / локальные сети',
  auto_logistics: 'маркетплейсы / авто / логистика',
  digital_agency: 'digital / event / маркетинг / агентства',
};

export const SOURCE_CODES = [
  'hh', 'direct', 'crm', 'exhibitors', 'contracts', 'tenders', 'growth', 'site_news', 'directory',
  'gis', 'ymaps', 'revenue_growth', 'news',
] as const;
export type SourceCode = (typeof SOURCE_CODES)[number];

export const SOURCE_LABELS: Record<SourceCode, string> = {
  hh: 'hh.ru: вакансии продаж',
  direct: 'Яндекс.Директ: компании в рекламной выдаче',
  crm: 'AMO: старые отказы',
  exhibitors: 'Выставки (загруженные каталоги)',
  contracts: 'Госконтракты (загруженные выгрузки ЕИС)',
  tenders: 'Коммерческие тендеры (загруженные выгрузки)',
  growth: 'Гранты / акселераторы (загруженные списки)',
  site_news: 'Новости на сайтах компаний прошлых запусков',
  directory: 'Общая база компаний (по профилю)',
  gis: '2ГИС: несколько филиалов, отдел продаж',
  ymaps: 'Яндекс Карты: новые точки сетей',
  revenue_growth: 'Рост выручки по отчётности ФНС',
  news: 'Новости о компании (Google News)',
};

export interface RuOutreachConfig {
  sources: SourceCode[];
  /** Окно свежести сигнала, дней (дата источника, не дата загрузки). */
  freshness_days: number;
  /** Сколько ГОТОВЫХ компаний нужно (а не сколько кандидатов просмотреть). */
  limit: number;
  /** Порог скоринга 0–100: от него пишем, ниже — пропуск. Ручную проверку CEO убрал 23.09.2026. */
  write_threshold: number;
  /** Похожесть на клиента Polza по сайту, 0–10: ниже — отсев (кроме «Возврата»). */
  min_ta_score: number;
  /** Нижний порог суммы госконтракта, ₽. */
  min_contract_amount: number;
  /** Общая база: выручка, ₽, и штат. */
  min_revenue: number;
  max_revenue: number;
  min_employees: number;
  include_previously_exported: boolean;
  sender_id: string | null;
  /**
   * Лимит расхода на ИИ за запуск, $. Дошли до него — запуск завершается
   * штатно (stop_reason 'budget'), готовое остаётся.
   */
  llm_budget_usd: number;
}

/**
 * Лимит на ИИ по умолчанию и его рамки — общие с английским аутричем, живут в
 * lib/outreachLlm/types.ts (модуль без Node-зависимостей: форма запуска —
 * клиентский компонент). Здесь — прежние имена для формы и роута.
 */
export { DEFAULT_LLM_BUDGET_USD, MAX_LLM_BUDGET_USD, MIN_LLM_BUDGET_USD } from '@/lib/outreachLlm/types';

export const DEFAULT_FRESHNESS_DAYS = 45;
export const MAX_FRESHNESS_DAYS = 180;
/** Готовые компании уходят в Instantly; 500 — решение 25.09.2026. */
export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 1000;
export const DEFAULT_WRITE_THRESHOLD = 70;
export const DEFAULT_MIN_TA_SCORE = 4;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** Санитизация конфига: один код в API-роуте и в раннере. */
export function sanitizeRuOutreachConfig(raw: Partial<RuOutreachConfig>): RuOutreachConfig {
  const sources = Array.isArray(raw.sources)
    ? Array.from(new Set(raw.sources.filter((s): s is SourceCode => SOURCE_CODES.includes(s as SourceCode))))
    : [];
  const write = clampInt(raw.write_threshold, DEFAULT_WRITE_THRESHOLD, 0, 100);
  const minRevenue = clampInt(raw.min_revenue, 30_000_000, 0, 1_000_000_000_000);
  const senderId = typeof raw.sender_id === 'string' && /^[0-9a-f-]{36}$/i.test(raw.sender_id) ? raw.sender_id : null;
  return {
    sources: sources.length ? sources : ['hh', 'direct', 'crm', 'site_news'],
    freshness_days: clampInt(raw.freshness_days, DEFAULT_FRESHNESS_DAYS, 1, MAX_FRESHNESS_DAYS),
    limit: clampInt(raw.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
    write_threshold: write,
    min_ta_score: clampInt(raw.min_ta_score, DEFAULT_MIN_TA_SCORE, 0, 10),
    min_contract_amount: clampInt(raw.min_contract_amount, 1_000_000, 0, 10_000_000_000),
    min_revenue: minRevenue,
    max_revenue: Math.max(minRevenue, clampInt(raw.max_revenue, 3_000_000_000, 0, 1_000_000_000_000)),
    min_employees: clampInt(raw.min_employees, 10, 0, 100_000),
    include_previously_exported: raw.include_previously_exported === true,
    sender_id: senderId,
    llm_budget_usd: sanitizeLlmBudgetUsd(raw.llm_budget_usd),
  };
}

export type RowStatus = 'processing' | 'ready' | 'rejected' | 'manual_review' | 'failed' | 'doubtful';

/**
 * Этапы конвейера (поле pipeline_stage). Порядок = порядок воронки и порядок
 * шагов раннера: воронку (results/route.ts) считают по индексу этапа строки.
 * С 26.09.2026 почта — до разбора ИИ (дорогое в конце): компанию без рабочей
 * почты не разбираем и за неё не платим.
 */
export const STAGES = [
  'candidates_loaded',
  'amo_checked',
  'company_resolved',
  'deduplicated',
  'recipient_resolved',
  'enriched',
  'scored',
  'sequence_assembled',
  'qa_checked',
  'ready',
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  candidates_loaded: 'Кандидаты',
  amo_checked: 'Проверка AMO',
  company_resolved: 'Компания и домен',
  deduplicated: 'Без повторов',
  recipient_resolved: 'Найдена почта',
  enriched: 'Вакансии, сайт и сигналы',
  scored: 'Прошли скоринг',
  sequence_assembled: 'Цепочка собрана',
  qa_checked: 'Прошли QA',
  ready: 'Готово',
};

/** Коды отсева и ручной проверки. */
export const REASON_LABELS: Record<string, string> = {
  AMO_OPEN_DEAL: 'Открытая сделка в AMO',
  AMO_CLIENT: 'Действующий клиент',
  CRM_RECENT_CONTACT: 'Отказ в AMO меньше 30 дней назад',
  VACANCY_CLOSED: 'Вакансия закрыта',
  COMPANY_AMBIGUOUS: 'Не удалось подтвердить название компании',
  DUPLICATE_COMPANY: 'Повтор компании в запуске',
  PREVIOUSLY_EXPORTED: 'Уже выгружалась раньше',
  DOMAIN_NOT_FOUND: 'Не найден сайт компании',
  SITE_UNREACHABLE: 'Сайт компании не открылся',
  LLM_FAILED: 'ИИ не ответил (сбой модели или ключа)',
  NOT_B2B: 'Не B2B',
  EXCLUDED_CATEGORY: 'Исключённая категория (кадровое агентство, конкурент, маркетплейс)',
  NO_CHAIN: 'Нет повода и низкий ЦА-балл',
  SCORE_TOO_LOW: 'Скоринг ниже порога',
  TA_TOO_LOW: 'Мало похожа на клиента Polza (ниже ползунка)',
  SIZE_OUT_OF_RANGE: 'Размер компании вне заданных рамок',
  EMAIL_NOT_FOUND: 'Не найдена корпоративная почта',
  EMAIL_INVALID: 'Почта на сайте не прошла проверку',
  SUPPRESSED_CONTACT: 'Почта в стоп-листе',
  SENDER_MISSING: 'Нет активной подписи отправителя',
  QA_FACT_UNSUPPORTED: 'QA: неподтверждённый факт',
  QA_PLACEHOLDER_LEFT: 'QA: остались переменные',
  QA_FAILED: 'QA не пройден',
  PROCESSING_ERROR: 'Ошибка обработки',
  LIMIT_REACHED: 'Лимит готовых компаний уже набран',
};

/**
 * Признаки сомнения строки, прошедшей порог: один — «спорная», два и больше —
 * «очень спорная». EMAIL_UNVERIFIED («почта не проверена») ставится ещё на
 * шаге почты и сразу делает строку «очень спорной»: письмо на адрес, который
 * SMTP-проверка не подтвердила, может не дойти, и разбор ИИ ей не оплачиваем.
 *
 * TEMPLATE_FAILED и LETTERS_QA_FAILED ставит шаг писем: шаблон цепочки оффера
 * не прошёл проверку (или не написан) либо письма компании не прошли
 * автопроверку. Такая строка тоже очень спорная — в рассылку не идёт; по
 * TEMPLATE_FAILED «Переписать цепочку» находит строки, которые надо
 * пересобрать.
 */
export const DOUBT_CODES = [
  'EMAIL_UNVERIFIED', 'GENERIC_MAILBOX', 'NEAR_THRESHOLD', 'WEAK_SIGNAL', 'COMPANY_DOUBT', 'TEMPLATE_FAILED', 'LETTERS_QA_FAILED',
] as const;
export type DoubtCode = (typeof DOUBT_CODES)[number];

export const DOUBT_LABELS: Record<DoubtCode, string> = {
  EMAIL_UNVERIFIED: 'Почта не проверена',
  GENERIC_MAILBOX: 'Общая почта',
  NEAR_THRESHOLD: 'Оценка у порога',
  WEAK_SIGNAL: 'Слабый повод',
  COMPANY_DOUBT: 'Сомнения в компании',
  TEMPLATE_FAILED: 'Цепочка оффера не прошла проверку',
  LETTERS_QA_FAILED: 'Письма не прошли автопроверку',
};

/** С какого числа признаков строка уходит во вкладку «Очень спорные» (и писем не получает). */
export const VERY_DOUBTFUL_FROM = 2;

export type EvidenceLevel = 'A' | 'B' | 'C' | 'NONE';

export type SignalType =
  /** Строгий SDR-сигнал: роль первичного outbound + цитата холодного поиска новых B2B-клиентов. */
  | 'sales_hiring'
  /**
   * Обычная вакансия продаж (РОП, менеджер, BDM без SDR-функции). В роутинге
   * не участвует — компания идёт по остальным поводам; хранится для отчёта.
   */
  | 'sales_hiring_broad'
  | 'ad_running'
  | 'trade_show_exhibitor'
  | 'contract_won'
  | 'grant_or_accelerator'
  | 'product_launch'
  | 'new_region'
  | 'new_office'
  | 'new_production'
  | 'partner_program'
  | 'dealer_search'
  | 'export_launch'
  | 'new_case'
  | 'crm_lost'
  /** 2ГИС: на сайте есть отдел продаж / целевая вакансия. В выборе цепочки не участвует. */
  | 'sales_team'
  /** Выручка по отчётности ФНС выросла на 20% и больше. */
  | 'revenue_growth'
  /** Выигранный коммерческий тендер (загруженная выгрузка). */
  | 'tender_won'
  /** Новость об инвестициях в компанию. */
  | 'investment';

/** Один найденный факт о компании с доказательством. */
export interface Signal {
  type: SignalType;
  source: SourceCode;
  /** Должность, выставка, предмет контракта, запрос Директа, заголовок новости. */
  title: string;
  date: string | null;
  url: string | null;
  /** Дословная цитата из первоисточника (A) или пусто для структурного поля (B). */
  quote: string | null;
  level: EvidenceLevel;
  /** Доп. поля источника: заказчик контракта, даты выставки и т.п. */
  meta?: Record<string, unknown>;
}

export interface Letter {
  n: number;
  subject: string;
  body: string;
}

export interface QaResult {
  status: 'passed' | 'failed';
  flags: string[];
}
