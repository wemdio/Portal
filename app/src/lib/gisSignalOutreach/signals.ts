import * as cheerio from 'cheerio';
import { fetchHtmlWithRetry, discoverContactLinks } from '@/lib/enrich/websiteParser';
import { normalizeUrl } from '@/lib/enrich/urlUtils';
import { discoverSubpaths } from '@/lib/enrich/subpathDiscovery';
import { extractHiring, findExternalCareerLinks } from '@/lib/enrich/extractors/hiringExtractor';
import { detectSignals } from '@/lib/enrich/signalDetector';
import { SIGNALS_LLM_MODEL } from '@/lib/enrich/extractors/signalsModel';
import { sliceWholeChars, stripUnstorableJsonChars } from '@/lib/jsonbSafe';

/**
 * Детектор «outreach-сигналов» сайта компании для холодного пайплайна по 2GIS.
 *
 * 6 признаков входящего потока заявок: общий телефон/колл-центр (S1),
 * форма заявки (S2), отдел продаж (S3), целевые вакансии (S4), признаки
 * большого потока (S5), сеть офисов/филиалов (S6). Компания квалифицируется
 * при >=1 сигнале. Поверх — 2 скоринговых сигнала (legalRelevance,
 * crmCalltracking): гоняются для ВСЕХ сегментов ради архива и сетки, но в
 * signalsCount и порог signal_min_count НЕ входят — их использует скоринг
 * сегментов с профилем (scoring.ts, сегмент legal).
 *
 * Паттерн повторяет websiteSignalProcessor: скачиваем главную + найденные
 * подстраницы (контакты/вакансии/о компании/внешний hh.ru, всего ~5 страниц),
 * сначала прогоняем regex-эвристики, затем ОДНИМ LLM-вызовом добираем только
 * незакрытые сигналы. LLM — fail-open: её сбой не роняет строку, остаются
 * эвристические вердикты + пометка в note.
 *
 * 2GIS-поля (телефон с карточки, число филиалов сети) — вспомогательные
 * доказательства для S1/S6, когда сайт ничего не дал.
 *
 * Опционально (input.checkOnlineFormat) — седьмой, отдельный вердикт
 * onlineFormat: regex-маркеры онлайн-формата по уже скачанным страницам
 * (без доп. fetch'ей). В 6 сигналов и в signalsCount НЕ входит; нужен
 * сегментам с require_online (напр. edu — только онлайн-школы).
 */

const MAX_SUBPAGES = 4; // главная + до 4 подстраниц = ~5 страниц на компанию
const MAX_EVIDENCE = 200;
const LLM_TIMEOUT_MS = 30_000;
const LLM_PER_PAGE_CHARS = 4_000;
const LLM_TOTAL_CHARS = 16_000;

// ─── Публичные типы ──────────────────────────────────────────────────────────

export interface SignalVerdict {
  hit: boolean;
  /** Сниппет-доказательство ≤200 символов; '' когда сигнал не найден. */
  evidence: string;
}

export interface OutreachSignalSet {
  generalPhone: SignalVerdict;
  contactForm: SignalVerdict;
  salesDept: SignalVerdict;
  targetVacancy: SignalVerdict;
  highVolume: SignalVerdict;
  multiOffice: SignalVerdict;
  /** Скоринговый сигнал (legal): сайт действительно юридической тематики. */
  legalRelevance: SignalVerdict;
  /** Скоринговый сигнал (legal/accounting/consulting): CRM / коллтрекинг / речевая аналитика. */
  crmCalltracking: SignalVerdict;
  /** Скоринговый сигнал (accounting): бухуслуги / аутсорсинг учёта / налоговое сопровождение. */
  accountingRelevance: SignalVerdict;
  /** Скоринговый сигнал (consulting): управленческий/финансовый/HR/IT/операционный консалтинг. */
  consultingRelevance: SignalVerdict;
  /** Скоринговый сигнал (accounting): калькулятор стоимости, тарифы, пакеты обслуживания. */
  pricingPackages: SignalVerdict;
  /** Скоринговый сигнал (accounting): работа с несколькими сегментами — ИП, ООО, МСБ. */
  clientSegments: SignalVerdict;
}

/**
 * Ключи исходных 6 «потоковых» сигналов. signalsCount считается ТОЛЬКО по ним:
 * скоринговые сигналы (legalRelevance/crmCalltracking) гоняются для всех
 * сегментов ради архива и сетки, но НЕ должны менять поведение фильтра
 * signal_min_count сегментов без скоринг-профиля (edu/remont и т.д.).
 */
export const CORE_SIGNAL_KEYS: Array<keyof OutreachSignalSet> = [
  'generalPhone',
  'contactForm',
  'salesDept',
  'targetVacancy',
  'highVolume',
  'multiOffice',
];

export interface OutreachSignalsResult {
  signals: OutreachSignalSet;
  /** Число сработавших сигналов 0..6. */
  signalsCount: number;
  /** 'Homepage checked', 'Homepage + N subpages checked', 'Site unreachable', ... */
  note: string;
  /** Сайт был доступен и распарсен. */
  ok: boolean;
  /**
   * Признак онлайн-формата (НЕ входит в 6 сигналов и в signalsCount).
   * Считается только когда входной флаг checkOnlineFormat=true; при выключенном
   * флаге поле отсутствует — остальные вызовы не затронуты.
   */
  onlineFormat?: SignalVerdict;
}

/** Вердикты LLM по запрошенным сигналам (hit + опциональная цитата). */
export type OutreachLlmVerdicts = Partial<
  Record<keyof OutreachSignalSet, { hit: boolean; evidence?: string }>
>;

export type OutreachLlmExtractor = (input: {
  url: string;
  /** Сигналы, не закрытые эвристиками — только их просим у модели. */
  needed: Array<keyof OutreachSignalSet>;
  /** Обрезанный видимый текст главной + подстраниц. */
  pagesText: string;
}) => Promise<OutreachLlmVerdicts | null>;

export type FetchPageFn = (url: string) => Promise<{ html: string; finalUrl: string } | null>;

export interface DetectOutreachSignalsInput {
  siteUrl: string;
  /** Телефон с карточки 2GIS — вспомогательное доказательство для S1. */
  twogisPhone?: string | null;
  /** Число филиалов сети в 2GIS — вспомогательное доказательство для S6. */
  twogisBranchCount?: number | null;
  /**
   * Дополнительно определить признак онлайн-формата (regex по УЖЕ скачанным
   * страницам, без лишних fetch'ей). Результат — в result.onlineFormat.
   */
  checkOnlineFormat?: boolean;
  /** Инжектируется в тестах; по умолчанию — fetchHtmlWithRetry из websiteParser. */
  fetchPage?: FetchPageFn;
  /** Инжектируется в тестах; по умолчанию — один вызов gpt-4o-mini через Requesty. */
  llmExtract?: OutreachLlmExtractor;
}

/**
 * Маппинг сигналов на колонки таблицы: заголовок + колонка-уточнение
 * (куда пишется evidence). Заголовки — точно как в референсном CSV.
 */
export const SIGNAL_COLUMNS: Array<{ key: keyof OutreachSignalSet; title: string; clarification: string }> = [
  { key: 'generalPhone', title: 'Общий телефон / колл-центр', clarification: 'Общий телефон / колл-центр — уточнение' },
  { key: 'contactForm', title: 'Форма заявки / обратной связи', clarification: 'Форма заявки / обратной связи — уточнение' },
  { key: 'salesDept', title: 'Отдел продаж / приемная / call-центр', clarification: 'Отдел продаж / приемная / call-центр — уточнение' },
  { key: 'targetVacancy', title: 'Вакансии: менеджер продаж или оператор call-центра', clarification: 'Вакансии: менеджер продаж или оператор call-центра — уточнение' },
  { key: 'highVolume', title: 'Признак большого потока', clarification: 'Признак большого потока — уточнение' },
  { key: 'multiOffice', title: 'Несколько офисов / филиалов', clarification: 'Несколько офисов / филиалов — уточнение' },
  { key: 'legalRelevance', title: 'Юридическая релевантность сайта', clarification: 'Юридическая релевантность сайта — уточнение' },
  { key: 'crmCalltracking', title: 'CRM / коллтрекинг / речевая аналитика', clarification: 'CRM / коллтрекинг / речевая аналитика — уточнение' },
  { key: 'accountingRelevance', title: 'Бухгалтерская релевантность сайта', clarification: 'Бухгалтерская релевантность сайта — уточнение' },
  { key: 'consultingRelevance', title: 'Консалтинговая релевантность сайта', clarification: 'Консалтинговая релевантность сайта — уточнение' },
  { key: 'pricingPackages', title: 'Калькулятор / тарифы / пакеты обслуживания', clarification: 'Калькулятор / тарифы / пакеты обслуживания — уточнение' },
  { key: 'clientSegments', title: 'Работа с ИП / ООО / МСБ', clarification: 'Работа с ИП / ООО / МСБ — уточнение' },
];

// ─── Regex-банк эвристик ─────────────────────────────────────────────────────

// S1: номер 8-800 (в т.ч. +7 800) — типовой признак колл-центра.
const TOLL_FREE_RE = /(?:8|\+7)[\s(—–-]*800[\s)…—–-]*\d[\d\s()—–-]{5,}\d/;

// S1: текстовые маркеры общего/многоканального телефона.
const GENERAL_PHONE_MARKER_RES = [
  /многоканальн/i,
  /звонок\s+бесплатн/i,
  /бесплатно\s+по\s+(?:всей\s+)?россии/i,
  /звоните\s+бесплатно/i,
  /горяча[яю]\s+лини[яю]/i,
  /единый\s+(?:телефон|номер)/i,
];

// S2: категории виджетов из signalDetector — чаты, лид-формы, коллтрекинг
// (JivoSite, Verbox, Talk-Me, Calltouch, CoMagic и т.п.).
const FORM_WIDGET_CATEGORIES = new Set(['chat', 'lead_capture', 'call_tracking']);

// S2: ключевые слова внутри <form> (сама форма + плейсхолдеры/кнопки инпутов).
const FORM_CONTEXT_KEYWORDS_RE =
  /заявк|обратн(ый|ого)\s+звон|перезвон|свяжитесь|оставьте|заказ(ать|уйте)?\s+звонок|написать\s+нам/i;

// S2: CTA на кнопках/ссылках, открывающих лид-форму или попап обратного звонка.
const CTA_KEYWORDS_RE =
  /заказ(ать|уйте)?\s+звонок|обратн(ый|ого)\s+звон(ок|ка)|остав(ить|ьте)\s+заявк|перезвон(ите|им)\s+мне|написать\s+нам|свяжитесь\s+с\s+нами/i;

// S3: ЯВНОЕ упоминание отдела/центра. Голые «менеджеры» («наши менеджеры
// свяжутся с вами») сигналом НЕ являются — калибровка 03.08.2026 показала
// систематический over-fire S3 на таких фразах (в т.ч. через LLM-добор).
// Расширение 15.08.2026 (сегменты accounting/consulting): «business development»
// и «отдел по работе с обращениями» — те же по смыслу входящие/клиентские
// команды, что и «отдел продаж». Формулировки узкие и однозначные: расширение
// затрагивает и старые сегменты, поэтому голых слов («развитие», «клиенты») тут нет.
const SALES_DEPT_RE =
  /отдел\s+продаж|департамент\s+продаж|клиентский\s+отдел|отдел\s+заявок|при[её]мная\s+комисси[яию]|call[-\s]?центр|колл[-\s]?центр|контакт[-\s]?центр|intake[-\s]?(?:отдел|команда|специалист|менеджер|отдела|команды)|business\s+development|отдел\s+развития\s+бизнеса|отдел\s+по\s+работе\s+с\s+(?:обращениями|заявками)/i;

// S4: целевые роли — продажи, работа с клиентами, операторы call-центра.
// + аккаунт-менеджеры и BD-роли (ТЗ consulting 15.08.2026).
const TARGET_ROLE_RES = [
  /менеджер[а-яё]*\s+(?:по\s+продажам|отдела\s+продаж|по\s+работе\s+с\s+клиентами)/i,
  /оператор[а-яё]*\s+(?:call|колл)[-\s]?центр/i,
  /аккаунт[-\s]?менеджер/i,
  /специалист[а-яё]*\s+по\s+работе\s+с\s+клиентами/i,
  /business\s+development\s+manager|менеджер[а-яё]*\s+по\s+развитию\s+бизнеса/i,
];

// S4: на не-careers страницах роль считаем вакансией только рядом с контекстом
// найма — иначе «наш менеджер по продажам перезвонит вам» давал бы ложный хит.
const VACANCY_CONTEXT_RE = /ваканси|ищем|требуетс[яю]|открыт[аы]?\s+позици|нанимаем|присоединяйся/i;

// S5: признаки большого входящего потока.
// Числовые паттерны («более N …», «N+ …») — ТОЛЬКО с существительными бизнес-
// потока (клиенты/заявки/звонки/студенты/ученики/пациенты/обращения/
// консультации/заказы). Каталожные существительные (товаров, моделей,
// позиций, наименований, отзывов) — НЕ поток: «1300+ товаров» это склад,
// а не входящие обращения (калибровка 03.08.2026).
const HIGH_VOLUME_FLOW_NOUNS =
  '(?:клиентов|заявок|студентов|учеников|пациентов|звонков|обращений|консультаций|заказов)';
// Числовые варианты — с порогом величины ≥100 (3+ цифры): «более 5 клиентов»
// или «3+ клиентов» — не «большой поток» (ревью 04.08.2026). Пробел между
// разрядами допустим («50 000»); «более чем N» — тоже числовой вариант.
const HIGH_VOLUME_NUMBER = '(?:\\d\\s?){3,}';
const HIGH_VOLUME_RES: RegExp[] = [
  /сотни\s+(?:заявок|клиентов|звонков|студентов|учеников)/i,
  /тысячи\s+(?:заявок|клиентов|звонков|студентов|учеников)/i,
  new RegExp(`более\\s+(?:чем\\s+)?${HIGH_VOLUME_NUMBER}\\s*${HIGH_VOLUME_FLOW_NOUNS}`, 'i'),
  new RegExp(`${HIGH_VOLUME_NUMBER}\\s*\\+\\s*${HIGH_VOLUME_FLOW_NOUNS}`, 'i'),
  /консультации\s+ежедневно/i,
  // accounting/consulting (ТЗ 15.08.2026): «N компаний на обслуживании» и
  // «N кейсов» — тот же поток, но их лексика. «Проектов» НЕ берём: у ремонта и
  // мебели это портфолио, а не входящий поток.
  new RegExp(`${HIGH_VOLUME_NUMBER}\\s*\\+?\\s*(?:компани[йи]|организаци[йи])\\s+на\\s+обслуживании`, 'i'),
  new RegExp(`(?:более\\s+(?:чем\\s+)?)?${HIGH_VOLUME_NUMBER}\\s*\\+?\\s*кейс`, 'i'),
  /ежедневно\s+с\s*\d/i,
  /работаем\s+без\s+выходных/i,
  /без\s+выходных\s+и\s+праздников/i,
  /24\s*\/\s*7/,
  /круглосуточно/i,
];

// S6: адресный фрагмент («ул. Тверская, д. 1», «проспект Мира 105»).
const ADDRESS_RE =
  /(?:ул\.|улица|проспект|пр-кт|шоссе|пер\.|переулок|бульвар|набережная|площадь|проезд|тупик|аллея|микрорайон|мкр\.)\s+[А-Яа-яЁёA-Za-z0-9.,\- ]{2,60}?\d/gi;

// S6: маркеры сети — считаются только если на сайте есть хотя бы один адрес.
const MULTI_OFFICE_MARKER_RES = [
  /наши\s+(?:офисы|салоны|магазины|филиалы|адреса)/i,
  /адреса\s+(?:магазинов|салонов|офисов|филиалов|клиник|школ)/i,
  /филиалы\s+(?:в|по|на)/i,
  /наша\s+сеть/i,
  /города\s+присутствия/i,
  /офисы\s+(?:в|по)\s/i,
  // consulting (ТЗ 15.08.2026): отраслевые практики = те же «несколько
  // направлений». Как и прочие маркеры, считается только при наличии адреса
  // на сайте (см. detectMultiOffice) — голая страница «услуги» сигналом не станет.
  /отраслев(?:ые|ых)\s+практик/i,
  /наши\s+практики/i,
];

// ─── Скоринговые сигналы legal (гоняются для всех сегментов ради архива) ────

// legal_relevance: сайт юридической тематики. «регистрация ООО/ИП/предприятий»
// — только составная форма (голое «регистрация» — форма на сайте чего угодно).
const LEGAL_RELEVANCE_RES: RegExp[] = [
  /юрист/i,
  /юридическ/i,
  /адвокат/i,
  /правов/i,
  /судебн/i,
  /банкротств/i,
  /регистраци[яию]\s+(?:ооо|ип|предприяти)/i,
  /ликвидац/i,
  /патентн/i,
  /авторски[ех]\s+прав/i,
  /налоговы[ех]\s+спор/i,
  /арбитраж/i,
];

// Стоп-фразы-шаблоны: реквизитный и бессмысленный юр. булочкрож любого сайта
// («юридический адрес», «правовая информация» в подвале) — НЕ юр. тематика.
// Вырезаются из текста ДО матчинга LEGAL_RELEVANCE_RES.
export const LEGAL_NEGATIVE_RE =
  /юридическ(?:ий|ого|ему)\s+адрес[а-яё]*|юр\.?\s*адрес[а-яё]*|правов(?:ая|ой)\s+информаци[яию]|правовые\s+услови[яю]/gi;

// ─── Скоринговые сигналы accounting / consulting (ТЗ 15.08.2026) ────────────
//
// Как и legal-сигналы, гоняются для ВСЕХ сегментов (дешёвый матчинг по уже
// скачанным страницам) ради архива и сетки, но в signalsCount НЕ входят —
// фильтр edu/remont по signal_min_count от них не меняется.

// accounting_relevance: сайт реально оказывает бухуслуги. Ключевое отличие от
// «где-то упомянут бухгалтер» — составные формы: учёт, сопровождение,
// отчётность, аутсорсинг.
const ACCOUNTING_RELEVANCE_RES: RegExp[] = [
  /бухгалтерск(?:ий|ое|ие|их|ого|ому)\s+(?:уч[её]т|услуг|сопровожден|обслуживан|аутсорсинг)/i,
  /бухуч[её]т/i,
  /аутсорсинг\s+бухгалтер/i,
  /налогов(?:ое|ого|ому)\s+(?:сопровожден|консультирован|планирован)/i,
  /сдач[аеиу]\s+(?:отч[её]тности|деклараци|бухгалтерской\s+отч[её]тности)/i,
  /восстановлени[ея]\s+(?:бухгалтерского\s+)?уч[её]та/i,
  /расч[её]т\s+(?:заработной\s+платы|зарплат)/i,
  /кадров(?:ый|ое|ого)\s+(?:уч[её]т|делопроизводств)/i,
  /(?:приходящ|главн)(?:ий|его|ому)\s+бухгалтер/i,
  /нулев(?:ая|ой)\s+отч[её]тност/i,
];

// Стоп-фразы accounting: сайты бухгалтерских ПРОГРАММ и КУРСОВ — не бухуслуги.
// В 2GIS эти рубрики стоят рядом («Бухгалтерские программы» — 3784 карточки,
// «Бухгалтерские курсы» — 694), и без стоп-листа они бы прошли как релевантные.
// Вендорские формулировки идут отдельным блоком: сайт 1С-интегратора пишет
// «автоматизация бухгалтерского УЧЁТА», и без них позитивный паттерн
// «бухгалтерский учёт» пробивался бы прямо сквозь стоп-лист (проверено на
// реальных формулировках 15.08.2026). При этом «ведём бухгалтерский учёт в 1С»
// у настоящей бухфирмы обязано остаться сигналом — вырезаем только связки
// «автоматизация/внедрение/продажа», а не упоминание 1С само по себе.
export const ACCOUNTING_NEGATIVE_RE = new RegExp(
  [
    'бухгалтерск(?:ие|их|ая|ой)\\s+(?:программ[а-яё]*|курс[а-яё]*)',
    'программ[а-яё]*\\s+для\\s+бухгалтер[а-яё]*',
    'курс[а-яё]*\\s+бухгалтер[а-яё]*',
    'обучени[ея]\\s+бухгалтер[а-яё]*',
    'повышени[ея]\\s+квалификации\\s+бухгалтер[а-яё]*',
    'автоматизаци[а-яё]*\\s+бухгалтерск[а-яё]*\\s+уч[её]т[а-яё]*',
    'внедрени[ея]\\s+1с[а-яё:]*',
    '1с\\s*:\\s*бухгалтери[а-яё]*',
    'продаж[а-яё]*\\s+программ[а-яё]*',
    'программ[а-яё]*\\s+(?:для\\s+)?ведени[яе]\\s+уч[её]та',
  ].join('|'),
  'gi',
);

// consulting_relevance: консалтинговая тематика. Голое «консультация» НЕ берём —
// это CTA любого сайта («бесплатная консультация»), поэтому все паттерны
// требуют либо слова «консалтинг», либо составной формы «...консультирование».
const CONSULTING_RELEVANCE_RES: RegExp[] = [
  /консалтинг/i,
  /консалтингов(?:ая|ой|ые|ых)/i,
  /(?:бизнес|управленческ(?:ое|ого)|финансов(?:ое|ого)|стратегическ(?:ое|ого)|налогов(?:ое|ого)|кадров(?:ое|ого))[-\s]?консультирован/i,
  /оптимизаци[яию]\s+бизнес[-\s]?процессов/i,
  /постановк[аеи]\s+(?:управленческого\s+уч[её]та|бизнес[-\s]?процессов)/i,
  /due\s+diligence/i,
  /внедрени[ея]\s+(?:kpi|okr|erp|crm|системы\s+мотивации)/i,
  /аудит\s+бизнес[-\s]?процессов/i,
  /hr[-\s]?консалт|подбор\s+топ[-\s]?менеджмента/i,
  /маркетингов(?:ая|ой)\s+стратеги/i,
];

// pricing_packages: калькулятор, тарифы, пакеты обслуживания — маркер того,
// что услуга упакована и продаётся потоку, а не собирается под каждого клиента.
const PRICING_PACKAGES_RES: RegExp[] = [
  /калькулятор\s+(?:стоимости|цен|услуг|расч[её]та)/i,
  /рассчита(?:ть|йте)\s+стоимость/i,
  /тариф(?:ы|ные\s+планы|ные\s+пакеты)/i,
  /пакет[ыа]?\s+(?:услуг|обслуживания|сопровождения)/i,
  /прайс[-\s]?лист/i,
  /стоимость\s+(?:обслуживания|услуг)\s+от\s*\d/i,
  /абонентск(?:ое|ая|ого)\s+(?:обслуживание|плата|обслуживания)/i,
];

// client_segments: компания открыто работает с несколькими формами бизнеса.
// «ИП»/«ООО» — с явными кириллическими границами: \b в JS не знает кириллицы,
// а без границ «ип» ловилось бы внутри слов (см. replaceRuWord ниже).
const CLIENT_SEGMENTS_RES: RegExp[] = [
  /(^|[^а-яё])ип\s+и\s+ооо(?![а-яё])/i,
  /(^|[^а-яё])ооо\s+и\s+ип(?![а-яё])/i,
  /мал(?:ого|ый|ому)\s+и\s+средн(?:его|ий|ему)\s+бизнес/i,
  /(^|[^а-яё])(?:мсб|мсп)(?![а-яё])/i,
  /юридическ(?:их|им)\s+лиц[а-яё]*\s+и\s+(?:ип|индивидуальн)/i,
  /(?:обслуживаем|работаем\s+с|подходит\s+для)\s+(?:ип|ооо|организаци|юрлиц)/i,
  /для\s+(?:ип|ооо)\s+и\s+(?:ооо|ип)(?![а-яё])/i,
];

// crm_calltracking: виджеты этих категорий из signalDetector (Calltouch,
// CoMagic, Mango, UIS, Callibri, amoCRM, Битрикс24 и т.п.).
const CRM_WIDGET_CATEGORIES = new Set(['call_tracking', 'crm']);

// crm_calltracking: текстовые маркеры (в т.ч. когда виджет не детектится).
const CRM_CALLTRACKING_RES: RegExp[] = [
  /calltouch/i,
  /comagic/i,
  /callibri|каллибри/i,
  /mango[-\s]?(?:office|телеком)|манго[-\s]?(?:офис|телеком)/i,
  /uiscom|\buis\b/i,
  /колл?[-\s]?трекинг|call[-\s]?tracking/i,
  /amocrm|амосрм/i,
  /bitrix24|битрикс[-\s]?24/i,
  /речев(?:ая|ой)\s+аналитик/i,
  /виртуальн(?:ая|ой)\s+атс/i,
];

// ─── Онлайн-формат (опциональный чек, НЕ один из 6 сигналов) ─────────────────
//
// Канонические regex'ы — единственный источник: их же импортирует batch-скрипт
// scripts/test-gis-signals-batch.ts (стадия 1.5). Менять только синхронно.
//
// «Онлайн» само по себе слишком рыхлое («онлайн-запись» в навигации офлайн-
// школ), поэтому — только составные формы + вебинар/зум/skype. \b работает
// только для латиницы (zoom/skype), кириллица идёт без границ.
export const ONLINE_FORMAT_RE =
  /онлайн[- ]?(?:школ|курс|обучен|формат|занят|урок)|дистанцион|вебинар|\bzoom\b|skype/i;
// Стоп-фразы: кнопки записи/заявок — НЕ признак онлайн-формата обучения.
// Вырезаются из текста ДО матчинга ONLINE_FORMAT_RE.
export const ONLINE_NEGATIVE_RE =
  /онлайн[- ]?запис[а-яё]*|записаться\s+онлайн|онлайн[- ]?заявк[а-яё]*/gi;
export const ONLINE_EVIDENCE_MAX = 120;

// ─── Внутренние утилиты ──────────────────────────────────────────────────────

type PageKind = 'home' | 'contacts' | 'careers' | 'about' | 'external_careers';

interface FetchedPage {
  url: string;
  kind: PageKind;
  html: string;
  /** Видимый текст страницы (script/style/… вырезаны, пробелы схлопнуты). */
  text: string;
}

/**
 * Пустой набор вердиктов (ни один сигнал не сработал).
 *
 * ЕДИНСТВЕННОЕ место, где перечислены все ключи OutreachSignalSet. Раньше такой
 * литерал дублировался в раннере (fail-open строка), двух скриптах-калибраторах
 * и тестах — добавление сигнала ломало компиляцию в шести местах сразу
 * (ТЗ accounting/consulting, 15.08.2026). Экспортируется ради них.
 */
export function emptySignals(): OutreachSignalSet {
  const empty = (): SignalVerdict => ({ hit: false, evidence: '' });
  return {
    generalPhone: empty(),
    contactForm: empty(),
    salesDept: empty(),
    targetVacancy: empty(),
    highVolume: empty(),
    multiOffice: empty(),
    legalRelevance: empty(),
    crmCalltracking: empty(),
    accountingRelevance: empty(),
    consultingRelevance: empty(),
    pricingPackages: empty(),
    clientSegments: empty(),
  };
}

/** Видимый текст страницы для эвристик и LLM (как pageText в llmExtractor). */
function pageText(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, template, link, meta').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

/**
 * Обрезка evidence до max символов.
 *
 * ЕДИНСТВЕННАЯ точка выхода evidence — и эвристик, и LLM, — поэтому здесь же
 * стоит защита от того, что Postgres не примет в jsonb: срез посередине
 * surrogate pair (эмодзи на сайте) и одиночные суррогаты из HTML-энтити или
 * оборванного по max_tokens ответа модели. Такой символ роняет ВЕСЬ пакет
 * upsert'а архива с «invalid input syntax for type json» — инцидент 12.08.2026,
 * 2000 строк и потерянный день аутрича.
 */
function clip(value: string, max = MAX_EVIDENCE): string {
  const t = stripUnstorableJsonChars(value).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${sliceWholeChars(t, 0, max - 1).trimEnd()}…`;
}

/** Сниппет вокруг совпадения с контекстом, гарантированно ≤max символов. */
function snippetAround(text: string, index: number, matchLen: number, max = MAX_EVIDENCE): string {
  const room = Math.max(20, Math.floor((max - matchLen) / 2));
  const start = Math.max(0, index - room);
  const end = Math.min(text.length, index + matchLen + room);
  let s = sliceWholeChars(text, start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) s = `…${s}`;
  if (end < text.length) s = `${s}…`;
  return clip(s, max);
}

function findInText(text: string, res: RegExp[]): { index: number; length: number } | null {
  for (const re of res) {
    const m = text.match(re);
    if (m && typeof m.index === 'number') return { index: m.index, length: m[0].length };
  }
  return null;
}

/** Первое совпадение любого из regex'ов по видимому тексту страниц. */
function detectTextSignal(pages: FetchedPage[], res: RegExp[]): SignalVerdict {
  for (const page of pages) {
    const hit = findInText(page.text, res);
    if (hit) return { hit: true, evidence: snippetAround(page.text, hit.index, hit.length) };
  }
  return { hit: false, evidence: '' };
}

// ─── Детекторы сигналов ──────────────────────────────────────────────────────

function isTollFreePhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');
  return digits.startsWith('8800') || digits.startsWith('7800');
}

/**
 * S1: общий телефон / колл-центр. Только ТЕЛЕФОННЫЕ доказательства (ТЗ:
 * «есть общий номер телефона → колл-центр»): 8-800, маркеры многоканального/
 * бесплатного/единого номера, 8-800 с карточки 2GIS. Кнопка «Заказать звонок»
 * и колбэк-виджеты — это S2 (форма заявки), к S1 не относятся.
 */
function detectGeneralPhone(pages: FetchedPage[], twogisPhone?: string | null): SignalVerdict {
  // 1. Номер 8-800 на страницах.
  const tollFree = detectTextSignal(pages, [TOLL_FREE_RE]);
  if (tollFree.hit) return tollFree;

  // 2. Маркеры «многоканальный», «звонок бесплатный», «бесплатно по России».
  const marker = detectTextSignal(pages, GENERAL_PHONE_MARKER_RES);
  if (marker.hit) return marker;

  // 3. Вспомогательное доказательство из 2GIS: 8-800 на карточке компании.
  if (twogisPhone && isTollFreePhone(twogisPhone)) {
    return { hit: true, evidence: clip(`2GIS: ${twogisPhone} (номер 8-800)`) };
  }

  return { hit: false, evidence: '' };
}

/** Тексты всех <form>: видимый текст + плейсхолдеры/value инпутов. */
function collectFormTexts(html: string): string[] {
  const $ = cheerio.load(html);
  const texts: string[] = [];
  $('form').each((_, el) => {
    const form = $(el);
    const parts = [form.text()];
    form.find('input, textarea').each((_, inp) => {
      parts.push(String($(inp).attr('placeholder') ?? ''));
      parts.push(String($(inp).attr('value') ?? ''));
    });
    const t = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (t) texts.push(t);
  });
  return texts;
}

/** Тексты кликабельных элементов (кнопки/ссылки/сабмиты) — для CTA-детекта. */
function collectCtaTexts(html: string): string[] {
  const $ = cheerio.load(html);
  const texts: string[] = [];
  $('button, a, [role="button"], input[type="submit"], input[type="button"]').each((_, el) => {
    const t = ($(el).text() || String($(el).attr('value') ?? '')).replace(/\s+/g, ' ').trim();
    if (t && t.length <= 80) texts.push(t);
  });
  return texts;
}

/** S2: форма заявки / обратной связи / чат- или колбэк-виджет. */
function detectContactForm(pages: FetchedPage[]): SignalVerdict {
  // 1. Виджеты (JivoSite, Verbox, Talk-Me, Calltouch, CoMagic, Marquiz...).
  for (const page of pages) {
    const widgets = detectSignals(page.html)
      .filter((s) => FORM_WIDGET_CATEGORIES.has(s.category))
      .map((s) => s.name);
    if (widgets.length > 0) {
      return { hit: true, evidence: clip(`Виджеты на сайте: ${widgets.join(', ')}`) };
    }
  }

  // 2. <form> с лид-ключевыми словами.
  for (const page of pages) {
    for (const formText of collectFormTexts(page.html)) {
      const hit = findInText(formText, [FORM_CONTEXT_KEYWORDS_RE]);
      if (hit) return { hit: true, evidence: snippetAround(formText, hit.index, hit.length) };
    }
  }

  // 3. CTA-кнопка («Заказать звонок», «Оставить заявку») — открывает форму.
  for (const page of pages) {
    for (const cta of collectCtaTexts(page.html)) {
      if (CTA_KEYWORDS_RE.test(cta)) {
        return { hit: true, evidence: clip(`Кнопка: «${cta}»`) };
      }
    }
  }

  return { hit: false, evidence: '' };
}

/** S4: открытые вакансии на целевые роли. */
function detectTargetVacancy(pages: FetchedPage[]): SignalVerdict {
  // 1. Careers-страницы (и внешний hh.ru/employer): название роли = вакансия.
  for (const page of pages) {
    if (page.kind !== 'careers' && page.kind !== 'external_careers') continue;
    const hit = findInText(page.text, TARGET_ROLE_RES);
    if (hit) return { hit: true, evidence: snippetAround(page.text, hit.index, hit.length) };
  }

  // 2. Карточки вакансий из hiringExtractor (нестандартная вёрстка careers).
  for (const page of pages) {
    if (page.kind !== 'careers' && page.kind !== 'external_careers') continue;
    const hiring = extractHiring(page.html);
    for (const prof of hiring.professions) {
      if (TARGET_ROLE_RES.some((re) => re.test(prof))) {
        return { hit: true, evidence: clip(`Вакансия: ${prof}`) };
      }
    }
  }

  // 3. Прочие страницы: роль только с явным контекстом найма («ищем», «вакансия»)
  //    В ОКНЕ ±200 символов вокруг роли — иначе «Вакансии» в меню + «наш
  //    менеджер по продажам перезвонит вам» в подвале давали ложный хит.
  for (const page of pages) {
    if (page.kind === 'careers' || page.kind === 'external_careers') continue;
    const hit = findInText(page.text, TARGET_ROLE_RES);
    if (!hit) continue;
    const from = Math.max(0, hit.index - 200);
    const to = Math.min(page.text.length, hit.index + hit.length + 200);
    if (VACANCY_CONTEXT_RE.test(page.text.slice(from, to))) {
      return { hit: true, evidence: snippetAround(page.text, hit.index, hit.length) };
    }
  }

  return { hit: false, evidence: '' };
}

/**
 * Замена слова с границами по кириллице: JS `\b` НЕ работает с русскими
 * буквами (\w — только ASCII), поэтому границы задаём явно: слева не-буква
 * или начало строки, справа — не буква (negative lookahead).
 */
function replaceRuWord(s: string, pattern: string, repl: string): string {
  return s.replace(new RegExp(`(^|[^а-яё])${pattern}(?![а-яё])`, 'g'), `$1${repl}`);
}

/**
 * Нормализация УЛИЧНОЙ части адреса для дедупа: один и тот же адрес в разном
 * написании («ул. Тверская, д. 1» / «улица Тверская, дом 1» / «105120,
 * ул. Тверская, д. 1, оф. 5») обязан схлопнуться, а genuinely разные адреса —
 * остаться различимыми. Калибровка 03.08.2026: «д. 1» vs «д.1» давали ложный
 * S6. Город здесь НЕ учитывается — он часть ключа дедупа отдельно
 * (cityBeforeAddress), иначе «ул. Ленина, д.1» в Москве и Казани схлопывались.
 */
function normalizeAddress(raw: string): string {
  let s = raw.toLowerCase().replace(/ё/g, 'е');
  // Почтовый индекс адрес не различает (цифры — \w, \b здесь корректен).
  s = s.replace(/\b\d{6}\b/g, ' ');
  // Префикс «г. Город» в начале строки или после запятой.
  s = s.replace(/(^|[,;])\s*(?:г\.?|город)\s+[а-я-]+/g, '$1 ');
  s = replaceRuWord(s, 'москва', ' ');
  // Унификация сокращений к короткой форме.
  s = replaceRuWord(s, 'улица', 'ул');
  s = replaceRuWord(s, 'дом', 'д');
  s = replaceRuWord(s, 'строение', 'стр');
  s = replaceRuWord(s, 'корп(?:ус)?', 'к');
  s = replaceRuWord(s, 'офис', 'оф');
  // Пробелы вокруг пунктуации и сама пунктуация не значимы: «д. 1» = «д.1».
  s = s.replace(/[.,;]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// S6: «г. <City>» / «город <City>» перед адресом (~80 символов окна) — город
// включается в ключ дедупа. matchAll клонирует regex (lastIndex не трогаем).
const CITY_BEFORE_RE = /(?:г\.?|город)\s+([А-Яа-яЁё][А-Яа-яЁё-]*)/gi;

/** Последний («ближайший» к адресу) город в ~80 символах перед матчем адреса. */
function cityBeforeAddress(text: string, matchIndex: number): string | null {
  const window = text.slice(Math.max(0, matchIndex - 80), matchIndex);
  let city: string | null = null;
  for (const m of window.matchAll(CITY_BEFORE_RE)) city = m[1];
  return city ? city.toLowerCase().replace(/ё/g, 'е') : null;
}

/** S6: несколько офисов/филиалов. */
function detectMultiOffice(pages: FetchedPage[], twogisBranchCount?: number | null): SignalVerdict {
  // Адреса собираем со всех страниц (живут на /contacts и в подвале), в
  // evidence — оригинальное написание. Дедуп: улица+дом + ГОРОД из окна перед
  // адресом («г. Москва, ул. Ленина, д. 1» и «г. Казань, ул. Ленина, д. 1» —
  // РАЗНЫЕ адреса, ревью 04.08.2026). Адрес без города считается дублем
  // любого с той же улицей (неопределённость → схлопываем, как раньше).
  interface AddressEntry {
    street: string;
    city: string | null;
    raw: string;
  }
  const entries: AddressEntry[] = [];
  for (const page of pages) {
    for (const m of page.text.matchAll(ADDRESS_RE)) {
      const street = normalizeAddress(m[0]);
      if (!street) continue;
      const city = cityBeforeAddress(page.text, m.index ?? 0);
      const isDup = entries.some(
        (e) => e.street === street && (e.city === null || city === null || e.city === city),
      );
      if (!isDup) entries.push({ street, city, raw: m[0].trim() });
    }
  }

  if (entries.length >= 2) {
    const first = entries.slice(0, 2).map((e) => e.raw);
    return { hit: true, evidence: clip(`Адреса: ${first.join('; ')}`) };
  }

  // Маркеры сети («наши офисы», «адреса магазинов») — только вместе с адресом,
  // иначе «наша сеть партнёров» без единого адреса давала бы ложный хит.
  if (entries.length >= 1) {
    const marker = detectTextSignal(pages, MULTI_OFFICE_MARKER_RES);
    if (marker.hit) return marker;
  }

  // Вспомогательное доказательство из 2GIS: число филиалов сети.
  if (typeof twogisBranchCount === 'number' && twogisBranchCount >= 2) {
    return { hit: true, evidence: clip(`2GIS: ${twogisBranchCount} филиалов в сети`) };
  }

  return { hit: false, evidence: '' };
}

/**
 * legal_relevance: юридическая тематика сайта. Реквизитные стоп-фразы
 * («юридический адрес», «правовая информация») вырезаем ДО матчинга — иначе
 * сигнал стрелял бы на любом сайте с подвалом реквизитов.
 */
function detectLegalRelevance(pages: FetchedPage[]): SignalVerdict {
  for (const page of pages) {
    const cleaned = page.text.replace(LEGAL_NEGATIVE_RE, ' ');
    const hit = findInText(cleaned, LEGAL_RELEVANCE_RES);
    if (hit) return { hit: true, evidence: snippetAround(cleaned, hit.index, hit.length) };
  }
  return { hit: false, evidence: '' };
}

/**
 * accounting_relevance: сайт оказывает бухуслуги. Стоп-фразы («бухгалтерские
 * программы», «курсы бухгалтеров») вырезаем ДО матчинга — иначе вендоры ПО и
 * учебные центры из соседних рубрик 2GIS проходили бы как релевантные.
 */
function detectAccountingRelevance(pages: FetchedPage[]): SignalVerdict {
  for (const page of pages) {
    const cleaned = page.text.replace(ACCOUNTING_NEGATIVE_RE, ' ');
    const hit = findInText(cleaned, ACCOUNTING_RELEVANCE_RES);
    if (hit) return { hit: true, evidence: snippetAround(cleaned, hit.index, hit.length) };
  }
  return { hit: false, evidence: '' };
}

/** consulting_relevance: консалтинговая тематика (без голого «консультация»). */
function detectConsultingRelevance(pages: FetchedPage[]): SignalVerdict {
  return detectTextSignal(pages, CONSULTING_RELEVANCE_RES);
}

/** pricing_packages: калькулятор стоимости / тарифы / пакеты обслуживания. */
function detectPricingPackages(pages: FetchedPage[]): SignalVerdict {
  return detectTextSignal(pages, PRICING_PACKAGES_RES);
}

/** client_segments: работа с несколькими формами бизнеса (ИП, ООО, МСБ). */
function detectClientSegments(pages: FetchedPage[]): SignalVerdict {
  return detectTextSignal(pages, CLIENT_SEGMENTS_RES);
}

/** crm_calltracking: CRM/коллтрекинг — виджеты (script-разметка) + текст. */
function detectCrmCalltracking(pages: FetchedPage[]): SignalVerdict {
  // 1. Виджеты коллтрекинга/CRM из signalDetector (Calltouch, CoMagic, Mango,
  //    UIS, Callibri, amoCRM, Битрикс24...). Скрипты в видимый текст не попадают,
  //    поэтому без widget-проверки скрипт-only внедрения были бы невидимы.
  for (const page of pages) {
    const widgets = detectSignals(page.html)
      .filter((s) => CRM_WIDGET_CATEGORIES.has(s.category))
      .map((s) => s.name);
    if (widgets.length > 0) {
      return { hit: true, evidence: clip(`Виджеты на сайте: ${widgets.join(', ')}`) };
    }
  }

  // 2. Текстовые маркеры («коллтрекинг», «речевая аналитика», «виртуальная АТС»).
  return detectTextSignal(pages, CRM_CALLTRACKING_RES);
}

/**
 * Признак онлайн-формата по УЖЕ скачанным страницам (без доп. fetch'ей).
 * Стоп-фразы («онлайн-запись», «записаться онлайн», «онлайн-заявка») вырезаем
 * из текста ДО матчинга — это booking-CTA офлайн-бизнесов, а не формат обучения.
 * Evidence — сниппет ≤ONLINE_EVIDENCE_MAX символов вокруг первого совпадения.
 */
function detectOnlineFormat(pages: FetchedPage[]): SignalVerdict {
  for (const page of pages) {
    const cleaned = page.text.replace(ONLINE_NEGATIVE_RE, ' ');
    const hit = findInText(cleaned, [ONLINE_FORMAT_RE]);
    if (hit) {
      return { hit: true, evidence: snippetAround(cleaned, hit.index, hit.length, ONLINE_EVIDENCE_MAX) };
    }
  }
  return { hit: false, evidence: '' };
}

// ─── LLM-добор (один вызов на все незакрытые сигналы) ────────────────────────

const LLM_SYSTEM_PROMPT = `Ты — детектор признаков входящего потока заявок на сайте компании (B2B, РФ). По тексту страниц сайта определи наличие каждого из 12 сигналов. Извлекай ТОЛЬКО то, что явно указано. Не додумывай.

Верни JSON (и только JSON, без markdown):
{
  "generalPhone": {"hit": true|false, "evidence": "короткая цитата со страницы или ''"},
  "contactForm": {"hit": true|false, "evidence": "..."},
  "salesDept": {"hit": true|false, "evidence": "..."},
  "targetVacancy": {"hit": true|false, "evidence": "..."},
  "highVolume": {"hit": true|false, "evidence": "..."},
  "multiOffice": {"hit": true|false, "evidence": "..."},
  "legalRelevance": {"hit": true|false, "evidence": "..."},
  "crmCalltracking": {"hit": true|false, "evidence": "..."},
  "accountingRelevance": {"hit": true|false, "evidence": "..."},
  "consultingRelevance": {"hit": true|false, "evidence": "..."},
  "pricingPackages": {"hit": true|false, "evidence": "..."},
  "clientSegments": {"hit": true|false, "evidence": "..."}
}

Определения сигналов:
- generalPhone: общий телефон / колл-центр — ТОЛЬКО телефонные доказательства: номер 8-800, «многоканальный телефон», «звонок бесплатный», «бесплатно по России», «горячая линия», «единый номер». Кнопка или виджет обратного звонка («Заказать звонок», «перезвоните мне») БЕЗ общего номера телефона — НЕ сигнал generalPhone (это contactForm).
- contactForm: форма заявки/обратной связи, кнопка «Оставить заявку»/«Заказать звонок», онлайн-чат с оператором.
- salesDept: ЯВНОЕ упоминание отдела продаж, приёмной комиссии, call-центра/колл-центра/контакт-центра, клиентского отдела, отдела заявок, intake-отдела/команды. НЕ считай сигналом простое упоминание менеджеров или специалистов («наши менеджеры свяжутся с вами», «цены уточняйте у менеджеров», «менеджер по продажам» как должность) — без явного отдела/центра это не отдел продаж.
- targetVacancy: открытая вакансия менеджера по продажам, менеджера по работе с клиентами, оператора call-центра.
- highVolume: признаки большого ВХОДЯЩЕГО ПОТОКА обращений. Доказательства — только объём клиентского потока: «сотни/тысячи заявок (в день/в месяц)», «более N клиентов/заявок/студентов/учеников/пациентов/звонков/обращений/консультаций/заказов», «консультации ежедневно»; а также режим работы: «работаем без выходных», «24/7», «круглосуточно», «ежедневно». НЕ является доказательством каталожный/товарный объём и репутационные числа: «1300+ товаров», «более 5000 моделей», «200+ позиций/наименований», «10000 отзывов» — это склад/каталог/отзывы, а не поток обращений.
- multiOffice: ДВА И БОЛЕЕ РАЗНЫХ физических адреса или филиала: список адресов, «наши офисы/салоны/магазины/филиалы» в нескольких локациях или городах. Один адрес, один офис/салон/магазин — НЕ сигнал. Общие фразы без перечисленных локаций («работаем по всей России», «доставка по всей стране», «дилеры в регионах») — НЕ сигнал.
- legalRelevance: сайт ЯВНО юридической тематики — юридические услуги, адвокаты/юристы, правовая помощь, судебные споры, банкротство, регистрация/ликвидация ООО или ИП, патентные услуги, защита авторских прав, налоговые споры, арбитраж. Реквизитные формулировки любого сайта («юридический адрес», «правовая информация», «политика конфиденциальности») — НЕ сигнал.
- crmCalltracking: на сайте явно используются CRM, коллтрекинг или речевая аналитика: Calltouch, CoMagic, Callibri, Mango Office, UIS, amoCRM, Битрикс24, упоминания «коллтрекинг», «речевая аналитика», «виртуальная АТС».
- accountingRelevance: компания ОКАЗЫВАЕТ бухгалтерские услуги — бухгалтерский учёт, бухгалтерское сопровождение/обслуживание, аутсорсинг бухгалтерии, налоговое сопровождение, сдача отчётности, расчёт зарплаты, кадровый учёт, приходящий/главный бухгалтер. НЕ сигнал: продажа бухгалтерских ПРОГРАММ (1С и т.п.), курсы и обучение бухгалтеров, вакансия бухгалтера на сайте компании из другой отрасли.
- consultingRelevance: компания ОКАЗЫВАЕТ консалтинговые услуги — управленческий, финансовый, HR, маркетинговый, IT- или операционный консалтинг, бизнес-консультирование, оптимизация бизнес-процессов, стратегия, due diligence. НЕ сигнал: слово «консультация» как CTA («бесплатная консультация», «получить консультацию специалиста») на сайте любой другой отрасли.
- pricingPackages: на сайте есть калькулятор стоимости, «рассчитать стоимость», тарифы/тарифные планы, пакеты услуг или обслуживания, прайс-лист, абонентское обслуживание. Одна цифра цены без пакета/тарифа/калькулятора — НЕ сигнал.
- clientSegments: компания явно обслуживает НЕСКОЛЬКО форм бизнеса — «для ИП и ООО», «юрлицам и ИП», «малый и средний бизнес», МСБ/МСП. Упоминание собственной формы в реквизитах («ООО «Ромашка»») — НЕ сигнал.

Правила: hit=true только если сигнал ЯВНО есть на страницах; evidence — короткая цитата с сайта (до 200 символов); если сигнала нет — hit=false и evidence="".`;

function getLlmApiKey(): string {
  return (
    (process.env.OPENROUTER_SIGNALS_API_KEY ?? '').trim() ||
    (process.env.OPENROUTER_BRIEF_API_KEY ?? '').trim()
  );
}

/**
 * Дефолтный LLM-экстрактор — тот же паттерн, что llmExtractor: один запрос
 * к Requesty-роутеру с моделью из signalsModel. Ошибки (сеть, HTTP, JSON)
 * пробрасываются наверх — оркестратор отработает fail-open и пометит note.
 * «Нет ключа / нечего проверять» — не ошибка, возвращаем null молча.
 */
const defaultLlmExtract: OutreachLlmExtractor = async ({ url, needed, pagesText }) => {
  const apiKey = getLlmApiKey();
  if (!apiKey || needed.length === 0 || pagesText.length < 50) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://portal.app',
        'X-Title': 'Portal - GIS Outreach Signals',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: SIGNALS_LLM_MODEL,
        messages: [
          { role: 'system', content: LLM_SYSTEM_PROMPT },
          { role: 'user', content: `Сайт: ${url}\nПроверь сигналы: ${needed.join(', ')}\n\nТекст страниц:\n${pagesText}` },
        ],
        temperature: 0,
        max_tokens: 600,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) throw new Error(`LLM router HTTP ${res.status}`);

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) return null;

    const parsed = JSON.parse(content) as Record<string, unknown>;
    const out: OutreachLlmVerdicts = {};
    for (const key of needed) {
      const v = parsed[key];
      if (!v || typeof v !== 'object') continue;
      const rec = v as Record<string, unknown>;
      if (typeof rec.hit !== 'boolean') continue;
      out[key] = { hit: rec.hit, evidence: typeof rec.evidence === 'string' ? clip(rec.evidence) : '' };
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
};

// ─── Скачивание страниц ──────────────────────────────────────────────────────

const defaultFetchPage: FetchPageFn = async (url) => {
  try {
    const res = await fetchHtmlWithRetry(url, { allowHttpErrors: false });
    if (res && res.status >= 200 && res.status < 300 && res.html) {
      return { html: res.html, finalUrl: url };
    }
  } catch {
    /* страница недоступна — по ней просто нет сигналов */
  }
  return null;
};

/**
 * Варианты URL главной, как buildFetchFallbacks в websiteSignalProcessor:
 * apex → www → http → http+www. У ~40% RU SMB DNS живёт только на www
 * или только на plain http — дешёвые доп. попытки до признания сайта мёртвым.
 */
function buildHomepageVariants(normalized: string): string[] {
  const variants: string[] = [normalized];
  try {
    const u = new URL(normalized);
    const hasWww = /^www\./i.test(u.hostname);
    const altHost = hasWww ? u.hostname.replace(/^www\./i, '') : `www.${u.hostname}`;
    const altUrl = `${u.protocol}//${altHost}${u.pathname}${u.search}`;
    if (altUrl !== normalized) variants.push(altUrl);
    if (u.protocol === 'https:') {
      variants.push(`http://${u.hostname}${u.pathname}${u.search}`);
      variants.push(`http://${altHost}${u.pathname}${u.search}`);
    }
  } catch {
    /* невалидный URL — вернём как есть */
  }
  return Array.from(new Set(variants));
}

/**
 * Кандидаты подстраниц из главной: контакты, вакансии, о компании (по ссылкам
 * через discoverContactLinks/discoverSubpaths) + внешний hh.ru/employer.
 * Порядок = приоритет: телефоны/адреса чаще всего на контактах.
 */
function buildSubpageCandidates(homeHtml: string, homeUrl: string): Array<{ url: string; kind: PageKind }> {
  const out: Array<{ url: string; kind: PageKind }> = [];
  const seen = new Set<string>();
  const normalize = (u: string) => u.replace(/[#?].*$/, '').replace(/\/+$/, '');
  const homeNorm = normalize(homeUrl);

  const push = (url: string | undefined, kind: PageKind) => {
    if (!url) return;
    const norm = normalize(url);
    if (!norm || norm === homeNorm || seen.has(norm)) return;
    seen.add(norm);
    out.push({ url, kind });
  };

  push(discoverContactLinks(homeHtml, homeUrl)[0], 'contacts');
  const discovered = discoverSubpaths(homeHtml, homeUrl, ['careers', 'about']);
  push(discovered.careers, 'careers');
  push(discovered.about, 'about');
  push(findExternalCareerLinks(homeHtml)[0], 'external_careers');
  return out;
}

function buildLlmPagesText(pages: FetchedPage[]): string {
  const parts = pages.map((p) => `[${p.kind.toUpperCase()}]\n${p.text.slice(0, LLM_PER_PAGE_CHARS)}`);
  return parts.join('\n\n').slice(0, LLM_TOTAL_CHARS);
}

// ─── Оркестратор ─────────────────────────────────────────────────────────────

export async function detectOutreachSignals(
  input: DetectOutreachSignalsInput,
): Promise<OutreachSignalsResult> {
  const fetchPage = input.fetchPage ?? defaultFetchPage;
  const llmExtract = input.llmExtract ?? defaultLlmExtract;

  let normalized: string;
  try {
    normalized = normalizeUrl(input.siteUrl);
  } catch {
    return { signals: emptySignals(), signalsCount: 0, note: 'Invalid URL', ok: false };
  }

  // 1. Главная страница (apex → www → http-варианты).
  let home: { html: string; finalUrl: string } | null = null;
  for (const variant of buildHomepageVariants(normalized)) {
    try {
      const res = await fetchPage(variant);
      if (res?.html) {
        home = res;
        break;
      }
    } catch {
      /* вариант недоступен — пробуем следующий */
    }
  }
  if (!home?.html) {
    return { signals: emptySignals(), signalsCount: 0, note: 'Site unreachable', ok: false };
  }

  const pages: FetchedPage[] = [
    { url: home.finalUrl, kind: 'home', html: home.html, text: pageText(home.html) },
  ];

  // 2. Подстраницы (потолок MAX_SUBPAGES; сбой одной не роняет остальные).
  const candidates = buildSubpageCandidates(home.html, home.finalUrl).slice(0, MAX_SUBPAGES);
  const fetched = await Promise.all(
    candidates.map(async (cand): Promise<FetchedPage | null> => {
      try {
        const res = await fetchPage(cand.url);
        if (!res?.html) return null;
        return { url: res.finalUrl, kind: cand.kind, html: res.html, text: pageText(res.html) };
      } catch {
        return null;
      }
    }),
  );
  let subpageCount = 0;
  for (const page of fetched) {
    if (page) {
      pages.push(page);
      subpageCount += 1;
    }
  }

  let note = subpageCount === 0 ? 'Homepage checked' : `Homepage + ${subpageCount} subpages checked`;

  // 3. Эвристики по всем скачанным страницам.
  const signals: OutreachSignalSet = {
    generalPhone: detectGeneralPhone(pages, input.twogisPhone),
    contactForm: detectContactForm(pages),
    salesDept: detectTextSignal(pages, [SALES_DEPT_RE]),
    targetVacancy: detectTargetVacancy(pages),
    highVolume: detectTextSignal(pages, HIGH_VOLUME_RES),
    multiOffice: detectMultiOffice(pages, input.twogisBranchCount),
    legalRelevance: detectLegalRelevance(pages),
    crmCalltracking: detectCrmCalltracking(pages),
    accountingRelevance: detectAccountingRelevance(pages),
    consultingRelevance: detectConsultingRelevance(pages),
    pricingPackages: detectPricingPackages(pages),
    clientSegments: detectClientSegments(pages),
  };

  // 4. ОДИН LLM-вызов на сигналы, которые эвристики не закрыли.
  //    Fail-open: сбой LLM оставляет эвристические вердикты.
  const unresolved = (Object.keys(signals) as Array<keyof OutreachSignalSet>).filter(
    (key) => !signals[key].hit,
  );
  if (unresolved.length > 0) {
    try {
      const llm = await llmExtract({
        url: home.finalUrl,
        needed: unresolved,
        pagesText: buildLlmPagesText(pages),
      });
      if (llm) {
        for (const key of unresolved) {
          const verdict = llm[key];
          if (verdict && verdict.hit === true) {
            signals[key] = { hit: true, evidence: clip(verdict.evidence ?? '') };
          }
        }
      }
    } catch {
      note += '; LLM fallback failed, heuristic verdicts kept';
    }
  }

  const signalsCount = CORE_SIGNAL_KEYS.filter((key) => signals[key].hit).length;
  const result: OutreachSignalsResult = { signals, signalsCount, note, ok: true };
  // Опциональный чек онлайн-формата — только по уже скачанным страницам.
  if (input.checkOnlineFormat === true) {
    result.onlineFormat = detectOnlineFormat(pages);
  }
  return result;
}
