import { markAutomatedConstructor } from '@/lib/tools/baseConstructorQueue';
/**
 * Стадия base_collect: авто-сборка базы под вертикаль (he_bases source='auto').
 *
 * Оркестратор над существующими коллекторами — своих парсеров у стадии нет.
 * Всё состояние живёт в he_bases.collect_info, поэтому джоба безопасно
 * перевызывается: пока дочерние парсеры работают, стадия делает self-requeue
 * (своя he_jobs-строка → status='pending' БЕЗ инкремента attempts) и воркер
 * клеймит её после 30-секундной паузы (run_after).
 *
 * Фазы:
 *  1. PLAN — один LLM-вызов (модель bulk): вертикаль + неотклонённые гипотезы
 *     + типы компаний из вокабуляра → план задач (промпт/схема — контракт
 *     prompts/sourcePlan.ts + HeSourcePlanSchema). Непустой hypothesis_ids в
 *     payload джобы (выбор гипотез в UI) сужает набор до выбранных id;
 *     пустое пересечение с неотклонёнными — фейл джобы. План и статусы задач
 *     пишутся в collect_info.
 *     При market='us' промпт — EN (prompts/sourcePlan.en.ts) с ENG-источниками
 *     (pdl / funded / eng_hiring / google_maps); схема плана общая. И там же
 *     вызова может не быть вовсе: если вход планировщика (имя и описание
 *     вертикали, отобранные гипотезы, вокабуляр, рынок) совпал с сохранённым в
 *     he_catalog_cursors, план берётся оттуда — вместе с пробой среза это весь
 *     платёж фазы. Иначе каждая ночь добора платила бы за план заново, и её
 *     закладки каталога не совпадали бы с прошлыми ни разу (ключ закладки —
 *     хеш фильтров, а фильтры приходят из плана).
 *  2. DISPATCH — каждая pending-задача уходит в свой коллектор:
 *     companies_directory — синхронно через searchRows с пагинацией страницами
 *     по 1000 (строки сразу в задаче, дочерней джобы нет; кап — limit из
 *     payload джобы, см. totalRowsCap; компании других баз проекта
 *     пропускаются ещё на выборке — см. блок про продолжение ниже);
 *     pdl / funded / eng_hiring (market='us') — тоже синхронно: прямое чтение
 *     справочных таблиц pdl_companies / funded_companies / eng_hiring_cache
 *     через ctx.supabase, дочерних джоб нет. Пагинация keyset: у pdl по id
 *     (одноразовый bulk-дамп), у funded и eng_hiring по ВРЕМЕНИ ВСТАВКИ —
 *     живой фид, а их id с порядком вставки не связан, и закладка по id
 *     отправила бы за курсор ровно свежие строки. Компании других баз проекта
 *     исключаются ещё НА ВЫБОРКЕ (как у реестра), место разбора среза живёт в
 *     he_catalog_cursors — см. блок «ЧТЕНИЕ КАТАЛОГА С ЗАКЛАДКОЙ»;
 *     hh_live / yandex_maps / google_maps — insert дочерней джобы
 *     (parser_jobs / yandex_maps_jobs / google_maps_jobs), её id — в
 *     child_job_id. У google_maps language/region — по рынку проекта
 *     (us → en/US). collect_info персистится после каждой задачи.
 *  3. WAIT — опрос дочерних джоб по статусу. Есть незавершённые →
 *     self-requeue и выход с {waiting: true}.
 *  4. HARVEST — строки всех done-задач мёржатся в унифицированные колонки
 *     round-robin'ом (по одной строке из каждой задачи по кругу — иначе реестр,
 *     диспатчущийся первым, съедал весь кап, а строки hh/карт молча отрезались),
 *     дедуп по нормализованному ключу (компания — без юрформ и кавычек, сайт —
 *     хост без www/пути), исключение компаний из ДРУГИХ he_bases того же
 *     проекта (иначе одна компания копилась в нескольких базах проекта через
 *     повторные сборки; для строк hh/карт это единственная точка исключения,
 *     для реестра — страховка после исключения на выборке), кап
 *     totalRowsCap(job) — limit из payload джобы
 *     (дефолт 10000). Ноль строк — база failed с разбором по задачам,
 *     джоба падает. Упавшие задачи фиксируются в collect_info, но не валят
 *     джобу, если хотя бы одна задача дала строки.
 *  5. CONSTRUCT — обогащение собранных строк конструктором баз
 *     (base_constructor_jobs; locale И СПИСОК ШАГОВ — по рынку проекта, см.
 *     constructStepsFor: RU — dedup_email → find_emails → validate_emails →
 *     cap_emails_per_company → enrich_descriptions, как было; ENG (market='us')
 *     — find_emails → enrich_descriptions → split_emails → dedup_email →
 *     validate_emails → cap_emails_per_company, то есть ОДИН АДРЕС НА СТРОКУ
 *     со своим вердиктом и работающий кап «до N адресов на компанию»).
 *     Шаг find_emails попадает в список только для бедных баз (email есть у
 *     ≤50% строк); сама фаза пропускается лишь когда завершалась ранее
 *     (construct.status='done' в collect_info) или строк нет вовсе.
 *     DISPATCH-CONSTRUCT создаёт BC-джобу (bc_job_id — в collect_info.construct)
 *     и уходит в self-requeue с паузой 60с; WAIT-CONSTRUCT опрашивает её до
 *     терминального статуса (таймаут 6ч → база failed); IMPORT мапит сетку
 *     обратно в унифицированные колонки по имени заголовка (email — первый
 *     адрес ячейки: в ENG-сетке он там один, в RU-сетке ячейка может быть
 *     склеенной) и добавляет колонку description В КОНЕЦ заголовков.
 *     ENG-джоба БЕЗ шага split_emails не импортируется вовсе (её вердикты
 *     валидации не поадресные) — база один раз пересобирается по текущему
 *     контракту.
 *     failed/cancelled BC-джоба базу НЕ валит: импортируется частичный data,
 *     если он есть, иначе переход к analyzing без обогащения.
 *     На импортированную сетку заново накладываются ОБА числа клиента
 *     (capImportedRows): «до N адресов на компанию» и лимит сборки как кап
 *     КОМПАНИЙ. Кап конструктора живёт в чужом процессе и у оборвавшейся
 *     джобы мог не выполниться, поэтому limit — это и до, и после
 *     конструктора «сколько компаний», а не «сколько строк»: строк у базы
 *     после разноса адресов больше, и что именно срезано, видно в
 *     stats.dropped_over_contact_cap / dropped_over_company_cap. Далее —
 *     he_bases → status='analyzing' и ставится стадия base_analyze.
 *     Пара «статус + джоба анализа» — два запроса в две таблицы, транзакции у
 *     PostgREST нет, поэтому пару закрывает ПОВТОР этой же джобы: база в
 *     'analyzing' с непустыми row_count/columns ловится в start-guard и
 *     доводится до base_analyze бесплатно (ensureBaseAnalyzeJob, дедуп по
 *     активной джобе анализа этой базы). Сама запись базы при блипе БД
 *     повторяется на месте (HARVEST_WRITE_ATTEMPTS) — повторять стадию, за
 *     которую уже заплачено, из-за 503 шлюза нельзя.
 *
 * Refill-режим (ENG auto-pipeline, payload.refill=true; постановка — крон
 * app/worker/heAutoPipelineCron.ts через enqueueHeBaseCollect): PLAN →
 * DISPATCH → WAIT → HARVEST → CONSTRUCT идут как обычно, но вместо финала
 * «analyzing + base_analyze» собранные строки доливаются лидами в уже
 * запущенную кампанию Instantly, база уходит в терминальный 'analyzed',
 * итог пишется в collect_info.refill_result и he_auto_pipeline_runs.
 * Пустой harvest — штатный 'no_new' (база НЕ failed). Вся механика —
 * stages/baseCollectRefill.ts. Объём такой сборки считается ИЗ дневного капа
 * лидов проекта (resolveHeRefillCollectCompanies, ниже «РАЗМЕР REFILL-СБОРКИ»),
 * а не флэтовым числом: иначе краул сайта и SMTP-проба оплачивались бы по
 * компаниям, чьи адреса кап того же вечера выбросит, а сами компании оставались
 * бы выжженными для будущих сборок проекта.
 *
 * Продолжение сбора больших сегментов (>50k — больше одного капа limit):
 * повторная сборка той же вертикали исключает компании других he_bases
 * проекта ещё НА ВЫБОРКЕ реестра (fetchDirectoryRows листает дальше, пока не
 * наберёт limit НОВЫХ строк или не кончится выдача; потолок 200 страниц —
 * предохранитель), а не только на финальном мёрдже. Иначе вторая сборка
 * заново скачивала те же первые N строк реестра и отбрасывала их как
 * известные — ~0 новых строк, и сегмент в 120k нельзя было собрать батчами.
 * Исчерпанный реестр помечается в collect_info («реестр исчерпан»); если все
 * задачи исчерпаны/пусты, ни одна не упала и новых строк нет — сборка падает
 * с «сегмент исчерпан: новых компаний нет» вместо общего нулевого фейла.
 * Стоп по потолку 200 страниц — НЕ исчерпание: задача получает note про
 * предел сканирования, и «сегмент исчерпан» на такой задаче не срабатывает.
 * ТО ЖЕ САМОЕ у ENG-каталогов (market='us'), и для ночного добора это не
 * оптимизация, а условие работы: каждая ночь заводит новую базу с пустым
 * collect_info, поэтому без закладки вне базы она читала бы срез с первой
 * строки и получала ноль новых компаний. Закладка и переиспользуемый план
 * живут в he_catalog_cursors — см. блок «ЧТЕНИЕ КАТАЛОГА С ЗАКЛАДКОЙ».
 * У hh/карт
 * исключение остаётся только на мёрдже: продолжение для них требует
 * вариации поисковых запросов — future work.
 */

import type { CompaniesSearchFilters } from '@/app/api/client/companies-search/route';
// «Блип БД или приговор» — нейтральный предикат (lib/db/transientError.ts, без
// импортов), общий с конструктором баз и воркером движка. Нужен ровно в одном
// месте стадии: у финальной записи базы, повтор которой бесплатен, а повтор
// стадии — нет.
import { isTransientDbError } from '@/lib/db/transientError';
import { searchRows } from '@/lib/companiesSearch/rpcSearch';
import { applyFundedFilters } from '@/lib/funded/queryFilters';
import { buildRolesRegex } from '@/lib/parsers/atsFilters';
import { domainToSiteUrl, resolveCompanyDomainViaPdl } from '@/lib/parsers/companyDomainResolver';
import { extractEmail } from '@/lib/tools/dfybUtils';
import { normalizeLeadWebsite } from '@/lib/instantly/leadContactValues';
import {
  HE_MAX_EMAILS_PER_COMPANY_DEFAULT,
  normalizeHeMaxEmailsPerCompany,
} from '../baseCollectEnqueue';
// Закладка каталога и переиспользуемый план (только market='us'): стор ВНЕ
// he_bases, потому что каждый ночной добор создаёт новую базу с пустым
// collect_info — см. шапку catalogCursor.ts.
import {
  heCatalogPlanKey,
  heCatalogSliceKey,
  isHeCatalogSource,
  heWidenOnCooldown,
  loadHeCatalogCursor,
  rememberHeCatalogWidenFailure,
  sameBookmark,
  saveHeCatalogCursor,
  usableBookmark,
  type HeCatalogBookmark,
  type HeCatalogCursorRow,
  type HeCatalogSlot,
  type HeCatalogSource,
} from '../catalogCursor';
// Только константа потолка запуска: модуль чистый (типы + маппинг лидов), в
// стадию он не тащит ни БД, ни рассыльщика. Нужна, чтобы назвать вслух базу, у
// которой адресов больше потолка запуска, — см. предупреждение в финале стадии.
import { HE_LAUNCH_MAX_LEADS } from '../launchHandoff';
import { callLLMWithSchema, getHeModel } from '../llm';
import { projectMarket, type HeMarket } from '../market';
import { findIrrelevantRows, findOffTargetRows, heOffTargetMarkersFor } from '../relevanceGate';
import {
  probeSliceRelevance,
  sliceProbeRejectBelow,
  sliceProbeRepairBelow,
  sliceProbeSample,
} from '../sliceProbe';
import {
  buildSourcePlanMessages,
  type HeCollectTask,
  type HeSourcePlan,
  type SourcePlanPromptInput,
} from '../prompts/sourcePlan';
import {
  buildCatalogRepairMessagesEn,
  buildCatalogWidenMessagesEn,
  buildSourcePlanMessagesEn,
  type HeTriedSlice,
} from '../prompts/sourcePlan.en';
import {
  HE_FUNDED_SCOPE_FILTER_KEYS,
  HE_FUNDED_SIZE_FILTER_KEYS,
  HE_PDL_SCOPE_FILTER_KEYS,
  HE_PDL_SIZE_FILTER_KEYS,
  HeCatalogRepairSchema,
  HeSourcePlanSchema,
} from '../schemas';
// Клиент для записи ЧЕКПОЙНТА ОПЛАТЫ — без сигнала джобы (см. paidCheckpointDb
// ниже). Ни одно чтение стадии через него не идёт.
import { heCheckpointSupabase } from '../stageDb';
import type { HeBase, HeJob, HeProject, HeVertical } from '../types';
import {
  completeHeRefillNoNew,
  resolveHeRefillCollectCompanies,
  runHeRefillAppend,
  type HeRefillResult,
} from './baseCollectRefill';
import {
  addUsage,
  newUsage,
  payloadString,
  readProject,
  stageLog,
  type HeStageContext,
  type HeStageResult,
  type HeUsage,
} from './shared';

/**
 * Лимит строк авто-сборки выбирает пользователь (route кладёт его в payload
 * джобы как `limit`, UI предлагает 2000 / 10000 / 50000). Кап — не бизнес-
 * правило, а практический предохранитель: строки живут в he_bases.data jsonb,
 * и «собирайте сколько есть» без капа раздувает строку БД и замедляет сборку.
 * На больших ОКВЭД вроде 62 фиксированный кап 2000 обрезал сегмент до малой
 * доли реестра — поэтому выбор отдан пользователю.
 */
/** Лимит строк по умолчанию, когда в payload джобы limit не задан. */
const DEFAULT_ROWS_LIMIT = 10000;
/** Границы, в которые клампится limit из payload (мусор в payload ≠ 400 route). */
const MIN_ROWS_LIMIT = 100;
const MAX_ROWS_LIMIT = 50000;
/** Размер страницы при пагинации searchRows (лимит 50000 просто листает дальше). */
const DIRECTORY_PAGE_SIZE = 1000;
/**
 * Потолок страниц реестра за одну задачу (200 × 1000 = 200k просканированных
 * строк) — предохранитель от бесконечного листания, когда почти вся выдача
 * пропускается как уже собранная в других базах проекта.
 */
const MAX_DIRECTORY_PAGES = 200;
/** Строк в he_bases.sample_rows — как у ручной загрузки. */
export const SAMPLE_ROWS = 30;
/** Яндекс.Карты: max_results в воркере трактуется НА ОДИН поисковый URL, а не на задачу. */
const YANDEX_RESULTS_PER_URL = 500;

/** Достать необязательный number-параметр из payload джобы (не задан/не число — null). */
function payloadNumber(job: HeJob, key: string): number | null {
  const value = job.payload?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Достать необязательный string[]-параметр из payload джобы: непустой массив
 * непустых строк или null. Пустой массив → null (route тоже не пишет пустой) —
 * фильтрация срабатывает только на осмысленный выбор.
 */
function payloadStringArray(job: HeJob, key: string): string[] | null {
  const value = job.payload?.[key];
  if (!Array.isArray(value)) return null;
  const ids = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return ids.length > 0 ? ids : null;
}

/**
 * Единый лимит строк сборки: payloadNumber(job, 'limit') ?? 10000, кламп в
 * [100, 50000]. Роль бывших DIRECTORY_LIMIT / CHILD_ROWS_LIMIT / TOTAL_ROWS_CAP
 * теперь играет это одно значение: кап пагинации реестра, кап чтения каждой
 * дочерней джобы и общий кап базы после мёрджа, дедупа и исключения чужих баз.
 */
export function totalRowsCap(job: HeJob): number {
  const limit = payloadNumber(job, 'limit') ?? DEFAULT_ROWS_LIMIT;
  return Math.min(MAX_ROWS_LIMIT, Math.max(MIN_ROWS_LIMIT, limit));
}

/* ─────────────────────── Унифицированная строка ─────────────────────── */

/** Колонки авто-собранной базы (порядок — контракт he_bases.columns). */
export const HE_AUTO_COLLECT_COLUMNS = [
  'company',
  'website',
  'email',
  'phone',
  'vacancy_title',
  'address',
  'category',
  'employees',
  'revenue',
  'inn',
  'source_detail',
] as const;

export type HeUnifiedRow = Record<(typeof HE_AUTO_COLLECT_COLUMNS)[number], string>;

function cell(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return String(value).trim();
}

/** Первый элемент массива как строка (phones[0], emails[0]); не массив — пусто. */
function firstCell(value: unknown): string {
  return Array.isArray(value) ? cell(value[0]) : '';
}

function unifiedRow(partial: Partial<HeUnifiedRow>): HeUnifiedRow {
  const row = {} as HeUnifiedRow;
  for (const col of HE_AUTO_COLLECT_COLUMNS) row[col] = partial[col] ?? '';
  return row;
}

/** Строка реестра companies_directory → унифицированная строка. */
export function mapDirectoryRow(row: Record<string, unknown>): HeUnifiedRow {
  return unifiedRow({
    company: cell(row.name),
    website: cell(row.website),
    email: cell(row.email),
    // phones в реестре — text с телефонами через запятую (массив тоже схлопнется в ту же строку).
    phone: cell(row.phones).split(',')[0]?.trim() ?? '',
    address: cell(row.address),
    category: cell(row.okved_code),
    employees: cell(row.employees_count),
    revenue: cell(row.revenue),
    inn: cell(row.inn),
    source_detail: 'реестр',
  });
}

/** Вакансия hh → работодатель + название вакансии как крючок персонализации. */
export function mapHhRow(row: Record<string, unknown>, queryText: string): HeUnifiedRow {
  return unifiedRow({
    company: cell(row.company_name),
    website: cell(row.company_site_url),
    vacancy_title: cell(row.name),
    address: cell(row.area),
    source_detail: `hh: ${queryText}`,
  });
}

/** Организация Яндекс.Карт → унифицированная строка. */
export function mapYandexRow(row: Record<string, unknown>): HeUnifiedRow {
  return unifiedRow({
    company: cell(row.name),
    website: cell(row.website),
    email: cell(row.email),
    phone: cell(row.phone),
    address: cell(row.address),
    category: cell(row.categories),
    source_detail: 'яндекс.карты',
  });
}

/** Место Google Maps → унифицированная строка. */
export function mapGoogleRow(row: Record<string, unknown>): HeUnifiedRow {
  return unifiedRow({
    company: cell(row.name),
    website: cell(row.website),
    email: firstCell(row.emails),
    phone: cell(row.phone),
    address: cell(row.address),
    category: cell(row.category),
    source_detail: 'google maps',
  });
}

/** Локаль из полей справочника: «город, регион, страна» без пустых кусков. */
function composeAddress(...parts: unknown[]): string {
  return parts.map(cell).filter(Boolean).join(', ');
}

/** Строка каталога PDL (market='us') → унифицированная строка (size-бакет → employees). */
export function mapPdlRow(row: Record<string, unknown>): HeUnifiedRow {
  return unifiedRow({
    company: cell(row.name),
    website: cell(row.website),
    address: composeAddress(row.locality, row.region, row.country),
    category: cell(row.industry),
    employees: cell(row.size),
    source_detail: 'pdl',
  });
}

/** Стартап funded_companies → унифицированная строка (источник данных — в source_detail). */
export function mapFundedRow(row: Record<string, unknown>): HeUnifiedRow {
  return unifiedRow({
    company: cell(row.name),
    website: cell(row.website),
    address: composeAddress(row.locality, row.region, row.country),
    category: cell(row.industry),
    source_detail: `funded:${cell(row.source) || 'unknown'}`,
  });
}

/** Вакансия eng_hiring_cache → работодатель + название вакансии как крючок персонализации. */
export function mapEngHiringRow(row: Record<string, unknown>): HeUnifiedRow {
  return unifiedRow({
    company: cell(row.company_name),
    website: cell(row.company_site_url),
    vacancy_title: cell(row.vacancy_title),
    address: cell(row.location) || cell(row.country),
    source_detail: `eng_hiring:${cell(row.source) || 'unknown'}`,
  });
}

/**
 * Нормализация названия компании для дедупа: lowercase, срез юрформ
 * (ООО/ИП/АО/ПАО/ЗАО/ОАО/АНО/НКО и латинские LLC/LTD/INC/OOO/CORP/CORPORATION/
 * LLP/LP/LIMITED/GMBH/PLC/SARL/SA/AG/BV/NV/PTY/PTE — отдельными словами, в
 * любых кавычках; латинское IP НЕ срезаем — слишком коллизионно:
 * «IP Solutions»), удаление кавычек («»„“""'') и прочей пунктуации,
 * схлопывание пробелов. Иначе «ООО "ТЕРАБАЙТ"» из реестра и «ТЕРАБАЙТ»
 * из hh жили в базе обе, как и «Acme, Inc.» из pdl и «ACME LLC» из eng_hiring.
 */
export function normalizeCompanyForDedup(name: string): string {
  let s = ` ${name.trim().toLowerCase()} `;
  // Пунктуация → пробел: кавычки всех стилей, дефисы, точки — всё небуквенное.
  s = s.replace(/[^0-9a-zа-яё\s]+/gi, ' ');
  // Юрформы отдельными словами (длинные формы раньше коротких: «пао» до «ао»).
  s = s.replace(
    /(^|\s)(ооо|ип|пао|зао|оао|ано|нко|ао|llc|ltd|inc|ooo|corporation|corp|limited|llp|lp|gmbh|plc|sarl|sa|ag|bv|nv|pty|pte)(?=\s|$)/g,
    ' ',
  );
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Нормализация сайта для дедупа: только хост, lowercase, без www и пути
 * (https://www.x.ru/about → x.ru), срез конечной точки (x.ru. → x.ru).
 * Мусорные значения («не-сайт», localhost, произвольный текст) → пустой
 * ключ: хост без «точки + TLD» — не сайт, а punycode-мусор в ключе склеивал
 * бы разные строки одной компании не хуже пустого сайта. В строке
 * сохраняется полный website — хост используется только в ключе.
 */
export function normalizeWebsiteForDedup(website: string): string {
  const raw = website.trim().toLowerCase();
  if (!raw) return '';
  let host: string;
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    host = url.hostname;
  } catch {
    // Кривая строка (пробелы, мусор): грубый срез схемы/пути руками.
    host = raw.replace(/^[a-z]+:\/\//, '').split(/[\s/?#]/)[0];
  }
  host = host.replace(/^www\./, '').replace(/\.+$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : '';
}

/**
 * Дедуп: точный ключ «компания|сайт» (первое вхождение побеждает — задачи
 * плана упорядочены по приоритету) плюс схлопывание пары «та же компания,
 * сайт пуст хотя бы у одной строки»: «ООО "ТЕРАБАЙТ"» с сайтом и «ТЕРАБАЙТ»
 * без сайта — одна компания, выживает более богатая строка (с website/email,
 * иначе первая). Пары с РАЗНЫМИ непустыми сайтами живут обе — у дочек/филиалов
 * бывают разные домены; с 26.09.2026 то же уточнение доменом делает и
 * кросс-базовое исключение при market='us' (matchesExclusion), а для RU там
 * по-прежнему матч по компании с уточнением ИНН: у RU-источников одна фирма
 * приходит с разными сайтами. Строки с пустым нормализованным ключом компании
 * («ООО», «—», «») — мусор: все они схлопнулись бы в один ключ «|»,
 * выбрасываются как и строки с пустым сырым company.
 */
export function dedupUnifiedRows(rows: HeUnifiedRow[]): HeUnifiedRow[] {
  const seen = new Set<string>();
  const firstIdxByCompany = new Map<string, number>();
  const out: HeUnifiedRow[] = [];
  for (const row of rows) {
    const company = normalizeCompanyForDedup(row.company);
    if (!company) continue;
    const website = normalizeWebsiteForDedup(row.website);
    const key = `${company}|${website}`;
    const idx = firstIdxByCompany.get(company);
    if (idx === undefined) {
      firstIdxByCompany.set(company, out.length);
      seen.add(key);
      out.push(row);
      continue;
    }
    const existingWebsite = normalizeWebsiteForDedup(out[idx].website);
    if (website === '' || existingWebsite === '') {
      // Та же компания, но сайт пуст хотя бы у одной строки (точный дубль
      // «компания|» — тоже сюда): оставляем более богатую (с сайтом/email),
      // при равенстве — первую.
      const existingRich = existingWebsite !== '' || out[idx].email !== '';
      const rowRich = website !== '' || row.email !== '';
      if (rowRich && !existingRich) {
        out[idx] = row;
        seen.add(key);
      }
      continue;
    }
    // У обеих строк непустые сайты: точный дубль пропускаем, разные домены
    // (дочки/филиалы) живут обе.
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * Round-robin мёрдж харвестов задач: берём строку №1 из каждого списка по
 * кругу, затем строку №2 и т.д., исчерпанные списки пропускаем. Порядок строк
 * внутри каждой задачи сохраняется (строки реестра идут в порядке реестра —
 * в своих «ходах»). До этого был concat+slice по задачам, и первый источник
 * (реестр диспатчится первым) съедал весь кап, а строки hh/карт
 * молча отрезались. Дедуп после мёрджа сохраняет справедливость: первое
 * вхождение дубля — из самого раннего «хода», т.е. из самой приоритетной
 * задачи среди содержащих эту строку.
 */
export function interleaveTaskHarvests(lists: HeUnifiedRow[][]): HeUnifiedRow[] {
  const out: HeUnifiedRow[] = [];
  for (let i = 0; ; i += 1) {
    let took = false;
    for (const list of lists) {
      if (i < list.length) {
        out.push(list[i]);
        took = true;
      }
    }
    if (!took) return out;
  }
}

/**
 * Вес контактности строки. Числа — не шкала качества, а порядок: перестановка
 * зависит только от знака разности, поэтому любая пара с `почта > сайт > 0`
 * даёт ровно тот же результат. Взяты те же 30/35, что у V2
 * (`verticalEngineV2/candidatePriority.ts`, слагаемые сайта и почты), чтобы под
 * одно и то же решение не завелось два разных числа. Почта дороже сайта
 * намеренно: по готовому адресу контакт получается без обхода сайта.
 */
const CONTACTABLE_WEIGHT_SITE = 30;
const CONTACTABLE_WEIGHT_EMAIL = 35;

/**
 * Харвест ОДНОЙ задачи: строки, по которым уже есть чем связаться (сайт или
 * почта), — вперёд; внутри равного веса порядок источника сохраняется
 * (ничьи разбиваются исходным индексом, то есть сортировка стабильна
 * независимо от движка).
 *
 * ЗАЧЕМ. `kept.slice(0, limit)` у V1 ОКОНЧАТЕЛЕН: строка, не попавшая под кап,
 * в эту базу не попадёт уже никогда, а слот под капом оплачен. Строка без
 * сайта и без почты этот слот тратит впустую: `find_emails` и
 * `enrich_descriptions` требуют колонку сайта, `validate_emails` — адрес, то
 * есть конструктору по ней нечего обходить и нечего проверять, и контакта из
 * неё не выйдет. При прочих равных слот отдаём строке, по которой есть чем
 * работать. Отличие от V2 принципиальное: там тот же вес задаёт лишь ПОРЯДОК
 * РАБОТЫ внутри источника для следующей партии (задача переоткрывается), здесь
 * он решает, кто попадёт в базу ВООБЩЕ.
 *
 * ПОЧЕМУ ТОЛЬКО ВНУТРИ ЗАДАЧИ — и почему объединённый список сортировать
 * нельзя ни при каких условиях. `interleaveTaskHarvests` заведён ровно против
 * того, чтобы один источник съел кап целиком, а по контактности источники
 * заведомо неравны: у `pdl`/`funded` сайт лежит в самой строке, у
 * `eng_hiring` его дособирает резолвер с потолком
 * ENG_HIRING_SITE_RESOLVE_MAX строк на задачу. Общая сортировка вынесла бы
 * `eng_hiring` в хвост целиком — то есть выбросила бы сигнал НАМЕРЕНИЯ
 * (компания нанимает прямо сейчас) и `vacancy_title`, единственный крючок
 * персонализации, который у ENG-строки вообще бывает.
 *
 * ПОСЛЕ ДОСБОРА САЙТОВ, А НЕ ДО. Вес считается на готовом харвесте задачи, то
 * есть уже после `resolveEngHiringSites` (он работает внутри
 * `fetchEngHiringRows`): строка, которой сайт дособрали, идёт вперёд наравне с
 * теми, у кого он был изначально. Перенесёте сортировку в ЦИКЛ СТРАНИЦ фетча —
 * сломаете сразу две вещи: вес будет считаться до досбора, а закладка каталога
 * уедет не туда, потому что префикс `catalogPrefix` идёт строго по порядку
 * СКАНИРОВАНИЯ и на переставленных строках закроет не то, что разобрано.
 */
function contactableFirst(rows: HeUnifiedRow[]): HeUnifiedRow[] {
  return rows
    .map((row, index) => ({ row, index, score: contactableScore(row) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.row);
}

/** Есть ли по строке чем работать: обходимый сайт или готовый адрес. */
function hasContactHandle(row: HeUnifiedRow): boolean {
  return contactableScore(row) > 0;
}

/**
 * «Сайт есть» — ровно то же, что понимают под сайтом дедуп и кросс-базовое
 * исключение: хост с TLD (`normalizeWebsiteForDedup`). Строка со значением
 * «нет сайта» или `localhost` для конструктора не сайт — `find_emails` по ней
 * не обойдёт ничего, и считать её контактной значило бы соврать самому себе.
 * «Почта есть» — тот же тест, что у `emailPoorRows`: пусто/непусто, без
 * разбора формата; формат судит `validate_emails`, и до него мы здесь не
 * достаём. В V2 сайт проверяется строже (`veOfficialWebsiteCandidates`
 * отсеивает ещё и соцсети) — здесь такого понятия у V1 нет ни в одном месте
 * стадии, и заводить его ради сортировки значило бы менять не порядок, а смысл.
 */
function contactableScore(row: HeUnifiedRow): number {
  return (
    (normalizeWebsiteForDedup(cell(row.website)) !== '' ? CONTACTABLE_WEIGHT_SITE : 0) +
    (cell(row.email) !== '' ? CONTACTABLE_WEIGHT_EMAIL : 0)
  );
}

/* ─────────────────────── Билдеры запросов к коллекторам ─────────────────────── */

/** directory_filters плана → фильтры реестра (только заданные поля). */
export function mapDirectoryFilters(
  filters: HeCollectTask['directory_filters'],
): CompaniesSearchFilters {
  // B2B-дефолт: ИП не включаем (RPC при отсутствии фильтра вернёт includeIp=true).
  const out: CompaniesSearchFilters = { includeIp: filters?.includeIp ?? false };
  if (!filters) return out;
  if (filters.okvedCodes?.length) out.okvedCodes = filters.okvedCodes;
  if (filters.regionCodes?.length) out.regionCodes = filters.regionCodes;
  if (typeof filters.revenueFrom === 'number') out.revenueFrom = filters.revenueFrom;
  if (typeof filters.revenueTo === 'number') out.revenueTo = filters.revenueTo;
  if (typeof filters.employeesFrom === 'number') out.employeesFrom = filters.employeesFrom;
  if (typeof filters.employeesTo === 'number') out.employeesTo = filters.employeesTo;
  if (typeof filters.hasEmail === 'boolean') out.hasEmail = filters.hasEmail;
  return out;
}

/** maps_query → поисковые URL Яндекс.Карт (формат как в YandexMapsParserForm). */
export function buildYandexSearchUrls(query: { queries: string[]; geo?: string }): string[] {
  return query.queries.map((q) => {
    const text = query.geo ? `${q} ${query.geo}` : q;
    return `https://yandex.ru/maps/?text=${encodeURIComponent(text)}`;
  });
}

/** maps_query → inputLines Google Maps (гео доклеивается к каждому запросу). */
export function buildGoogleInputLines(query: { queries: string[]; geo?: string }): string[] {
  return query.queries.map((q) => (query.geo ? `${q} ${query.geo}` : q));
}

/* ─────────────────────── collect_info: форма состояния ─────────────────────── */

export type HeCollectSource = HeCollectTask['source'];

export type HeCollectTaskStatus = 'pending' | 'dispatched' | 'done' | 'failed';

export interface HeCollectTaskState {
  source: HeCollectSource;
  status: HeCollectTaskStatus;
  /** id дочерней джобы парсера; null у синхронного реестра. */
  child_job_id: string | null;
  /** Собрано строк (после завершения задачи). */
  rows: number;
  /** Снапшот задачи из плана (фильтры/запросы) — нужен на harvest. */
  task: HeCollectTask;
  /** Унифицированные строки задачи (реестр — сразу на dispatch). */
  harvest?: HeUnifiedRow[];
  /** Когда задача ушла в дочерний парсер (ISO) — таймаут ожидания в WAIT. */
  dispatched_at?: string;
  error?: string;
  /**
   * Реестр и ENG-каталоги: строк пропущено на выборке как уже собранные в других
   * базах проекта. Пропущенные НЕ тратят limit — в этом и смысл исключения на
   * выборке (продолжение больших срезов).
   */
  excluded_during_fetch?: number;
  /**
   * Выдача источника под фильтры среза КОНЧИЛАСЬ раньше limit — продолжать
   * этим срезом нечем. Ставят обе ветки: реестр (читает с offset 0, значит
   * «кончилась вся выдача») и ENG-каталоги (читают с закладки, значит
   * «кончилась выдача ЗА закладкой»). Разница существенна, и её несёт
   * соседнее поле `continued`: без него «кончилась за закладкой» и «в срезе
   * не было ни строки с самого начала» неразличимы.
   *
   * Флаг живёт в collect_info ОДНОЙ базы и вычисляется заново каждую сборку —
   * он не может закрыть источник навсегда: ночной ingest вставит строки с
   * большим created_at, они окажутся ВПЕРЕДИ закладки, и следующая сборка их
   * прочитает.
   */
  exhausted?: boolean;
  /**
   * ENG-каталоги: чтение СТАРТОВАЛО с сохранённой закладки (`slot.from`), то
   * есть этот срез уже листали прошлые сборки проекта.
   *
   * Читатель один — разбор нулевой сборки (`segmentExhausted`), и только в
   * паре с `exhausted`. Зачем пара: «страница пришла короткой» без закладки
   * означает «в срезе вообще пусто» (обычная первая пустая сборка), а с
   * закладкой — «всё, что в срезе было, проект уже разобрал». Кабинет по
   * второму случаю печатает «новых компаний не осталось»; по первому это
   * было бы неправдой.
   */
  continued?: boolean;
  /**
   * Стоп по потолку страниц раньше limit — НЕ исчерпание: выдача ещё есть,
   * повторная сборка продолжит. Потолок у реестра MAX_DIRECTORY_PAGES (200k
   * просмотренных строк), у ENG-каталогов ENG_CATALOG_MAX_PAGES /
   * ENG_HIRING_MAX_PAGES (60k / 20k).
   */
  hit_ceiling?: boolean;
  /**
   * ENG-каталоги: партия ЧАСТИЧНАЯ — чтение оборвалось на странице, разобранный
   * префикс строк сохранён (см. блок «ЧТЕНИЕ КАТАЛОГА С ЗАКЛАДКОЙ»).
   *
   * Флаг существует ради ОДНОГО читателя — разбора нулевой сборки
   * (`segmentExhausted`): у оборванного чтения «строк нет» не означает «новых
   * компаний не осталось», а именно это предложение кабинет показал бы клиенту.
   * Отличить одно от другого по `rows === 0` нельзя, поэтому признак хранится.
   */
  partial?: boolean;
  /** Пометка задачи для UI (например, «реестр исчерпан»). */
  note?: string;
}

/** Состояние фазы CONSTRUCT в collect_info (обогащение конструктором баз). */
export interface HeConstructInfo {
  /** id джобы конструктора баз (base_constructor_jobs). */
  bc_job_id: string | null;
  /**
   * dispatched — BC-джоба создана, ждём терминальный статус;
   * done/failed/cancelled — финал фазы (база ушла в analyzing):
   * при failed/cancelled импортирован частичный результат либо база оставлена
   * без обогащения (см. note).
   */
  status: 'dispatched' | 'done' | 'failed' | 'cancelled';
  /** Когда создана BC-джоба (ISO) — таймаут ожидания в WAIT-CONSTRUCT. */
  dispatched_at?: string;
  /** Почт найдено конструктором (result_stats.emails_found BC-джобы). */
  emails_found?: number;
  /** Почт с вердиктом ok после валидации (колонка «Email Статус» сетки). */
  valid_count?: number;
  /**
   * Кап «адресов на компанию», переданный этой BC-джобе
   * (step_config.cap_emails_per_company.max). Дубль колонки
   * he_bases.contact_cap_applied: колонка — для дешёвой выборки баз,
   * чей кап устарел, а здесь значение есть ВСЕГДА, в том числе на
   * инсталляции, где миграция 20260926_0001 ещё не применена.
   */
  contact_cap?: number;
  /**
   * Эта джоба — повтор ради обязательного split_emails; здесь id той
   * legacy-джобы, чей результат импортировать было нельзя. Признак
   * одноразовости: второй такой повтор оплачивать не будем.
   */
  resplit_of?: string;
  /** Пометка для UI (частичный импорт / без обогащения / таймаут). */
  note?: string;
}

/**
 * Итог релевант-гейта, отработавшего ДО конструктора (только market='us').
 * Ключа нет — гейт в этой сборке перед конструктором не запускался:
 * RU-инструмент судит строки ПОСЛЕ импорта, как и раньше, и ENG-база, чья фаза
 * CONSTRUCT началась до 28.09.2026, — тоже.
 */
export interface HeRelevanceGateInfo {
  /**
   * Гейт ОТРАБОТАЛ: строки действительно судились (моделью или префильтром).
   * false — запись есть, а суда не было (провайдер не ответил ни на один батч,
   * у вертикали пустое имя, гейт бросил). Такой записи не верим: следующий тик
   * судит заново, а дошедшая до импорта база судится после импорта прежним
   * путём. Без этого флага «модель никого не вычеркнула» и «модель не ответила»
   * выглядели в jsonb одинаково (flagged_keys=[]), и один отказ провайдера
   * навсегда снимал проверку с базы.
   */
  ran: boolean;
  /** Почему гейт не отработал (только при ran=false; текст для staff). */
  error?: string;
  /** Строк отдано модели (внутренний кап гейта MAX_ROWS_TO_CHECK). */
  checked: number;
  /** Строк ПОЛУЧИЛО вердикт модели (батчи без ответа не считаются). */
  judged: number;
  /** Строк снял дешёвый префильтр ДО модели (findOffTargetRows). */
  off_target: number;
  /**
   * Ключи «компания|домен» строк вне вертикали — тот же ключ, что у дедупа
   * HARVEST. Ключи, а не индексы: merged пересчитывается на каждом тике
   * (межбазовое исключение могло вырасти), и индекс уехал бы на чужую строку.
   *
   * Живут ровно до терминальной записи базы: там пометки уже разложены по
   * строкам (`_low_relevance`), и набор ключей снимается — см.
   * `dropCollectWorkState`. У завершённой базы здесь ПУСТОЙ массив, а сколько
   * компаний вычеркнуто, говорит `stats.low_relevance` — он считается по самим
   * строкам базы и живёт в терминальной записи, поэтому отдельного числа
   * рядом с ключами не держим (такое число никто не читал).
   */
  flagged_keys: string[];
  tokens_used: number;
  cost_usd: number;
  /**
   * Когда гейт отработал (ISO); у записи с ran=false — когда он пытался.
   * Запись с ran=true = второй раз не платим.
   */
  judged_at: string;
}

/** Провенанс починки плана: почему её запускали и чем кончилось. */
export interface HePlanRepair {
  reason: 'no_catalog_source';
  outcome: 'repaired' | 'failed';
  /** Срез, которым добрали каталог (outcome='repaired'). */
  pdl_filters?: HeCollectTask['pdl_filters'];
  /** Причина провала починки (outcome='failed'). */
  error?: string;
}

/**
 * ПЛАТНОЕ расширение плана: все каталожные срезы дочитаны до конца, цель не
 * набрана — и мы один раз заплатили за ещё один срез (buildCatalogWidenMessagesEn).
 *
 * У записи ОДИН читатель, и без него её бы здесь не было: она же — признак
 * «в этой сборке уже платили». Каталожная задача, добавленная расширением,
 * сама становится каталожной задачей плана, и без признака следующий тик
 * увидел бы ту же картину (все срезы исчерпаны, цель не набрана) и заплатил
 * второй раз.
 *
 * ОТДЕЛЬНОЕ ПОЛЕ, А НЕ `plan_repair`, — и это не вкусовщина. Кабинет печатает
 * решение автопилота по ОДНОМУ полю `plan_repair.outcome`
 * (client-eng/EngStepBases.tsx): при 'repaired' он говорит «The plan had no
 * company catalog — the autopilot added one». Для расширения это неправда —
 * каталог в плане был, и не один, — а переписать текст кабинета отсюда
 * нельзя. Поэтому у расширения своё поле, и в белый список клиентской
 * проекции оно не входит: клиенту тут показывать нечего, читатель — staff.
 */
export interface HePlanWidening {
  /** added — срез добавлен в план; failed — модель не ответила или вернула уже читанный срез. */
  outcome: 'added' | 'failed';
  /** Срез, которым расширили план (outcome='added'). */
  pdl_filters?: HeCollectTask['pdl_filters'];
  /** Почему расширение не состоялось (outcome='failed'; текст для staff). */
  error?: string;
  /** Когда платили (ISO). */
  at: string;
}

/**
 * Итог пробы каталожного среза (ensureSliceMatchesVertical). outcome='rejected'
 * означает, что база НЕ строилась осознанно: срез не про эту вертикаль, а
 * автопилоту честнее пропустить вертикаль, чем разослать по мусору.
 */
export interface HeSliceProbe {
  outcome: 'passed' | 'repaired' | 'repair_failed' | 'rejected';
  /** Доля строк выборки, признанных принадлежащими вертикали (0..1). */
  hit_rate: number;
  sampled: number;
  /** Доля до перепланирования (у repaired/rejected) — видно, помогло ли. */
  first_hit_rate?: number;
  /** Компании выборки, не признанные подходящими, — объяснение решения. */
  off_target_examples?: string[];
  /** Срез, которым перепланировали (repaired/rejected). */
  pdl_filters?: HeCollectTask['pdl_filters'];
  /** Сколько каталожных задач плана заменено одним срезом (repaired). */
  replaced_tasks?: number;
  /** Причина, по которой перепланирование не состоялось (repair_failed). */
  error?: string;
}

export interface HeCollectInfo {
  /** Лимит строк, выбранный при запуске сборки (route пишет при создании базы). */
  limit?: number;
  /**
   * Refill-режим ENG auto-pipeline (payload.refill джобы): после CONSTRUCT —
   * долив лидов в запущенную кампанию вместо analyzing/base_analyze.
   */
  refill?: boolean;
  /** Кампания Instantly для долива (снапшот launch_info на момент постановки). */
  campaign_id?: string;
  /** Итог refill-ветки (stages/baseCollectRefill.ts). */
  refill_result?: HeRefillResult;
  plan?: HeSourcePlan;
  /**
   * Починка плана без каталожного источника (ensureCatalogSource, market='us').
   * Ключа нет — план пришёл от планировщика как есть ЛИБО взят из
   * he_catalog_cursors (тогда провенанс планирования лежит у той базы, которая
   * за него заплатила). outcome='failed' объясняет тонкую базу: каталога не
   * было и добавить его не вышло.
   */
  plan_repair?: HePlanRepair;
  /**
   * Проба каталожного среза на принадлежность вертикали
   * (ensureSliceMatchesVertical, market='us'). Ключа нет — пробы в ЭТОЙ сборке
   * не было: RU-план, план без каталога, проба не состоялась или план взят из
   * he_catalog_cursors (срез уже судила та сборка, что за пробу заплатила).
   */
  slice_probe?: HeSliceProbe;
  /**
   * Платное расширение плана, когда все каталожные срезы дочитаны до конца, а
   * цель не набрана (market='us', HE_COLLECT_WIDEN=replan). Ключа нет —
   * в ЭТОЙ сборке за расширение не платили; ключ есть — второй раз не платим.
   */
  plan_widening?: HePlanWidening;
  /** Гипотезы, по которым реально строился план (accepted-дефолт или выбор специалиста). */
  hypotheses?: Array<{ id: string; title: string; status: string | null }>;
  tasks?: HeCollectTaskState[];
  /** Фаза CONSTRUCT: состояние передачи базы конструктору (появляется после HARVEST). */
  construct?: HeConstructInfo;
  /**
   * Релевант-гейт, отработавший ДО конструктора (market='us'). Запись —
   * доказательство оплаты: пока она есть, гейт на этой базе не повторяется, а
   * её flagged_keys переживают все тики ожидания конструктора.
   */
  relevance_gate?: HeRelevanceGateInfo;
  stats?: {
    tasks_total: number;
    tasks_done: number;
    tasks_failed: number;
    rows_total: number;
    /** Строк отсеяно как уже существующие в других базах проекта. */
    excluded_existing_bases: number;
    /** Реестр: строк пропущено ещё на выборке (уже собраны в других базах проекта). */
    excluded_during_fetch: number;
    /**
     * Компаний в готовой базе (уникальных ключей «компания|домен»). Отличается
     * от row_count базы: после split_emails у компании столько строк, сколько
     * адресов оставил кап. Ключа нет у сборок до 26.09.2026.
     */
    companies_total?: number;
    /**
     * Адресов с вердиктом 'ok', не помеченных вне вертикали, — оценка СВЕРХУ
     * того, сколько лидов возьмёт запуск (ниже ещё чёрный список клиента и
     * дедуп адресов). Сравнивается с потолком запуска HE_LAUNCH_MAX_LEADS:
     * больше потолка — часть адресов запуск оставит дома (сначала по одному
     * сильнейшему адресу на компанию), но базу примет. Ключа нет у сборок до
     * 26.09.2026.
     */
    ok_contacts?: number;
    /** Адресов отброшено пост-импортным капом сверх «N адресов на компанию». */
    dropped_over_contact_cap?: number;
    /** Строк отброшено у компаний сверх лимита сборки (инвариант «≤ N компаний»). */
    dropped_over_company_cap?: number;
    finished_at: string;
  };
}

/** he_bases-строка авто-сборки: колонки source/collect_info моложе HeBase. */
type HeAutoBase = HeBase & {
  source?: string;
  collect_info?: HeCollectInfo | null;
  error?: string | null;
  /**
   * Кап «адресов на компанию» этой базы (штамп с проекта на постановке,
   * baseCollectEnqueue) и кап, реально применённый конструктором. Обе колонки
   * моложе HeBase и отсутствуют, пока не применена миграция
   * 20260926_0001_he_emails_per_company.sql.
   */
  max_emails_per_company?: number | null;
  contact_cap_applied?: number | null;
};

/** Таблица дочерней джобы по источнику (у реестра и ENG-источников pdl/funded/eng_hiring дочерней джобы нет). */
const CHILD_JOB_TABLE: Record<'hh_live' | 'yandex_maps' | 'google_maps', string> = {
  hh_live: 'parser_jobs',
  yandex_maps: 'yandex_maps_jobs',
  google_maps: 'google_maps_jobs',
};

/** Дочерняя джоба завершилась неудачно? google_maps имеет свой набор статусов. */
function isChildFailed(source: HeCollectSource, status: string): boolean {
  return source === 'google_maps'
    ? status === 'failed' || status === 'stopped'
    : status === 'failed';
}

/**
 * Клиент для ЗАПИСИ ЧЕКПОЙНТА ОПЛАТЫ — не для работы стадии.
 *
 * Клиент стадий (`ctx.supabase`) привязан к сигналу джобы: после abort'а сторожа
 * его запросы отвергаются, и это правильно для РАБОТЫ — прерванный прогон должен
 * кончаться. Но у нескольких записей движка другая природа: они не делают работу,
 * а ЗАПОМИНАЮТ, что работа уже оплачена. Их отказ не экономит ничего — он
 * превращает оплаченную работу в неоплаченную, и повтор джобы покупает её второй
 * раз. Поэтому они идут клиентом БЕЗ сигнала джобы (stageDb.heCheckpointSupabase,
 * срок на заголовки и на паузу в теле у него тот же, так что повиснуть он тоже не
 * может), и у них есть окно сторожа STAGE_ABORT_GRACE_MS на то, чтобы долететь.
 *
 * КРИТЕРИЙ, а не список: запись — ДЕНЬГИ, если она фиксирует то, что ПЛАТНЫЙ
 * ИСПОЛНИТЕЛЬ уже сделал и чего повтор не отменит (модель уже отсудила батч,
 * Instantly уже принял лидов). Запись — РАБОТА, если она фиксирует прогресс,
 * который повтор воспроизведёт, ничего не купив заново. Работа остаётся на
 * клиенте стадий сознательно: именно её запросы обязаны кончаться по abort'у.
 *
 * Сегодня критерию отвечают ЧЕТЫРЕ записи — две в этом файле и две в
 * refill-ветке (stages/baseCollectRefill.ts), которая поэтому и импортирует эту
 * функцию:
 *  1. МЕМО РЕЛЕВАНТ-ГЕЙТА (`collect_info.relevance_gate`, ran=true). Гейт судит
 *     строки моделью батчами по 50 (relevanceGate.findIrrelevantRows), и каждый
 *     батч — отдельный платёж. Модуль never-throw ПО БАТЧАМ: если сторож прервал
 *     прогон на пятом батче, четыре уже оплачены, judged > 0 и гейт возвращает
 *     ran=true. Без этой записи повтор не находит `relevance_gate` и судит всё
 *     заново — с нуля, по всем строкам.
 *  2. ФИНАЛЬНАЯ ЗАПИСЬ БАЗЫ (harvestRow). К ней уже оплачены план, коллекторы,
 *     конструктор и гейт; сама запись идемпотентна и адресована по id. Её потеря
 *     дороже всего у RU-инструмента: там гейт судит ПОСЛЕ импорта и в
 *     collect_info не memoized, поэтому каждый повтор — ещё один оплаченный суд.
 *  3. ТЕРМИНАЛЬНАЯ ЗАПИСЬ REFILL-БАЗЫ (persistRefillBase, оба вызова: успешный
 *     долив и отказ). К ней лиды УЖЕ ПРИНЯТЫ Instantly в живую кампанию — самый
 *     дорогой вид оплаченного, потому что отменить приём нельзя. Эта же запись
 *     несёт решение «вернуть компании в пул или оставить исключёнными»
 *     (companies_released), и её потеря роняет базу в чужие руки: строка
 *     остаётся 'collecting', финальный фейл джобы уводит её в 'failed'
 *     (repairBaseAfterCollectFinalFail), а 'failed'-база ВЫПАДАЕТ из
 *     кросс-базового исключения — то есть уже написанные компании объявляются
 *     несобранными и ночь за ночью пересобираются за деньги.
 *  4. СТРОКА ПРОГОНА ДОЛИВА (`he_auto_pipeline_runs`, writeRefillRun). В её
 *     `stats.appended` лежит число уже принятых лидов. Отправку сверх капа она
 *     сама больше не открывает — это решает бронь дневного бюджета
 *     (`he_refill_daily_reservations`, миграция 20260930_0004), которая живёт в
 *     БД и потери этой строки не замечает. Но по ней считается ПРЕДПОЛЁТНЫЙ
 *     размер следующей сборки (refillAppendedToday): потерянная строка — это не
 *     потерянный отчёт, а исчезнувший расход, под который следующая ночь
 *     покупает компании, чьи строки бюджет потом выбросит.
 *
 * ЧТЕНИЯ через этот клиент не идут ни одного: ради того, чтобы чтения стадии
 * кончались, привязка к сигналу и вводилась. Поэтому решения, которым нужно
 * чтение, обязаны иметь безопасный исход при отказе чтения — так устроена серия
 * отказов долива (refillFailStreak: непрочитанная история = 0 = компании
 * возвращаются, обратимый исход).
 *
 * Отметки живости сторожу эти записи не дают: сток активности навешен
 * прокси-обёрткой на КЛИЕНТ СТАДИЙ (worker/hypothesisEngine.ts:
 * withStageActivity), а здесь клиент другой. Простоя из этого не выходит: перед
 * мемо гейта сторожа кормили вызовы модели через канал активной джобы, перед
 * финальной записью — импорт конструктора, перед записями долива — хук
 * beforeProviderRequest на каждом чанке отправки, а сами записи занимают
 * миллисекунды. Сколько времени у них есть после abort'а и у каких двух из
 * четырёх худший случай ДЛИННЕЕ окна — в докблоке heCheckpointSupabase.
 *
 * Клиента может не быть, и условие у этого РОВНО ОДНО: url или сервисный ключ не
 * в окружении. Про вызывающего ни эта функция, ни heCheckpointSupabase не знают
 * ничего — «тест или скрипт со своим двойником `ctx.supabase`» отсюда НЕ
 * определяется. В чекауте без `.env` вернётся null и мы останемся на клиенте
 * стадий (поведение до этой правки, гарантии «долетит после аборта» нет), а в
 * чекауте с `.env` тот же тест получит настоящий клиент и запись уедет мимо его
 * двойника — разбор и что с этим делать тесту см. у heCheckpointSupabase.
 */
export function paidCheckpointDb(ctx: HeStageContext): HeStageContext['supabase'] {
  return heCheckpointSupabase() ?? ctx.supabase;
}

async function persistCollectInfo(
  ctx: HeStageContext,
  baseId: string,
  info: HeCollectInfo,
  options?: {
    /**
     * Запись фиксирует УЖЕ СДЕЛАННУЮ ОПЛАТУ (см. paidCheckpointDb): идёт клиентом
     * без сигнала джобы и только пока база всё ещё 'collecting'. Барьер по статусу
     * здесь не осторожность, а следствие: повтор входит в стадию через start-guard,
     * который требует ровно 'collecting', — у отменённой или уже завершённой базы
     * мемо не нужен никому, а записанный поверх отмены вернул бы в строку снятый
     * уборкой харвест.
     */
    paidCheckpoint?: true;
  },
): Promise<void> {
  /**
   * Барьер по 'collecting' стоит на ОБЕИХ ветвях, и по одной причине: запись
   * прогресса базе, которая уже не собирается, не нужна никогда. Отмена в
   * кабинете переводит базу в 'failed' и обрезает харвест, а сигнал доходит до
   * стадии только на следующем тике наблюдателя (CANCEL_WATCH_MS), поэтому без
   * барьера стадия успевала вернуть обрезанный харвест обратно — до 10 МБ
   * jsonb на отменённой базе. Ноль затронутых строк здесь не ошибка.
   */
  const update = { collect_info: info, updated_at: new Date().toISOString() };
  const { error } = options?.paidCheckpoint
    ? await paidCheckpointDb(ctx)
        .from('he_bases')
        .update(update)
        .eq('id', baseId)
        .eq('status', 'collecting')
    : await ctx.supabase
        .from('he_bases')
        .update(update)
        .eq('id', baseId)
        .eq('status', 'collecting');
  if (error) throw new Error(`he_bases collect_info update: ${error.message}`);
}

/**
 * Снять с `collect_info` РАБОЧЕЕ СОСТОЯНИЕ стадии — то, что нужно только
 * незавершённой сборке. Зовётся на каждой терминальной записи базы ЭТОГО ФАЙЛА
 * (семь ветвей ниже: отказ пробы среза, ноль строк, двойной отказ разноса
 * адресов, таймаут конструктора, финал harvest и оба терминала долива).
 *
 * «Этого файла» — не оговорка: терминально писать базу умеют ещё два места, и
 * ни одно из них сюда не заходит.
 *  - Отмена клиентом (api/client/eng/projects/[id]/cancel) переводит базу в
 *    'failed' одним апдейтом статуса, `collect_info` не трогая. Её харвест
 *    снимает отдельная ограниченная уборка в том же роуте
 *    (dropCancelledBaseHarvest) — по барьеру «status='failed' +
 *    error='Cancelled by user'», по две базы за вызов.
 *  - Финальный фейл джобы (worker/hypothesisEngine.ts,
 *    repairBaseAfterCollectFinalFail → markNonTerminalFailed) тоже пишет только
 *    статус и причину. Базу, до чьей терминальной записи стадия не дожила,
 *    харвест поэтому переживает — навсегда, уборки на этот случай НЕТ. Это не
 *    регрессия (до волны 4b харвест переживал ЛЮБОЙ исход) и не переплата
 *    (статус терминальный, start-guard требует 'collecting'), но и не
 *    «сняли везде»: такая база остаётся жирной в поллинге деталки.
 *
 * Зачем. `tasks[].harvest` — предмерж-харвест задачи, до `limit` строк на
 * задачу при 1–4 задачах в плане. Замер на форме, которую пишет этот файл
 * (11 колонок `HE_AUTO_COLLECT_COLUMNS`, у отсутствующих значений — пустая
 * строка): 264 байта на строку pdl, 430 на строку реестра. То есть
 * `collect_info` завершённой базы весит до 10,3 МБ у кабинета (лимит 10 000,
 * 4 задачи) и до 82 МБ у RU-инструмента (лимит 50 000) — при 3,3 КБ полезного
 * остатка. Эту колонку читают деталка проекта (поллинг 4 с) и ENG-дашборд по
 * ВСЕМ базам проекта, а наружу из неё не уходит ни байта: `stripTaskHarvest`
 * (projectDetail) и клиентская проекция режут харвест на выходе — но уже ПОСЛЕ
 * того, как БД его переслала.
 *
 * `relevance_gate.flagged_keys` — второй по весу ключ (кап гейта
 * HE_RELEVANCE_MAX_ROWS = 3000 ключей ≈ 154 КБ, то есть 98% остатка у
 * ENG-базы). К терминальной записи он уже разложен в пометки `_low_relevance`
 * на самих строках, и число помеченных строк лежит в `stats.low_relevance`.
 *
 * Почему это НЕ повторная оплата ничего. После терминальной записи статус базы
 * — 'analyzing', 'analyzed' или 'failed', а start-guard стадии требует ровно
 * 'collecting', поэтому ни один тик к этим ключам больше не обращается
 * (единственные читатели — мёрдж HARVEST и раскладка пометок гейта, оба до
 * терминальной записи).
 *
 * Автоподъём базы (`he_auto_resume_transient_bases`, миграция 20260929_0001)
 * снятых ключей тоже не ждёт, но НЕ потому, что он до таких баз не доходит:
 * доходит. Он берёт базы с `row_count = 0`, чей последний фейл транзиентен по
 * `he_transient_collect_error`, и ветка «ноль строк» ниже как раз такую и
 * пишет — в её текст подставлен разбор упавших задач, а там живёт ровно
 * «Serper 429» и родня, то есть предикат СРАБАТЫВАЕТ. Не переплачивает поднятая
 * база по другой причине: её `info.tasks` переживают подъём целиком, DISPATCH
 * берёт только `status === 'pending'`, а у поднятой базы задачи уже 'done' или
 * 'failed' — заново не покупается ни одна. Мёрдж такой базы дал ноль и без
 * харвеста даст тот же ноль (строки, которых хватило бы на базу, увели бы её в
 * ветку HARVEST, где `row_count > 0` и кандидатом она не станет).
 *
 * Доказательство оплаты гейта — `ran = true`, а не набор ключей: именно `ran`
 * проверяет условие повторного суда.
 *
 * ВЫЧИТАНИЕ, А НЕ БЕЛЫЙ СПИСОК — сознательно. Белый список полей (как в v2)
 * молча гасит элемент карточки, забытый в перечислении: серверный
 * `HeCollectInfo` не знает про `hypothesis_ids`, который пишет постановка
 * сборки (`baseCollectEnqueue`) и читает staff-UI («под эту гипотезу база уже
 * собрана», Step2Verticals). Здесь ключи не перечисляются вовсе: `info` —
 * это сам jsonb из строки базы, и всё, кроме двух названных ключей, проходит
 * спредом как есть.
 */
function dropCollectWorkState(info: HeCollectInfo): HeCollectInfo {
  const out: HeCollectInfo = { ...info };
  if (Array.isArray(info.tasks)) {
    out.tasks = info.tasks.map((task) => {
      if (!task || typeof task !== 'object' || !('harvest' in task)) return task;
      const { harvest: _harvest, ...rest } = task;
      return rest;
    });
  }
  const gate = info.relevance_gate;
  if (gate && Array.isArray(gate.flagged_keys) && gate.flagged_keys.length > 0) {
    out.relevance_gate = { ...gate, flagged_keys: [] };
  }
  return out;
}

/* ─────────────────────────── Фаза PLAN ─────────────────────────── */

/**
 * ВХОД планировщика: всё, что читается из БД БЕСПЛАТНО, отдельно от платного
 * вызова модели.
 *
 * Разделение нужно переиспользованию плана: решение «брать сохранённый план или
 * платить за новый» принимается по хешу этого входа, то есть до вызова модели.
 * Порядок чтений и их ошибки не изменились — это те же самые первые строки
 * прежнего buildPlan, включая честный фейл на пустом пересечении с выбором
 * специалиста.
 */
interface HePlanInput {
  promptInput: SourcePlanPromptInput;
  /** Провенанс плана: по каким гипотезам он строится (для collect_info и UI). */
  usedHypotheses: Array<{ id: string; title: string; status: string | null }>;
  /** Хеш входа: пока совпадает, сохранённый план годен (catalogCursor). */
  planKey: string;
}

async function collectPlanInput(
  job: HeJob,
  ctx: HeStageContext,
  vertical: HeVertical,
  market: HeMarket,
): Promise<HePlanInput> {
  // Гипотезы вертикали для плана. Семантика разметки: если специалист что-то
  // ПРИНЯЛ (accepted) — план строим только по принятым; предложенные (proposed)
  // идут в работу, только когда принятых нет (как в пересчёте % вертикали).
  const { data: hypRows, error: hError } = await ctx.supabase
    .from('he_hypotheses')
    .select('id, title, description, tier, status')
    .eq('project_id', job.project_id)
    .eq('vertical_id', vertical.id)
    .neq('status', 'rejected')
    .order('potential_pct', { ascending: false });
  if (hError) throw new Error(`he_hypotheses read: ${hError.message}`);
  let hypotheses = (hypRows ?? [])
    .map((r) => {
      const row = r as { id?: unknown; title?: unknown; description?: unknown; tier?: unknown; status?: unknown };
      return {
        id: typeof row.id === 'string' ? row.id : '',
        title: typeof row.title === 'string' ? row.title : '',
        description: typeof row.description === 'string' ? row.description : null,
        tier: typeof row.tier === 'number' ? row.tier : null,
        status: typeof row.status === 'string' ? row.status : null,
      };
    })
    .filter((h) => h.title);

  // Выбор гипотез из UI (route кладёт hypothesis_ids в payload джобы):
  // непустой массив → план строим только по выбранным (пересечение с
  // неотклонёнными — выборка выше уже отрезала rejected, даже если пользователь
  // их отметил). Пустое пересечение — честный фейл вместо молчаливого сбора
  // по всем гипотезам («я же выбирал одну гипотезу»).
  const wantedHypothesisIds = payloadStringArray(job, 'hypothesis_ids');
  if (wantedHypothesisIds) {
    const wanted = new Set(wantedHypothesisIds);
    hypotheses = hypotheses.filter((h) => wanted.has(h.id));
    if (hypotheses.length === 0) {
      throw new Error('Выбранные гипотезы не найдены или все отклонены');
    }
  } else {
    // Без явного выбора — семантика разметки: есть принятые → только они.
    const accepted = hypotheses.filter((h) => h.status === 'accepted');
    if (accepted.length > 0) {
      stageLog(ctx, `[base_collect] план только по принятым гипотезам: ${accepted.length} из ${hypotheses.length}`);
      hypotheses = accepted;
    }
  }

  // Типы компаний из последнего вокабуляра; вокабуляра может не быть — идём без него.
  let companyTypes: string[] = [];
  const { data: vocabRow, error: vocabError } = await ctx.supabase
    .from('he_vocab')
    .select('company_types')
    .eq('vertical_id', vertical.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (vocabError) {
    stageLog(ctx, `[base_collect] he_vocab read: ${vocabError.message} — продолжаем без типов компаний`);
  } else if (Array.isArray(vocabRow?.company_types)) {
    companyTypes = (vocabRow.company_types as Array<{ term?: unknown }>)
      .map((t) => (typeof t?.term === 'string' ? t.term : ''))
      .filter(Boolean);
  }

  // Гипотезы СУЖАЕМ до полей, которые промпт печатает (tier/title/description).
  // Тип объявлен явно, чтобы лишнее поле нельзя было добавить молча: из этого
  // объекта считается planKey, и `id`/`status` в хеше обнуляли бы
  // переиспользование плана на правке, которой модель не видит, — специалист
  // принял все предложенные гипотезы, текст промпта тот же, а ночь платит за
  // новый план и новую пробу среза (см. heCatalogPlanKey в catalogCursor.ts).
  const promptInput: SourcePlanPromptInput = {
    verticalName: vertical.name,
    verticalSummary: vertical.summary,
    synonyms: Array.isArray(vertical.synonyms) ? vertical.synonyms : [],
    hypotheses: hypotheses.map((h) => ({ title: h.title, description: h.description, tier: h.tier })),
    companyTypes,
  };

  return {
    promptInput,
    // Провенанс плана: по каким гипотезам реально строили (для collect_info и UI —
    // иначе на вопрос «точно всё верно?» ответа нет ни в БД, ни на экране).
    usedHypotheses: hypotheses.map((h) => ({ id: h.id, title: h.title, status: h.status })),
    planKey: heCatalogPlanKey(market, promptInput),
  };
}

/* ───────────── Придуманный порог размера (market='us') ───────────── */

/**
 * Планировщик любит дописать в срез порог, которого гипотезы не просили:
 * `sizes: ['51-200','201-500']` у pdl или `min_funding_usd: 5000000` у funded.
 * Замер V2 22.09.2026: на реестровом аналоге порог срезал 72% рынка (ОКВЭД 10.1,
 * 3389 компаний без порогов против 954 с ними), при том что о размере в тексте
 * гипотезы не было ни слова.
 *
 * ПОСЛЕДСТВИЕ В ENG ДРУГОЕ, и это главное. В V2 такая база встаёт с пометкой
 * «исчерпан» — то есть о проблеме хотя бы видно. Здесь видно НЕ будет: разбор
 * нулевой сборки (segmentExhausted) требует нулевой выдачи, а выдача есть.
 * База просто молча малая, и ни одна пометка, ни один текст кабинета об этом не
 * скажет.
 *
 * ПРАВИЛО: порог, у которого нет основания ВО ВХОДЕ ПЛАНИРОВЩИКА, снимается.
 * Основание ищем ровно в том тексте, который видела модель
 * (SourcePlanPromptInput: вертикаль, её описание, синонимы, гипотезы, типы
 * компаний из вокабуляра) — если размер не назван нигде там, назвать его могла
 * только сама модель.
 *
 * Оснований ДВА, потому что это два разных утверждения:
 *  - размер (`sizes`) — назван штат, класс размера или счётные единицы, ЛИБО
 *    названа величина денег («компании с $50M ARR» — тоже про размер);
 *  - величина денег (`min_funding_usd`) — названа именно СУММА, стадия раунда
 *    или оборот. Слов «funded»/«raised»/«recently funded» БЕЗ величины не
 *    хватает: они обосновывают выбор источника funded и окно `funded_since`, но
 *    не нижнюю границу в долларах. Ровно эта граница и оказывается придуманной.
 *
 * ГРАНИЦЫ. Только market='us' (RU-план задач pdl/funded не содержит вовсе).
 * Порог НЕ снимается, если после снятия в фильтрах не осталось ни индустрии, ни
 * имени: схемы требуют минимум один фильтр, и снятие единственного дало бы `{}`,
 * то есть нефильтрованный срез каталога (~19.5M строк) на весь лимит сборки.
 * Окна свежести (`funded_since`, `posted_within_days`) не трогаются: это не
 * пороги размера.
 *
 * Читатель решения — лог стадии (его читает специалист). Своего поля в
 * collect_info у правила нет нарочно: клиентская проекция такие поля не
 * пропускает (белый список), а данные, которых никто не читает, движок уже
 * заводил.
 */

/** Ноун, к которому может прилипнуть прилагательное размера. */
const HE_SIZED_NOUN_EN =
  'business(?:es)?|compan(?:y|ies)|firms?|brands?|chains?|agenc(?:y|ies)|operators?|manufacturers?|' +
  'clinics?|practices?|teams?|organi[sz]ations?|employers?|retailers?|providers?|players?|shops?|' +
  'studios?|vendors?|enterprises?|groups?|start-?ups?|networks?|clients?|accounts?';

/** Размер компании назван прямым текстом. */
const HE_SIZE_BASIS_EN: RegExp[] = [
  // Штат и его синонимы.
  /\b(?:headcount|employees?|fte|ftes|workforce|payroll|staff|seats?)\b/i,
  /\bteam\s+(?:size|of\s+\d)/i,
  // Класс размера как термин.
  /\b(?:smb|smbs|sme|smes|mid-?market|enterprise|enterprises|start-?ups?|scale-?ups?|unicorns?|growth-?stage|early-?stage|late-?stage|fortune\s*\d+)\b/i,
  // Прилагательное размера РЯДОМ с компанией. Отдельно от списка выше нарочно:
  // «large volume of tickets» о размере компании не говорит, «large
  // manufacturers» говорит.
  new RegExp(
    '\\b(?:small|smaller|medium|mid-?sized?|midsized?|large|larger|big|bigger|micro|tiny|boutique|' +
      'size?able|multi-?(?:unit|location|site))\\s+(?:[a-z-]+\\s+){0,2}(?:' +
      HE_SIZED_NOUN_EN +
      ')\\b',
    'i',
  ),
  // Открытая граница и счётные единицы: «200+ locations», «over 50 agents».
  /\d\s*\+/,
  /\b(?:over|under|above|below|at\s+least|more\s+than|fewer\s+than|less\s+than|up\s+to|between|from)\s+\$?\d/i,
  /\d[\d,\s]*(?:\s*(?:to|[–—-])\s*\d[\d,]*)?\s*(?:employees|people|staff|seats|locations|stores|branches|offices|beds|chairs|trucks|vehicles|agents|clinics|sites|units|outlets|reps|recruiters|technicians)\b/i,
];

/** Величина денег названа: сумма, стадия раунда, оборот. */
const HE_AMOUNT_BASIS_EN: RegExp[] = [
  /\$\s*\d/,
  /\b\d+(?:[.,]\d+)?\s*(?:k|m|mm|bn|b)\b/i,
  /\b(?:millions?|billions?|arr|mrr|revenue|turnover|valuation|unicorns?)\b/i,
  /\bseries\s+[a-h]\b/i,
  /\b(?:pre-?seed|seed|well[-\s]funded|heavily[-\s]funded|mega-?rounds?|large\s+rounds?)\b/i,
];

interface HeSizeBasis {
  /** Размер компании назван (штат, класс, счётные единицы или деньги). */
  size: boolean;
  /** Названа величина денег — только она обосновывает нижнюю границу суммы. */
  amount: boolean;
}

/** Ровно тот текст, который видел планировщик, — ничего сверх него. */
function heSizeBasisEn(input: SourcePlanPromptInput): HeSizeBasis {
  const text = [
    input.verticalName,
    input.verticalSummary ?? '',
    ...(input.synonyms ?? []),
    ...input.hypotheses.map((h) => `${h.title} ${h.description ?? ''}`),
    ...(input.companyTypes ?? []),
  ].join('\n');
  const amount = HE_AMOUNT_BASIS_EN.some((re) => re.test(text));
  return { size: amount || HE_SIZE_BASIS_EN.some((re) => re.test(text)), amount };
}

/** Фильтр заполнен: непустой массив, непустая строка или число. */
function heFilterFilled(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Задача без придуманного порога. `dropped` — что снято, `kept` — что оставлено
 * только потому, что без него срез потерял бы «про кого»; вызывающий кладёт оба
 * в лог стадии.
 */
function heTaskWithoutUnfoundedSize(
  task: HeCollectTask,
  basis: HeSizeBasis,
): { task: HeCollectTask; dropped: string[]; kept: string[] } {
  const none = { task, dropped: [], kept: [] };
  if (task.source === 'pdl') {
    const filters = task.pdl_filters;
    if (basis.size || !filters || !HE_PDL_SIZE_FILTER_KEYS.some((k) => heFilterFilled(filters[k]))) return none;
    const rest = { ...filters };
    for (const key of HE_PDL_SIZE_FILTER_KEYS) delete rest[key];
    if (!HE_PDL_SCOPE_FILTER_KEYS.some((k) => heFilterFilled(rest[k]))) {
      return { task, dropped: [], kept: [...HE_PDL_SIZE_FILTER_KEYS] };
    }
    return { task: { ...task, pdl_filters: rest }, dropped: [...HE_PDL_SIZE_FILTER_KEYS], kept: [] };
  }
  if (task.source === 'funded') {
    const filters = task.funded_filters;
    if (basis.amount || !filters || !HE_FUNDED_SIZE_FILTER_KEYS.some((k) => heFilterFilled(filters[k]))) return none;
    const rest = { ...filters };
    for (const key of HE_FUNDED_SIZE_FILTER_KEYS) delete rest[key];
    if (!HE_FUNDED_SCOPE_FILTER_KEYS.some((k) => heFilterFilled(rest[k]))) {
      return { task, dropped: [], kept: [...HE_FUNDED_SIZE_FILTER_KEYS] };
    }
    return { task: { ...task, funded_filters: rest }, dropped: [...HE_FUNDED_SIZE_FILTER_KEYS], kept: [] };
  }
  return none;
}

/**
 * Снять придуманные пороги с набора задач. Вызывается на ВСЕХ трёх местах, где
 * ENG-план рождается: свежий план планировщика, добавленный каталожный срез
 * (ensureCatalogSource) и перепланированный срез (ensureSliceMatchesVertical).
 * Иначе правило обходилось бы ровно тем вызовом, который и придумывает фильтры
 * с нуля.
 */
function heWithoutUnfoundedSizeFilters(
  ctx: HeStageContext,
  tasks: HeCollectTask[],
  promptInput: SourcePlanPromptInput,
): HeCollectTask[] {
  const basis = heSizeBasisEn(promptInput);
  return tasks.map((task) => {
    const res = heTaskWithoutUnfoundedSize(task, basis);
    // Тексты разные по источнику нарочно: у pdl порог — это штат, у funded —
    // сумма, и «размер не назван» про сумму было бы неправдой о том, что мы
    // проверяли. Скоуп у funded тоже один (индустрия), ключа `name` там нет.
    const missing = task.source === 'funded' ? 'сумму раунда или оборот' : 'размер компании';
    const scope = task.source === 'funded' ? 'индустрии' : 'ни индустрии, ни имени';
    if (res.dropped.length > 0) {
      stageLog(
        ctx,
        `[base_collect] ${task.source}: порог без основания снят (${res.dropped.join(', ')}) — ` +
          `ни гипотезы, ни описание вертикали, ни вокабуляр не называют ${missing}`,
      );
    }
    if (res.kept.length > 0) {
      stageLog(
        ctx,
        `[base_collect] ${task.source}: порог ${res.kept.join(', ')} оставлен, хотя основания нет — ` +
          `без него в фильтрах не осталось бы ${scope}, то есть срез стал бы всем каталогом`,
      );
    }
    return res.task;
  });
}

/* ───────────── Расширение среза, когда план кончился раньше цели ───────────── */

/**
 * ЧТО ЭТО. Каталожная задача дочитала свой срез до конца (`exhausted`), а
 * строк набрала меньше, чем просили. Вместо того чтобы отдать тонкую базу,
 * перечитываем ТОТ ЖЕ срез с ослабленным порогом размера: сначала «порог или
 * пустое поле», потом без порога вовсе.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. «Движок останавливается» — это про V2, а не про
 * ENG: у V1 один линейный проход и ни одного статуса вроде
 * `exhausted`/`limited` у БАЗЫ, останавливаться нечему. Единственное, что у
 * ENG действительно случалось, — ночь, читавшая срез с первой строки; это
 * закрыла закладка каталога (catalogCursor.ts). Поэтому лестница ниже — про
 * ЦЕЛЬ, а не про застревание.
 *
 * ЛЕСТНИЦА — РОВНО ТРИ СТУПЕНИ, И КАЖДАЯ СЛЕДУЮЩАЯ НАДМНОЖЕСТВО ПРЕДЫДУЩЕЙ.
 *  0. Срез как спланирован: `sizes` у pdl / `min_funding_usd` у funded стоят.
 *  1. ПОРОГ ИЛИ ПУСТОЕ ПОЛЕ. Порог остаётся утверждением о компаниях, чей
 *     размер каталогу ИЗВЕСТЕН; строка с пустым полем — не «компания ниже
 *     порога», а «размер неизвестен», и выбрасывать её значит фильтровать по
 *     полноте данных поставщика, а не по цели. Ровно это правило у V2
 *     (`veDirectorySizeKeep`): в реестре штат не заполнен у 42% строк.
 *  2. ПОРОГА НЕТ ВОВСЕ. Здесь мы уже отказываемся от утверждения гипотезы о
 *     размере — поэтому это последняя ступень, а не первая.
 *
 * ЧТО ОСТАНАВЛИВАЕТ ПОСЛЕДОВАТЕЛЬНОСТЬ (полный список, а не те случаи, что
 * пишет код ступени):
 *  - у задачи нет порога вовсе (`heWidenThreshold` → null): лестница ПУСТА,
 *    и это самый частый случай — у `eng_hiring` порога размера нет ни одного,
 *    у pdl без `sizes` и у funded без `min_funding_usd` тоже. Такой задаче
 *    бесплатные ступени не помогут ничем, и честнее сказать это вслух, чем
 *    изображать лестницу;
 *  - набран `limit` — расширять больше нечего;
 *  - ступень вышла НЕ исчерпанной (набрала свой остаток или встала по
 *    потолку страниц): в срезе ещё есть строки, и следующая ночь продолжит
 *    его с закладки — ослаблять порог раньше времени значило бы смешать в
 *    базу компании, до которых очередь ещё не дошла;
 *  - чтение оборвалось (`error`): «строк нет» у оборванного чтения означает
 *    «не дочитали», а не «кончились»;
 *  - ступень 2 пройдена — дальше ослаблять нечего.
 *
 * ЦЕНА. Расширение НЕ увеличивает счёт сборки: гейт релевантности и
 * конструктор платят за `merged`, а `merged = kept.slice(0, limit)` —
 * тот же кап, что и у полной базы. Расширение приближает счёт к счёту
 * ПОЛНОЙ базы, то есть к потолку, который существовал и до него; сверх
 * потолка оно не платит ничего. Платит оно чтениями каталога, и их ограничивает
 * тот же ENG_CATALOG_MAX_PAGES на КАЖДУЮ ступень.
 *
 * ПО УМОЛЧАНИЮ ВЫКЛЮЧЕНО, и это не осторожность ради осторожности. Ослабление
 * ОБОСНОВАННОГО порога («small businesses» в гипотезе) — продуктовое решение:
 * счёт от него не растёт, а точность падает, и платит за неё отклик, который у
 * ENG не измерен ни разу (`he_auto_pipeline_configs` пуст, ночной добор в
 * проде не запускался). Поэтому флаг, и поэтому же выключенный код НЕ МОЛЧИТ:
 * место, где лестница сработала бы, пишется в лог стадии вместе с недобором —
 * это и есть замер, которого не хватает, чтобы флаг включить осознанно.
 */

/** Потолок задач плана — тот же, что в HeSourcePlanSchema (`.max(4)`). */
const HE_PLAN_MAX_TASKS = 4;

/** Режим расширения: off — как раньше; free — две бесплатные ступени; replan — плюс один платный срез. */
type HeWidenMode = 'off' | 'free' | 'replan';
/** Ступень лестницы: 0 — как спланировано, 1 — «порог или пусто», 2 — без порога. */
type HeWidenLevel = 0 | 1 | 2;
const HE_WIDEN_MAX_LEVEL: HeWidenLevel = 2;

/**
 * Значение `HE_COLLECT_WIDEN`. Нераспознанное значение — это `off`, но СО
 * СТРОКОЙ В ЛОГЕ: беззвучное выключение механизма опечаткой в переменной
 * окружения уже стоило движку одного мёртвого пути (пороги пробы среза
 * `sliceProbe.ts`), и повторять его здесь нельзя.
 */
function heWidenMode(ctx: HeStageContext): HeWidenMode {
  const raw = (process.env.HE_COLLECT_WIDEN || '').trim().toLowerCase();
  if (!raw || raw === 'off' || raw === '0' || raw === 'false') return 'off';
  if (raw === 'free' || raw === 'replan') return raw;
  stageLog(
    ctx,
    `[base_collect] HE_COLLECT_WIDEN='${raw.slice(0, 32)}' не распознано — расширение среза выключено ` +
      '(допустимы off / free / replan)',
  );
  return 'off';
}

/**
 * Порог размера, который у задачи вообще можно ослабить, — иначе null и
 * лестницы у задачи нет. У `eng_hiring` порога размера нет по устройству:
 * `posted_within_days` — окно свежести, и ослабление окна превратило бы
 * «мы видим, что вы нанимаете» в неправду (вакансия давно закрыта).
 *
 * ВТОРОЕ УСЛОВИЕ, и без него лестница ломает то, что защищает правило порогов:
 * ослаблять порог можно, только если срез СУЖАЕТ что-то ещё. Тот же тест уже
 * стоит выше, в heTaskWithoutUnfoundedSize: он ОТКАЗЫВАЕТСЯ снимать порог без
 * основания, когда после снятия не остаётся ни индустрии, ни имени, и пишет в
 * лог «срез стал бы всем каталогом». Лестница без этой проверки отменяла бы
 * тот отказ обходным путём — на втором шаге она посылает порог пустым, и
 * получается ровно тот нефильтрованный каталог. Обратите внимание, что
 * `countries` в набор сужающих ключей НЕ входит намеренно: страна — это
 * рынок, а не срез рынка.
 */
function heWidenThreshold(task: HeCollectTask): 'sizes' | 'min_funding_usd' | null {
  if (task.source === 'pdl') {
    if (!task.pdl_filters?.sizes?.length) return null;
    const rest = { ...task.pdl_filters, sizes: undefined };
    return HE_PDL_SCOPE_FILTER_KEYS.some((k) => heFilterFilled(rest[k])) ? 'sizes' : null;
  }
  if (task.source === 'funded') {
    const min = task.funded_filters?.min_funding_usd;
    if (!(typeof min === 'number' && Number.isFinite(min) && min > 0)) return null;
    const rest = { ...task.funded_filters, min_funding_usd: undefined };
    return HE_FUNDED_SCOPE_FILTER_KEYS.some((k) => heFilterFilled(rest[k]))
      ? 'min_funding_usd'
      : null;
  }
  return null;
}

/** Размер строки каталога проходит ослабленный порог: он в наборе ЛИБО не заполнен. */
function heSizeOrEmpty(sizes: ReadonlySet<string>, value: unknown): boolean {
  const size = cell(value).toLowerCase();
  return size === '' || sizes.has(size);
}

/**
 * ПЛАТНАЯ часть планирования: вызов модели + починка «нет каталога» + проба
 * среза. Вход уже прочитан (collectPlanInput), поэтому эта функция ничего из БД
 * не читает и вызывается ТОЛЬКО когда сохранённый план взять нельзя.
 */
async function buildPlan(
  ctx: HeStageContext,
  vertical: HeVertical,
  input: HePlanInput,
  usage: HeUsage,
  market: HeMarket,
): Promise<{
  plan: HeSourcePlan;
  planRepair?: HePlanRepair;
  sliceProbe?: HeSliceProbe;
}> {
  const { promptInput } = input;

  const llm = await callLLMWithSchema(
    // Рынок 'us' — EN-промпт с ENG-источниками (pdl/funded/eng_hiring/google_maps).
    (market === 'us' ? buildSourcePlanMessagesEn : buildSourcePlanMessages)(promptInput),
    HeSourcePlanSchema,
    { model: getHeModel('bulk') },
  );
  addUsage(usage, llm);

  // Придуманные пороги размера снимаем ДО починки и ДО пробы среза: и та, и
  // другая должны смотреть ровно тот срез, который пойдёт в сбор.
  const planned: HeSourcePlan =
    market === 'us'
      ? { ...llm.data, tasks: heWithoutUnfoundedSizeFilters(ctx, llm.data.tasks, promptInput) }
      : llm.data;

  const withCatalog = await ensureCatalogSource(ctx, planned, promptInput, usage, market);
  // Проба идёт ПОСЛЕ починки «каталога нет вовсе»: чинить нечего, пока задачи
  // не существует, а добавленный срез проверяется на общих основаниях.
  const { plan, sliceProbe } = await ensureSliceMatchesVertical(
    ctx,
    withCatalog.plan,
    vertical,
    promptInput,
    usage,
    market,
  );
  return { plan, planRepair: withCatalog.planRepair, sliceProbe };
}

/**
 * ENG-план без каталожного источника (pdl/funded) — потолок сборки в пару
 * десятков строк: eng_hiring и google_maps дают единицы компаний. Планировщик
 * сваливается в такой план не случайно: у вертикали может не быть индустрии в
 * каталоге (у «Franchise Brands» её нет — франчайзинг не отраслевая метка
 * LinkedIn), и модель просто пропускает pdl. Итог 12.08: база на 6 строк при
 * лимите 2000.
 *
 * Починка: один дополнительный вызов модели, который отвечает ТОЛЬКО за фильтры
 * pdl-среза (source ставит код). Модель выбирает между industries и name —
 * name-подстрока и вытаскивает бизнес-модели, у которых нет индустрии
 * («franchise» → 1279 компаний США в каталоге).
 *
 * Границы: только market='us' (у RU-плана каталог — companies_directory со
 * своей семантикой), только когда каталожной задачи НЕТ вовсе. Провал починки
 * не роняет сбор: план уходит как есть, а причина ложится в collect_info —
 * тонкая база должна быть объяснимой, а не молчаливой.
 */
async function ensureCatalogSource(
  ctx: HeStageContext,
  plan: HeSourcePlan,
  promptInput: SourcePlanPromptInput,
  usage: HeUsage,
  market: HeMarket,
): Promise<{ plan: HeSourcePlan; planRepair?: HePlanRepair }> {
  if (market !== 'us') return { plan };
  if (plan.tasks.some((t) => t.source === 'pdl' || t.source === 'funded')) return { plan };

  let repair;
  try {
    repair = await callLLMWithSchema(buildCatalogRepairMessagesEn(promptInput), HeCatalogRepairSchema, {
      model: getHeModel('bulk'),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    stageLog(ctx, `[base_collect] починка плана (нет каталога) не удалась: ${message}`);
    return { plan, planRepair: { reason: 'no_catalog_source', outcome: 'failed', error: message } };
  }
  addUsage(usage, repair);

  // Починка отвечает ТОЛЬКО за фильтры, то есть придумывает их с нуля, — и тот
  // же порог без основания она ставит так же охотно. Провенанс и лог ниже
  // печатают фильтры ПОСЛЕ снятия: иначе staff читал бы срез, которого не было.
  const [task] = heWithoutUnfoundedSizeFilters(
    ctx,
    [{ source: 'pdl', rationale: repair.data.rationale, pdl_filters: repair.data.pdl_filters }],
    promptInput,
  );
  // Потолок плана — 4 задачи (HeSourcePlanSchema). Если модель уже выбрала
  // четыре, каталожный срез вытесняет последнюю: без каталога база всё равно
  // не наберёт объём, а порядок задач у планировщика — от важного к частному.
  const tasks =
    plan.tasks.length >= HE_PLAN_MAX_TASKS
      ? plan.tasks.slice(0, HE_PLAN_MAX_TASKS - 1)
      : plan.tasks.slice();
  tasks.push(task);
  stageLog(
    ctx,
    `[base_collect] в плане не было каталога — добавлен pdl-срез: ${JSON.stringify(task.pdl_filters)}`,
  );
  return {
    plan: { tasks },
    planRepair: { reason: 'no_catalog_source', outcome: 'repaired', pdl_filters: task.pdl_filters },
  };
}

/**
 * ВСЕ каталожные задачи плана. Именно все: боевой план 12.08 нёс ТРИ pdl-среза
 * с разными наборами индустрий, и проба только первого пропустила бы две трети
 * мусора — заменённый срез дал бы ~1300 целевых строк, а два оставшихся широких
 * добили бы кап 2000 нецелевыми.
 */
function findCatalogTasks(plan: HeSourcePlan): number[] {
  return plan.tasks
    .map((t, i) => (t.source === 'pdl' || t.source === 'funded' ? i : -1))
    .filter((i) => i >= 0);
}

/**
 * Выборка из среза одной задачи: те же коллекторы, только с крошечным лимитом.
 *
 * БЕЗ закладки и БЕЗ исключения чужих баз, и это не экономия: проба отвечает на
 * вопрос «этот СРЕЗ про эту вертикаль?», то есть обязана смотреть срез как он
 * есть. Продолжение с закладки дало бы выборку из середины, а вычет уже
 * собранных компаний — из остатка; и то и другое меняет измеряемую величину.
 */
async function sampleCatalogSlice(
  ctx: HeStageContext,
  task: HeCollectTask,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  if (task.source === 'funded') {
    const { rows } = await fetchFundedRows(ctx, task.funded_filters, limit, null, null);
    return rows.map((r) => mapFundedRow(r) as unknown as Record<string, unknown>);
  }
  const { rows } = await fetchPdlRows(ctx, task.pdl_filters, limit, null, null);
  return rows.map((r) => mapPdlRow(r) as unknown as Record<string, unknown>);
}

/**
 * Общая выборка каталожной части плана: поровну из каждого среза (проба меряет
 * «каталожную часть» целиком — решение принимается по ней одной, см. ниже).
 */
async function sampleCatalogTasks(
  ctx: HeStageContext,
  tasks: HeCollectTask[],
): Promise<Array<Record<string, unknown>>> {
  const quota = Math.max(1, Math.ceil(sliceProbeSample() / tasks.length));
  const parts: Array<Record<string, unknown>> = [];
  for (const task of tasks) {
    parts.push(...(await sampleCatalogSlice(ctx, task, quota)));
  }
  return parts.slice(0, sliceProbeSample());
}

/**
 * Проба каталожного среза перед сбором — и право ОТКАЗАТЬСЯ строить базу.
 *
 * Проблема, которую это закрывает. Планировщик может выдать фирмографически
 * валидный срез, который к вертикали отношения не имеет. 12.08 под «Franchise
 * Brands» он взял consumer services + education management + restaurants +
 * health & wellness: 833 строки, 557 валидных почт, 67% — цифры неотличимы от
 * эталонной Healthcare, а в базе рестораны, школы и YMCA вместо франчайзеров.
 * Релевант-гейт это НЕ ловит по устройству (см. sliceProbe.ts).
 *
 * Механика: берём из среза выборку, спрашиваем модель с обратным дефолтом,
 * получаем долю попадания. Ниже порога — перепланируем каталожную задачу тем же
 * ремонтным вызовом, что и при полном отсутствии каталога (модель выбирает
 * между industries и name-подстрокой), и пробуем ещё раз. Если и после этого
 * ниже порога — базу НЕ строим.
 *
 * Почему отказ, а не «соберём что есть». Это автопилот: клиент вставляет ссылку
 * и дальше только читает ответы, промежуточную базу никто глазами не смотрит.
 * Пропущенная вертикаль честнее вертикали с мусором — плохой сегмент жжёт общие
 * домены отправки и репутацию, вредя тем вертикалям, которые работают.
 *
 * Never-reject на сбое: несостоявшаяся проба (sampled=0 — пустой срез или сбой
 * модели) НЕ отбраковывает срез, иначе блип LLM рубил бы рабочие вертикали.
 */
async function ensureSliceMatchesVertical(
  ctx: HeStageContext,
  plan: HeSourcePlan,
  vertical: HeVertical,
  promptInput: SourcePlanPromptInput,
  usage: HeUsage,
  market: HeMarket,
): Promise<{ plan: HeSourcePlan; sliceProbe?: HeSliceProbe }> {
  if (market !== 'us') return { plan };
  const catalogIdx = findCatalogTasks(plan);
  if (catalogIdx.length === 0) return { plan };

  const probe = async (tasks: HeCollectTask[]) => {
    const sample = await sampleCatalogTasks(ctx, tasks);
    const res = await probeSliceRelevance({
      rows: sample,
      verticalName: vertical.name,
      verticalSummary: vertical.summary ?? '',
      log: (m) => stageLog(ctx, m),
    });
    usage.tokensUsed += res.tokensUsed;
    usage.costUsd += res.costUsd;
    return res;
  };

  const first = await probe(catalogIdx.map((i) => plan.tasks[i]));
  const pct = (r: { hitRate: number }) => `${Math.round(r.hitRate * 100)}%`;
  // Проба не состоялась (пустой срез или сбой модели) — не мешаем сбору.
  if (first.sampled === 0) return { plan };
  // Оба порога по умолчанию 0 → условие ложно всегда: проба меряет и пишет
  // провенанс, но плана не трогает. Числа пробы боем не подтвердились
  // (калибровка 18.08, см. sliceProbe.ts), действовать на них нельзя.
  if (!(first.hitRate < sliceProbeRepairBelow())) {
    stageLog(ctx, `[base_collect] проба среза: ${pct(first)} по вертикали — собираем`);
    return {
      plan,
      sliceProbe: { outcome: 'passed', hit_rate: first.hitRate, sampled: first.sampled },
    };
  }

  stageLog(
    ctx,
    `[base_collect] проба среза: всего ${pct(first)} по вертикали (мимо: ${first.offTargetExamples.join(', ')}) — перепланируем каталог`,
  );

  let repair;
  try {
    repair = await callLLMWithSchema(buildCatalogRepairMessagesEn(promptInput), HeCatalogRepairSchema, {
      model: getHeModel('bulk'),
    });
  } catch (e) {
    // Перепланировать не вышло — идём с исходным срезом: он плох, но отказ
    // из-за сбоя модели был бы хуже. Причина остаётся в collect_info.
    const message = e instanceof Error ? e.message : String(e);
    stageLog(ctx, `[base_collect] перепланирование среза не удалось: ${message}`);
    return {
      plan,
      sliceProbe: {
        outcome: 'repair_failed',
        hit_rate: first.hitRate,
        sampled: first.sampled,
        off_target_examples: first.offTargetExamples,
        error: message,
      },
    };
  }
  addUsage(usage, repair);

  // Тот же ремонтный вызов — тот же придуманный порог; снимаем ДО второй пробы,
  // иначе проба мерила бы один срез, а сбор шёл по другому.
  const [retried] = heWithoutUnfoundedSizeFilters(
    ctx,
    [{ source: 'pdl', rationale: repair.data.rationale, pdl_filters: repair.data.pdl_filters }],
    promptInput,
  );
  const second = await probe([retried]);
  if (second.sampled > 0 && sliceProbeRejectBelow() > 0 && second.hitRate < sliceProbeRejectBelow()) {
    stageLog(
      ctx,
      `[base_collect] повторная проба: ${pct(second)} — вертикаль каталогом не покрывается, базу не строим`,
    );
    return {
      plan,
      sliceProbe: {
        outcome: 'rejected',
        hit_rate: second.hitRate,
        sampled: second.sampled,
        off_target_examples: second.offTargetExamples,
        first_hit_rate: first.hitRate,
        pdl_filters: retried.pdl_filters,
      },
    };
  }

  // Замена ВСЕЙ каталожной части плана одним выверенным срезом, а не только
  // первой задачи: остальные срезы — та же провалившая пробу семья широких
  // фильтров, оставить их значит добить кап сборки нецелевыми строками.
  // Repaired-срез встаёт на место первой каталожной задачи (порядок плана —
  // от важного к частному), остальные каталожные выбывают.
  const firstCatalogAt = catalogIdx[0];
  const tasks = plan.tasks
    .map((t, i) => (i === firstCatalogAt ? retried : t))
    .filter((t, i) => i === firstCatalogAt || !catalogIdx.includes(i));
  stageLog(
    ctx,
    `[base_collect] каталожная часть плана (${catalogIdx.length} задач) заменена одним срезом (${pct(first)} → ${pct(second)}): ${JSON.stringify(retried.pdl_filters)}`,
  );
  return {
    plan: { tasks },
    sliceProbe: {
      outcome: 'repaired',
      hit_rate: second.hitRate,
      sampled: second.sampled,
      first_hit_rate: first.hitRate,
      pdl_filters: retried.pdl_filters,
      replaced_tasks: catalogIdx.length,
    },
  };
}

/**
 * ПЛАТНАЯ ступень лестницы: все каталожные срезы дочитаны до конца, цель не
 * набрана — покупаем ЕЩЁ ОДИН pdl-срез, назвав модели те, что уже отработаны.
 *
 * ПОЧЕМУ НЕ «один вызов промпта починки». `buildCatalogRepairMessagesEn` чинит
 * план, в котором каталожной задачи НЕ БЫЛО вовсе, и не знает ни одного
 * прочитанного среза; полный планировщик V1 поля обратной связи не имеет вовсе.
 * По тому же входу оба вернули бы ровно тот срез, который только что дочитан, —
 * то есть купленный вызов не дал бы ни одной новой компании. Поэтому у
 * расширения свой EN-промпт со списком отработанного
 * (`buildCatalogWidenMessagesEn`), а RU-промпт плана не тронут ни одним байтом.
 *
 * Функция НЕ трогает `info.tasks`: добавленную задачу в список кладёт
 * вызывающий — у него на руках та же ссылка, и два писателя одного массива
 * разошлись бы на первой же правке.
 *
 * Провал (модель молчит либо вернула уже прочитанный срез) сборку не роняет:
 * план уходит как есть, факт оплаты ложится в `plan_widening`, и второй раз за
 * ту же сборку мы не платим.
 */
/**
 * Покупка расширения кончилась ничем. Отдельная функция, а не выражение на
 * месте: к моменту проверки компилятор уже сузил `info.plan_widening` по
 * условию входа в ветку (`!info.plan_widening`) и не знает, что
 * widenPlanWithPaidSlice поле проставила.
 */
function heWidenFailed(info: HeCollectInfo): boolean {
  return info.plan_widening?.outcome === 'failed';
}

async function widenPlanWithPaidSlice(
  ctx: HeStageContext,
  args: {
    info: HeCollectInfo;
    input: HePlanInput;
    catalogStates: HeCollectTaskState[];
    harvested: number;
    limit: number;
    usage: HeUsage;
  },
): Promise<HeCollectTaskState | null> {
  const { info, input, catalogStates, harvested, limit, usage } = args;
  const plan = info.plan;
  if (!plan) return null;
  const at = new Date().toISOString();
  const tried: HeTriedSlice[] = catalogStates.map((state) => ({
    source: state.source,
    filters:
      state.task.source === 'pdl'
        ? state.task.pdl_filters
        : state.task.source === 'funded'
          ? state.task.funded_filters
          : state.task.eng_hiring_query,
    rows: state.rows,
  }));

  let widened;
  try {
    widened = await callLLMWithSchema(
      buildCatalogWidenMessagesEn(input.promptInput, tried),
      HeCatalogRepairSchema,
      { model: getHeModel('bulk') },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    info.plan_widening = { outcome: 'failed', error: message.slice(0, 300), at };
    stageLog(ctx, `[base_collect] расширение плана не удалось: ${message}`);
    return null;
  }
  addUsage(usage, widened);

  // Срез придумывает модель — значит и порог без основания она ставит так же
  // охотно, как в починке «нет каталога». Снимаем ДО проверки на повтор:
  // сравнивать надо ровно тот срез, который пойдёт в сбор.
  const [task] = heWithoutUnfoundedSizeFilters(
    ctx,
    [{ source: 'pdl', rationale: widened.data.rationale, pdl_filters: widened.data.pdl_filters }],
    input.promptInput,
  );
  const key = heCatalogSliceKey(task);
  const known = new Set(
    plan.tasks.map((t) => heCatalogSliceKey(t)).filter((k): k is string => k !== null),
  );
  if (!key || known.has(key)) {
    info.plan_widening = { outcome: 'failed', error: 'модель вернула уже прочитанный срез', at };
    stageLog(
      ctx,
      '[base_collect] расширение плана: вернулся срез, который уже дочитан, — план не тронут',
    );
    return null;
  }

  plan.tasks.push(task);
  info.plan_widening = { outcome: 'added', pdl_filters: task.pdl_filters, at };
  stageLog(
    ctx,
    `[base_collect] все каталожные срезы дочитаны, взято ${harvested} строк из ${limit} — ` +
      `план расширен pdl-срезом: ${JSON.stringify(task.pdl_filters)}`,
  );
  return { source: task.source, status: 'pending', child_job_id: null, rows: 0, task };
}

/* ─────────────────────────── Фаза DISPATCH ─────────────────────────── */

/** Сколько ждём дочернюю джобу парсера, прежде чем считать её зависшей. */
const CHILD_TIMEOUT_MS = 3 * 60 * 60 * 1000;

async function insertChildJob(
  ctx: HeStageContext,
  table: string,
  row: Record<string, unknown>,
): Promise<string> {
  const { data, error } = await ctx.supabase.from(table).insert(row).select('id').single();
  if (error || !data) throw new Error(`${table} insert: ${error?.message ?? 'unknown'}`);
  return (data as { id: string }).id;
}

/**
 * Реестр постранично (страница = DIRECTORY_PAGE_SIZE) до limit НОВЫХ строк.
 * Каждая строка сверяется с excludedKeys — ключами компаний других баз
 * проекта (формат loadOtherBaseExclusionKeys: имя с ИНН-уточнением или
 * точный ИНН, см. matchesExclusion — как и на финальном мёрдже). Известные строки
 * пропускаются и НЕ считаются в limit, но offset двигается по ВСЕМ
 * просканированным — так повторная сборка того же сегмента перелистывает
 * уже собранное в других базах и добирает новое (продолжение сегментов,
 * не влезающих в один кап, >50k). Без этого вторая сборка скачивала те же
 * первые N строк и отбрасывала их на мёрдже — ~0 новых. Стоп: limit новых
 * строк, короткая страница (конец выдачи) или потолок MAX_DIRECTORY_PAGES.
 * exhausted=true — выдача кончилась (короткая страница) раньше limit:
 * сегмент под фильтры собран целиком, продолжать некуда. hitCeiling=true —
 * стоп по потолку страниц раньше limit: выдача ещё есть, это НЕ исчерпание
 * (иначе финальный разбор нулевой сборки врал «сегмент исчерпан» на простом
 * срабатывании предохранителя).
 */
async function fetchDirectoryRows(
  ctx: HeStageContext,
  filters: CompaniesSearchFilters,
  limit: number,
  excludedKeys: HeBaseExclusionKeys,
): Promise<{
  rows: Record<string, unknown>[];
  excludedDuringFetch: number;
  exhausted: boolean;
  hitCeiling: boolean;
  error?: string;
}> {
  const rows: Record<string, unknown>[] = [];
  let excludedDuringFetch = 0;
  let offset = 0;
  let page = 0;
  for (; page < MAX_DIRECTORY_PAGES && rows.length < limit; page += 1) {
    const res = await searchRows(filters, DIRECTORY_PAGE_SIZE, offset);
    if (res.error) {
      return { rows: [], excludedDuringFetch, exhausted: false, hitCeiling: false, error: res.error };
    }
    offset += res.rows.length;
    for (const r of res.rows) {
      // Дубль другой базы: по имени (с уточнением ИНН/доменом), точно по ИНН
      // или точно по собственному домену.
      if (matchesExclusion(excludedKeys, cell(r.name), r.inn, r.website)) {
        excludedDuringFetch += 1;
        continue;
      }
      // Новых строк на странице может быть больше остатка до limit — лишние
      // не берём (они не попадают ни в базу, ни в исключения и будут
      // подобраны следующей сборкой-продолжением).
      if (rows.length < limit) rows.push(r);
    }
    if (res.rows.length < DIRECTORY_PAGE_SIZE) break;
  }
  // Потолок: цикл вышел по числу страниц, а limit так и не набран — все
  // страницы были полными, выдача ещё есть. Это предохранитель, не конец
  // сегмента: exhausted остаётся false.
  const hitCeiling = rows.length < limit && page >= MAX_DIRECTORY_PAGES;
  const exhausted = rows.length < limit && !hitCeiling;
  if (excludedDuringFetch > 0) {
    stageLog(
      ctx,
      `[base_collect] реестр: ${excludedDuringFetch} строк пропущено на выборке — компании уже есть в других базах проекта`,
    );
  }
  return { rows, excludedDuringFetch, exhausted, hitCeiling };
}

/* ─────────────────────── ENG-источники: прямое чтение справочников ─────────────────────── */

/** Страница keyset-пагинации справочников pdl/funded (id — text PK). */
const ENG_CATALOG_PAGE_SIZE = 1000;
/**
 * Потолок страниц pdl/funded за задачу (60 × 1000 = 60k просмотренных строк) —
 * тот же предохранитель, что MAX_DIRECTORY_PAGES у реестра, и по той же
 * причине: с исключением уже собранных компаний НА ВЫБОРКЕ страница может не
 * дать ни одной новой строки, и цикл «пока не наберу limit» перестал быть
 * ограниченным сверху. До исключения-на-выборке потолок недостижим в принципе:
 * без пропусков limit набирается за ceil(limit / 1000) ≤ 50 страниц.
 */
const ENG_CATALOG_MAX_PAGES = 60;
/** Страница офсетной пагинации eng_hiring_cache. */
const ENG_HIRING_PAGE_SIZE = 1000;
/**
 * Потолок страниц eng_hiring_cache за задачу (20 × 1000). При активном
 * SQL-предфильтре роли (buildRolesIlikeFilter) страницы состоят из совпадений,
 * и цикл почти всегда останавливается раньше — по limit. Потолок остаётся
 * предохранителем для задач без предфильтра (b2b-расширение), где роль
 * по-прежнему отбирается только в JS.
 */
const ENG_HIRING_MAX_PAGES = 20;

/** Значения фильтров справочников хранятся в нижнем регистре — приводим и фильтр. */
function lowerList(values: string[]): string[] {
  return values.map((v) => v.trim().toLowerCase()).filter(Boolean);
}

/**
 * Каталог PDL (компании EU/US) keyset-пагинацией по id до limit строк.
 * Чтение — через RPC search_pdl_companies (миграция 20260812_0001): внутри
 * принудительный план «фильтр → сортировка», иначе плоский PostgREST-запрос
 * на широких фильтрах уходит pkey-scan'ом в 58s+ → 504 у Kong → задача
 * падала maintenance-страницей. Фильтры — серверные: industry/size/country
 * точным совпадением (значения в таблице в нижнем регистре), name — подстрокой
 * (ilike, как в /api/company-base). Компании других баз проекта исключаются
 * ещё НА ВЫБОРКЕ (как у реестра) — см. общий блок про закладку ниже; на мёрдже
 * исключение остаётся страховкой.
 */

/**
 * Паузы перед повторными чтениями страницы каталога (по одной на попытку, всего
 * попыток = длина + 1). Дефолт покрывает две разные причины отказа:
 *  - блип/рестарт Kong — лечится первой короткой паузой;
 *  - ХОЛОДНЫЙ КЭШ pdl_companies (19.5M строк) — первое касание нового среза
 *    читает страницы с диска и стоит десятки секунд, шлюз успевает отдать 504
 *    раньше. Замер 12.08: один и тот же срез 209с на первом прогоне и 1.1с на
 *    повторном; узкий срез — 45с на первом касании. Ключевое: неудавшаяся
 *    попытка не пропадает зря — она прогревает кэш, поэтому паузы растут, а не
 *    повторяют одну и ту же трёхсекундную (на ней сборка Franchise Brands
 *    12.08 и легла: pdl упал, база вышла на 7 строк).
 * Переопределяется `HE_PDL_READ_RETRY_DELAYS_MS` (мс через запятую) — читается
 * на каждом вызове, чтобы тесты не ждали реальные минуты.
 */
const PDL_READ_RETRY_DELAYS_DEFAULT = '3000,20000,60000';

function pdlReadRetryDelays(): number[] {
  return (process.env.HE_PDL_READ_RETRY_DELAYS_MS || PDL_READ_RETRY_DELAYS_DEFAULT)
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v) && v >= 0);
}

/** Ошибки чтения: HTML maintenance-страницы Kong (504/рестарт) — не в error задачи. */
function cleanPdlReadError(message: string): string {
  if (message.includes('<html') || message.includes('<!doctype')) {
    return 'pdl_companies read: non-JSON response (gateway timeout/restart)';
  }
  return `pdl_companies read: ${message}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Повторы ФИНАЛЬНОЙ записи базы при блипе БД (паузы 1с → 2с, всего ≤3 с). Это
 * повтор ЗАПРОСА, адресованного по id и идемпотентного, а не стадии: к этому
 * месту уже оплачены план, коллекторы, конструктор и релевант-гейт.
 */
const HARVEST_WRITE_ATTEMPTS = 3;
const HARVEST_WRITE_RETRY_BASE_MS = 1000;

/**
 * ЧТЕНИЕ КАТАЛОГА С ЗАКЛАДКОЙ — общая механика трёх ENG-источников.
 *
 * Включается ровно для market='us' (`slot !== null`): у RU-плана каталог — это
 * реестр со своей закладкой, и ни один байт его пути отсюда не меняется.
 *
 * ЧТО ИМЕННО ДЕЛАЕТ ЗАКЛАДКА. Каждая ночь добора заводит НОВУЮ he_bases с
 * пустым collect_info, поэтому раньше каждая ночь читала срез с первой строки,
 * набирала те же компании и выбрасывала их на мёрдже. Теперь компании других
 * баз проекта отсеиваются ЕЩЁ НА ВЫБОРКЕ (и не тратят limit, как у реестра), а
 * место, до которого срез разобран, переживает базу — стор `he_catalog_cursors`
 * (см. шапку lib/hypothesisEngine/catalogCursor.ts).
 *
 * КУДА ИМЕННО ДВИГАЕТСЯ ЗАКЛАДКА — самое важное правило этого файла.
 * Она отмечает конец ПРЕФИКСА РАЗОБРАННЫХ И ЗАКРЫТЫХ строк: подряд идущих
 * строк, с которыми у проекта покончено, — тех, что уже лежат в другой базе
 * этого проекта, и тех, у кого пустое имя компании (такая строка всё равно
 * не переживёт дедуп на HARVEST). НЕсовпадение роли у eng_hiring в этот
 * список НЕ входит: строки того источника переписываются ингестом на месте,
 * и вчерашний «не тот» заголовок завтра может стать тем самым.
 * «Закрыто навсегда» про пустое имя честно: имя строки не меняется от того,
 * какой у нас срез, а условия среза входят в ключ закладки (хеш фильтров) —
 * поменяются они, сменится ключ, и закладка будет своя.
 * На ПЕРВОЙ ЖЕ строке, которую сборка забрала себе, префикс закрывается, и
 * дальше закладка не идёт, сколько бы строк ни было прочитано после неё.
 *
 * Почему не «по всем прочитанным строкам», как просится. Каждая задача плана
 * читает до `limit` строк, а мёрдж оставляет `limit` строк НА ВСЕ задачи
 * (interleaveTaskHarvests + slice) — то есть из прочитанного в базу уезжает
 * примерно 1/N. Закладка «по прочитанному» перешагивала бы остальные 1−1/N
 * НАВСЕГДА: срез объявлялся бы исчерпанным, когда до клиента доехала треть
 * его компаний, и обещание кабинета «в этих источниках больше нет новых
 * компаний» стало бы ложью. Закладка по закрытому префиксу такого не делает:
 * недоставленные строки читаются ещё раз следующей ночью, а как только они
 * доезжают до базы — становятся исключением и префикс проходит их сам.
 *
 * Отсюда же и сходимость: перечитанный кусок — это ровно недоставленный хвост
 * прошлой ночи (единицы страниц), а не срез с начала. Хвост может и не
 * рассосаться — компания попала в мёрдж, но в базу не доехала (её выбросил
 * конструктор, или базу увели в 'failed'), — и тогда закладка стоит на месте.
 * Это НЕ потеря: срез читается как до этой правки, от той же строки, а сверху
 * лежит потолок страниц, который такой скан ограничивает и помечает задачу
 * `hit_ceiling`, чтобы разбор нулевой сборки не назвал предохранитель
 * исчерпанием.
 *
 * ОБРЫВ ВЫДАЧИ НЕ ВЫБРАСЫВАЕТ РАЗОБРАННОЕ. Отказ страницы раньше уносил всю
 * задачу вместе с уже разобранными страницами (прод 21.09 у реестра V2: 400
 * компаний и 10 590 просмотренных строк). Здесь чтение возвращает префикс
 * вместе с его закладкой, а падает задача только когда фиксировать нечего —
 * ни одной строки и ни одного сдвига.
 */

/** Итог чтения каталога: разобранный префикс строк и куда встала закладка. */
interface HeCatalogFetch {
  rows: Record<string, unknown>[];
  /** Строк пропущено на выборке — компании уже есть в других базах проекта. */
  excludedDuringFetch: number;
  /**
   * Выдача КОНЧИЛАСЬ: цикл вышел на КОРОТКОЙ странице, то есть источник отдал
   * всё, что у него есть за закладкой под фильтры этого среза.
   *
   * Считается по причине выхода, а НЕ по «строк меньше limit»: выходов у
   * цикла пять, и недобор дают четыре из них — короткая страница (это и есть
   * исчерпание), потолок страниц (`hitCeiling`), обрыв страницы (`error`) и
   * невозможность построить курсор с хвоста полной страницы (строка без id /
   * без времени вставки). Три последних оставляют выдачу на месте, и назвать
   * их исчерпанием значит соврать. Пятый выход — набран limit — недобора не
   * даёт и исчерпанием тоже не является: хвост короткой страницы мог остаться
   * неразобранным.
   */
  exhausted: boolean;
  /**
   * Стоп по потолку страниц раньше limit: выдача ещё есть, это предохранитель,
   * а НЕ исчерпание среза (иначе разбор нулевой сборки сказал бы клиенту
   * «новых компаний не осталось» на простом срабатывании предохранителя).
   */
  hitCeiling: boolean;
  /**
   * Закладка после захода. Та же, что пришла, если закрытого префикса не
   * случилось; null — market не 'us' либо закладки не было и не появилось.
   */
  next: HeCatalogBookmark | null;
  /** Чтение оборвалось; rows — разобранный до обрыва префикс. */
  error?: string;
}

/**
 * Значение фильтра PostgREST в кавычках: id каталогов (`yc:xyz`,
 * `sec_formd:0001`) и метки времени содержат символы, которые внутри `or=(...)`
 * разбираются как синтаксис. Без кавычек запятая в id развалила бы условие
 * keyset'а на два — и страница вернулась бы не та.
 */
function pgFilterValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Keyset по времени вставки: `(created_at, id) > (закладка)`. */
function insertionKeyset(from: HeCatalogBookmark): string {
  const at = pgFilterValue(from.inserted_at ?? '');
  return `created_at.gt.${at},and(created_at.eq.${at},id.gt.${pgFilterValue(from.id)})`;
}

/**
 * Закладка на строку каталога. null — закладку на этой строке не поставить
 * (нет id или времени вставки); такая строка ПРЕФИКС ЗАКРЫВАЕТ: перешагнуть
 * то, чего нельзя записать, значит потерять это навсегда.
 */
function catalogBookmark(source: HeCatalogSource, row: Record<string, unknown>): HeCatalogBookmark | null {
  const id = cell(row.id);
  if (!id) return null;
  if (source === 'pdl') return { id };
  const insertedAt = cell(row.created_at);
  return insertedAt ? { id, inserted_at: insertedAt } : null;
}

/** Накопитель закладки: растёт, пока идут закрытые строки (см. блок выше). */
function catalogPrefix(slot: HeCatalogSlot | null) {
  let next = slot?.from ?? null;
  let open = slot !== null;
  return {
    /** Строка разобрана и закрыта навсегда — префикс двигается на неё. */
    closed(bookmark: HeCatalogBookmark | null): void {
      if (!open) return;
      if (bookmark) next = bookmark;
      else open = false;
    },
    /** Строка взята в сборку (или ждёт своей ночи) — префикс кончился. */
    stop(): void {
      open = false;
    },
    value(): HeCatalogBookmark | null {
      return next;
    },
  };
}

async function fetchPdlRows(
  ctx: HeStageContext,
  filters: HeCollectTask['pdl_filters'],
  limit: number,
  excludedKeys: HeBaseExclusionKeys | null,
  slot: HeCatalogSlot | null,
  widen: HeWidenLevel = 0,
  seen?: ReadonlySet<string>,
): Promise<HeCatalogFetch> {
  const rows: Record<string, unknown>[] = [];
  const prefix = catalogPrefix(slot);
  /**
   * Ступень 1 у pdl судится В JS, а не в запросе, и это вынужденно: размер
   * отбирает RPC (`p.size = any(p_sizes)`), а NULL он выбрасывает на стороне
   * БД — выразить «или пусто» через неё нельзя вовсе. Значит на ступенях 1 и 2
   * `p_sizes` уходит пустым, и СЕРВЕРНОЕ чтение у них одинаковое: разница
   * только в предикате ниже. Цена одна и та же, выдача у ступени 1 уже —
   * так и задумано, лестница отдаёт точность по одной ступени за раз.
   * Починить это «по-честному» можно только правкой общей RPC
   * (`coalesce(p.size,'') = any(p_sizes)`), но она снимает третью колонку
   * индекса (country, industry, size) у КАЖДОГО её читателя — вкладки каталога
   * и экспортов, — ради пути, который по умолчанию выключен.
   */
  const sizeKeep =
    widen === 1 && filters?.sizes?.length ? new Set(lowerList(filters.sizes)) : null;
  let excludedDuringFetch = 0;
  let lastId = usableBookmark('pdl', slot?.from ?? undefined)?.id ?? '';
  let page = 0;
  // Выход на короткой странице — единственная причина, по которой «строк
  // больше нет» правда. Пишется ровно там, где цикл по ней и выходит.
  let reachedEnd = false;
  for (; page < ENG_CATALOG_MAX_PAGES && rows.length < limit; page += 1) {
    const params = {
      p_industries: filters?.industries?.length ? lowerList(filters.industries) : null,
      // Ослабленная ступень фильтр размера серверу не отдаёт — см. sizeKeep выше.
      p_sizes: widen === 0 && filters?.sizes?.length ? lowerList(filters.sizes) : null,
      p_countries: filters?.countries?.length ? lowerList(filters.countries) : null,
      p_name: filters?.name ? filters.name.replace(/[%_]/g, '') : null,
      p_after_id: lastId || null,
      p_limit: ENG_CATALOG_PAGE_SIZE,
    };
    // Повторные попытки при сбое чтения (блип Kong / холодный кэш каталога):
    // страница идемпотентна, на happy-path лишнего трафика нет.
    const delays = pdlReadRetryDelays();
    let data: unknown = null;
    let error: { message: string } | null = null;
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      const res = await ctx.supabase.rpc('search_pdl_companies', params);
      data = res.data;
      error = res.error ? { message: res.error.message } : null;
      if (!error) break;
      const pause = delays[attempt];
      if (pause !== undefined) {
        stageLog(ctx, `[base_collect] pdl: чтение не удалось (${error.message.slice(0, 80)}), повтор через ${pause}мс`);
        await sleep(pause);
      }
    }
    if (error) {
      return {
        rows,
        excludedDuringFetch,
        exhausted: false,
        hitCeiling: false,
        next: prefix.value(),
        error: cleanPdlReadError(error.message),
      };
    }
    const pageRows = (data ?? []) as Record<string, unknown>[];
    let scanned = 0;
    for (const r of pageRows) {
      // Остаток до limit кончился — дальше НЕ разбираем: закладка не имеет
      // права перешагнуть строку, которую мы не смотрели.
      if (rows.length >= limit) break;
      scanned += 1;
      if (excludedKeys && matchesExclusion(excludedKeys, cell(r.name), undefined, r.website)) {
        excludedDuringFetch += 1;
        prefix.closed(catalogBookmark('pdl', r));
        continue;
      }
      // Без имени строка всё равно умрёт на HARVEST (дедуп по нормализованному
      // имени), но по пути съела бы слот limit и НАВСЕГДА приколола бы закладку
      // к себе: stop() ниже не двигает её, а строка никуда не девается.
      if (!normalizeCompanyForDedup(cell(r.name))) {
        prefix.closed(catalogBookmark('pdl', r));
        continue;
      }
      /**
       * ДВЕ ПРИЧИНЫ ПРОПУСТИТЬ СТРОКУ НА ОСЛАБЛЕННОЙ СТУПЕНИ, и обе ЗАКРЫВАЮТ
       * префикс. Это единственное место лестницы, где закладка двигается по
       * строке, которую мы не взяли, поэтому разбор полный.
       *
       * 1. Строку уже взяла НИЖНЯЯ ступень этой же задачи (`seen`). Закрыть её
       *    можно потому, что она защищена закладкой НИЖНЕЙ ступени: та
       *    остановилась на первой же взятой строке и с места не сдвинулась.
       *    Умрёт база — нижняя ступень прочитает эту строку заново, ничего не
       *    потеряно. (Останавливать здесь нельзя: ослабленная ступень читает
       *    НАДМНОЖЕСТВО, её первая же строка почти всегда `seen`, и закладка
       *    была бы приколота к началу среза навсегда — каждую ночь те же 60
       *    страниц, а хвост среза недостижим.)
       * 2. Размер вне ослабленного набора (ступень 1). Здесь закладка
       *    действительно перешагивает строку, отвергнутую ПО СОДЕРЖИМОМУ, и
       *    разрешено это ровно одному источнику. `pdl_companies` — замороженный
       *    слепок: одноразовый ingest, обновление = DELETE + полная перезагрузка
       *    (app/scripts/pdl/README.md), строки на месте не переписываются. А сам
       *    набор размеров входит в ключ закладки (хеш `pdl_filters`), поэтому
       *    вердикт по строке для ЭТОГО среза неизменен. У живых фидов
       *    (funded, eng_hiring) такого права нет и не будет: там ступень 1
       *    фильтрует ЗАПРОСОМ, и отвергнутая строка до этого цикла не доходит.
       */
      if (seen?.has(cell(r.id)) || (sizeKeep && !heSizeOrEmpty(sizeKeep, r.size))) {
        prefix.closed(catalogBookmark('pdl', r));
        continue;
      }
      prefix.stop();
      rows.push(r);
    }
    // Порядок проверок — часть смысла `exhausted`: набранный limit важнее
    // короткой страницы, потому что её хвост мы в этом случае не разбирали.
    if (rows.length >= limit) break;
    if (pageRows.length < ENG_CATALOG_PAGE_SIZE) {
      reachedEnd = true;
      break;
    }
    lastId = cell(pageRows[scanned - 1]?.id);
    // Строка без id — курсора нет, дальше не листнуть (защита от зацикливания).
    // Выдача при этом осталась: исчерпанием такой выход НЕ считается.
    if (!lastId) break;
  }
  const hitCeiling = rows.length < limit && page >= ENG_CATALOG_MAX_PAGES;
  return { rows, excludedDuringFetch, exhausted: reachedEnd, hitCeiling, next: prefix.value() };
}

/**
 * funded_companies (стартапы и раунды) до limit строк.
 * Фильтры — applyFundedFilters из /api/funded: единая семантика с вкладкой
 * Crunchbase (min funding: last ИЛИ total; funded_since: last_funding_date >=).
 *
 * ПОРЯДОК ВЫДАЧИ ЗАВИСИТ ОТ ТОГО, ЕСТЬ ЛИ КУДА ПИСАТЬ ЗАКЛАДКУ. Без неё
 * (RU-план) — прежний keyset по `id`. С ней — keyset по ВРЕМЕНИ ВСТАВКИ
 * (`created_at`, `id` разрывает ничьи): `funded_companies.id` собран как
 * `<source>:<natural_key>` и с порядком вставки не связан вовсе, поэтому
 * закладка по id отправляла бы за курсор ровно свежие раунды — то, ради чего
 * ночной добор и нужен. По времени вставки свежая строка всегда ВПЕРЕДИ
 * закладки, и пропустить её нельзя.
 */
async function fetchFundedRows(
  ctx: HeStageContext,
  filters: HeCollectTask['funded_filters'],
  limit: number,
  excludedKeys: HeBaseExclusionKeys | null,
  slot: HeCatalogSlot | null,
  widen: HeWidenLevel = 0,
  seen?: ReadonlySet<string>,
): Promise<HeCatalogFetch> {
  /**
   * У funded ступень 1 судится В ЗАПРОСЕ, в отличие от pdl: `funded_companies`
   * читается плоским PostgREST'ом, и «сумма не меньше порога ЛИБО суммы нет
   * вовсе» выражается тем же `or`, каким `applyFundedFilters` выражает сам
   * порог. Это не стилистика: живой фид дозаполняет строки (SEC Form D +
   * обогащение из pdl), а серверный фильтр — единственный способ не дать
   * закладке перешагнуть строку, чья сумма завтра появится.
   */
  const minFunding = widen === 1 ? filters?.min_funding_usd : undefined;
  // Граница уезжает в запрос ЛИТЕРАЛОМ, поэтому она обязана быть целым числом,
  // которое `${}` не напечатает в экспоненциальной форме (`1e+21` развалил бы
  // условие). Не влезло — границы нет, и ступень 1 совпадает со ступенью 2:
  // это ослабление, а не ужесточение, лишнего в базу не попадёт.
  const fundingFloor =
    typeof minFunding === 'number' && minFunding > 0 && Number.isSafeInteger(Math.round(minFunding))
      ? Math.round(minFunding)
      : null;
  const rows: Record<string, unknown>[] = [];
  const prefix = catalogPrefix(slot);
  let excludedDuringFetch = 0;
  let lastId = '';
  let from = slot ? usableBookmark('funded', slot.from ?? undefined) : null;
  let page = 0;
  let reachedEnd = false;
  for (; page < ENG_CATALOG_MAX_PAGES && rows.length < limit; page += 1) {
    let query = ctx.supabase
      .from('funded_companies')
      // `created_at` — ключ закладки (см. шапку); остальное как было.
      .select(
        'id, created_at, name, website, industry, country, region, locality, total_funding_usd, last_funding_usd, last_funding_type, last_funding_date, batch, source',
      )
      .limit(ENG_CATALOG_PAGE_SIZE);
    if (slot) {
      if (from) query = query.or(insertionKeyset(from));
      query = query.order('created_at').order('id');
    } else {
      query = query.gt('id', lastId).order('id');
    }
    query = applyFundedFilters(query, {
      industry: filters?.industries?.length ? lowerList(filters.industries) : undefined,
      country: filters?.countries?.length ? lowerList(filters.countries) : undefined,
      // Ослабленные ступени порог суммы через applyFundedFilters НЕ ставят:
      // ступень 1 ставит его сама (ниже, вместе с «суммы нет»), ступень 2 не
      // ставит вовсе.
      minFunding: widen === 0 ? filters?.min_funding_usd ?? null : null,
      fundedSince: filters?.funded_since ?? null,
    });
    if (fundingFloor !== null) {
      query = query.or(
        `last_funding_usd.gte.${fundingFloor},total_funding_usd.gte.${fundingFloor},` +
          'and(last_funding_usd.is.null,total_funding_usd.is.null)',
      );
    }
    const { data, error } = await query;
    if (error) {
      // Разобранное не выбрасываем: решение «падать или взять префикс»
      // принимает dispatchTask — одно место на все три каталога.
      return {
        rows,
        excludedDuringFetch,
        exhausted: false,
        hitCeiling: false,
        next: prefix.value(),
        error: `funded_companies read: ${error.message}`,
      };
    }
    const pageRows = (data ?? []) as Record<string, unknown>[];
    let scanned = 0;
    for (const r of pageRows) {
      if (rows.length >= limit) break;
      scanned += 1;
      if (excludedKeys && matchesExclusion(excludedKeys, cell(r.name), undefined, r.website)) {
        excludedDuringFetch += 1;
        prefix.closed(catalogBookmark('funded', r));
        continue;
      }
      // См. тот же приём у pdl: безымянная строка — закрытая, а не тормоз.
      if (!normalizeCompanyForDedup(cell(r.name))) {
        prefix.closed(catalogBookmark('funded', r));
        continue;
      }
      // Строку, уже взятую НИЖНЕЙ ступенью этой задачи, префикс закрывает: её
      // держит закладка той ступени (она остановилась на первой же взятой
      // строке). Разбор — у pdl, там же и причина, по которой останавливаться
      // здесь нельзя. Отвергнутых ПО СОДЕРЖИМОМУ строк у funded в этом цикле
      // не бывает вовсе: ослабленный порог суммы ставит запрос.
      if (seen?.has(cell(r.id))) {
        prefix.closed(catalogBookmark('funded', r));
        continue;
      }
      prefix.stop();
      rows.push(r);
    }
    if (rows.length >= limit) break;
    if (pageRows.length < ENG_CATALOG_PAGE_SIZE) {
      reachedEnd = true;
      break;
    }
    const tail = pageRows[scanned - 1];
    lastId = cell(tail?.id);
    from = tail ? catalogBookmark('funded', tail) : null;
    // Курсор с хвоста полной страницы не собрался — выдача осталась, это не
    // исчерпание.
    if (slot ? !from : !lastId) break;
  }
  const hitCeiling = rows.length < limit && page >= ENG_CATALOG_MAX_PAGES;
  return { rows, excludedDuringFetch, exhausted: reachedEnd, hitCeiling, next: prefix.value() };
}

/** Время published_at как timestamp; мусор/пусто → 0 (в сортировке уходит в хвост). */
function publishedTime(value: unknown): number {
  const time = Date.parse(cell(value));
  return Number.isNaN(time) ? 0 : time;
}

/**
 * SQL-предфильтр роли для eng_hiring_cache: PostgREST-выражение
 * `or=(vacancy_title.ilike.%a%,vacancy_title.ilike.%b%)` по тем же кускам, на
 * которые buildRolesRegex режет строку ролей. null — предфильтр невозможен,
 * читаем как раньше (роль отберёт regex в JS).
 *
 * Зачем: без него роль отбиралась ТОЛЬКО в JS — уже после того, как выборка
 * усечена потолком страниц по свежести. Узкая роль в большой кэш просто не
 * попадала: на проде 12.08 под фильтры «страна + 90 дней» подходило 336k строк,
 * сканировались первые 20k (5.9%), и из 78 franchise-вакансий в окно попадала
 * одна — все девять ENG-сборок получили от eng_hiring ровно 0 строк.
 *
 * Контракт: выражение обязано быть НАДМНОЖЕСТВОМ regex-совпадений, иначе
 * предфильтр молча срежет валидные строки. Отсюда два правила:
 *  - терм обрезается по первому символу, ломающему синтаксис or=(...) — остаётся
 *    префикс терма, а ilike по префиксу шире точного совпадения;
 *  - терм с 'b2b' раскрывается в buildRolesRegex в ~30 альтернатив (часть —
 *    regex-фрагменты вроде \bae\b, ilike их не выразит) → предфильтра нет вовсе.
 */
export function buildRolesIlikeFilter(roles: string[]): string | null {
  const terms = roles
    .join(', ')
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (terms.length === 0) return null;

  const patterns: string[] = [];
  for (const term of terms) {
    if (/\bb2b\b/i.test(term)) return null;
    const prefix = term.split(/[,.()"'\\]/)[0].trim();
    if (!prefix) return null;
    patterns.push(`vacancy_title.ilike.%${prefix}%`);
  }
  return patterns.join(',');
}

/**
 * Потолок досбора сайтов за задачу и параллельность запросов к каталогу.
 * Резолв — обогащение, а не контракт сбора: упереться в потолок значит лишь,
 * что часть строк останется без сайта, как было до досбора.
 */
const ENG_HIRING_SITE_RESOLVE_MAX = 300;
const ENG_HIRING_SITE_RESOLVE_CONCURRENCY = 8;

/**
 * Досбор сайта компании для строк eng_hiring, у которых его нет.
 *
 * Зачем: у ATS-фида `company_site_url` заполнен лишь у ~13% строк (замер 15.08:
 * greenhouse 26%, smartrecruiters 2.8%, workable 0.5%). Без сайта конструктору
 * не от чего искать почты, и строка вылетает из базы. На сборке Franchise Brands
 * 12.08 из-за этого потерялись ЕДИНСТВЕННЫЕ компании по вертикали — United
 * Franchise Group, Empower Brands, Mob Entertainment: их нашли по вакансии
 * «franchise development» (сигнал намерения, точнее любой отраслевой метки),
 * а в финальную базу не попало ни одной строки eng_hiring.
 *
 * Резолв идёт по локальному каталогу pdl_companies (имя → сайт, уточнение по
 * стране) БЕЗ Clearbit-фолбэка `resolveCompanyDomainByName`: тот жёстко
 * рейтлимитит и шеллится в curl — для пакетной сборки не годится. Резолвер сам
 * отказывается угадывать на коллизиях имени: неверный домен хуже пустого.
 *
 * Never-throw: сбой резолва оставляет строку без сайта, сбор не роняет.
 */
async function fillMissingCompanySites(
  ctx: HeStageContext,
  rows: Record<string, unknown>[],
): Promise<number> {
  const targets = rows
    .filter((r) => !cell(r.company_site_url) && cell(r.company_name))
    .slice(0, ENG_HIRING_SITE_RESOLVE_MAX);
  if (targets.length === 0) return 0;

  let filled = 0;
  for (let i = 0; i < targets.length; i += ENG_HIRING_SITE_RESOLVE_CONCURRENCY) {
    const chunk = targets.slice(i, i + ENG_HIRING_SITE_RESOLVE_CONCURRENCY);
    await Promise.all(
      chunk.map(async (r) => {
        try {
          const domain = await resolveCompanyDomainViaPdl(
            cell(r.company_name),
            cell(r.country_code) || null,
            ctx.supabase as unknown as Parameters<typeof resolveCompanyDomainViaPdl>[2],
          );
          const site = domainToSiteUrl(domain);
          if (site) {
            r.company_site_url = site;
            filled += 1;
          }
        } catch {
          /* обогащение best-effort: строка просто останется без сайта */
        }
      }),
    );
  }
  return filled;
}

/**
 * eng_hiring_cache (компании, нанимающие ENG-роли): SQL сужает выборку по
 * стране (country_code), свежести (published_at >= now - posted_within_days) и
 * роли (buildRolesIlikeFilter — надмножество), точность роли добирает regex по
 * vacancy_title в JS (buildRolesRegex из ATS-фильтров, как в engHiring).
 * Дедуп по компании внутри задачи: выживает самая свежая вакансия.
 *
 * ДВА РЕЖИМА ЧТЕНИЯ.
 *  - Без закладки (RU-план) — прежний: офсетная пагинация по `published_at
 *    desc` с потолком ENG_HIRING_MAX_PAGES, дедуп после сбора всех страниц.
 *  - С закладкой (market='us') — keyset по ВРЕМЕНИ ВСТАВКИ (`created_at`, `id`
 *    разрывает ничьи). Офсет здесь не просто неудобен: `published_at` не
 *    уникален, ingest пишет в кэш каждую ночь, и страницы офсета между заходами
 *    разъезжаются — одна и та же вакансия попадает в две страницы, другая не
 *    попадает ни в одну. Ключ обязан быть не только стабильным, но и монотонным
 *    по вставке: keyset по uuid отправил бы за закладку примерно половину
 *    свежих вакансий, а keyset по `published_at desc` — все до единой.
 *    Дедуп в этом режиме потоковый (иначе закладка не знала бы, где
 *    остановиться), но победитель тот же: самая свежая вакансия компании из
 *    прочитанного.
 *    Плюс отсев протухших строк кэша: берём только `source='jobhive'` —
 *    ежесуточно пересобираемый фид на 47 ATS-платформ (docs/english-outreach-
 *    data-sources.md, ingest — worker/jobhiveIngestCron в host crontab).
 *    Поштучный ATS-ингест (greenhouse/lever/…) по расписанию НЕ идёт вовсе: его
 *    страницы обновляет только запуск ENG-парсера специалистом
 *    (parsers/engHiringRunner.ts, ensureCache), поэтому его строки в кэше живут
 *    с последнего такого запуска, и «нанимают прямо сейчас» по ним — неправда.
 *    Правка ровно в одну строку и снимается ровно так же.
 */
async function fetchEngHiringRows(
  ctx: HeStageContext,
  query: HeCollectTask['eng_hiring_query'],
  limit: number,
  excludedKeys: HeBaseExclusionKeys | null,
  slot: HeCatalogSlot | null,
): Promise<HeCatalogFetch> {
  const roles = query?.roles ?? [];
  const rolesRegex = buildRolesRegex(roles.join(', '));
  const rolesFilter = buildRolesIlikeFilter(roles);
  const days = query?.posted_within_days ?? 0;
  const cutoff = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : null;
  const countries = query?.countries?.length ? lowerList(query.countries) : null;
  const baseQuery = () => {
    let q = ctx.supabase
      .from('eng_hiring_cache')
      // `id, created_at` — ключ закладки (см. шапку); остальное как было.
      .select(
        'id, created_at, company_name, company_site_url, vacancy_title, location, country, country_code, source, published_at',
      );
    if (slot) q = q.eq('source', 'jobhive');
    if (countries) q = q.in('country_code', countries);
    if (cutoff) q = q.gte('published_at', cutoff);
    if (rolesFilter) q = q.or(rolesFilter);
    return q;
  };

  if (!slot) {
    const matched: Record<string, unknown>[] = [];
    let offset = 0;
    for (let page = 0; page < ENG_HIRING_MAX_PAGES && matched.length < limit; page += 1) {
      const { data, error } = await baseQuery()
        .order('published_at', { ascending: false })
        .range(offset, offset + ENG_HIRING_PAGE_SIZE - 1);
      if (error) throw new Error(`eng_hiring_cache read: ${error.message}`);
      const pageRows = (data ?? []) as Record<string, unknown>[];
      for (const r of pageRows) {
        if (rolesRegex.test(cell(r.vacancy_title))) matched.push(r);
      }
      if (pageRows.length < ENG_HIRING_PAGE_SIZE) break;
      offset += pageRows.length;
    }

    // Дедуп по компании внутри задачи: сортировка по свежести (в JS — порядок
    // выборки не контракт), первое вхождение компании побеждает.
    matched.sort((a, b) => publishedTime(b.published_at) - publishedTime(a.published_at));
    const seen = new Set<string>();
    const out: Record<string, unknown>[] = [];
    for (const r of matched) {
      const key = normalizeCompanyForDedup(cell(r.company_name));
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (out.length < limit) out.push(r);
    }
    await resolveEngHiringSites(ctx, out);
    // Режим без закладки менять нельзя, и признак исчерпания здесь не нужен:
    // читателя у него ровно один (разбор нулевой сборки), а тот берёт признак
    // только в паре с `continued`, которого без закладки не бывает. Отдавать
    // флаг, который в этой ветке никто не прочтёт, значит заводить второе
    // описание одного факта.
    return { rows: out, excludedDuringFetch: 0, exhausted: false, hitCeiling: false, next: null };
  }

  const prefix = catalogPrefix(slot);
  let excludedDuringFetch = 0;
  let from = usableBookmark('eng_hiring', slot.from ?? undefined);
  // Компания → лучшая (самая свежая) её вакансия из прочитанного. Порядок
  // вставки Map — порядок ПЕРВОЙ ВСТРЕЧИ компании; в мёрдж уходит другой
  // порядок — по свежести вакансии (сортировка `out` ниже), тот же, что в
  // режиме без закладки. Снимете сортировку — изменится, кто переживёт
  // kept.slice(0, limit), и крючок персонализации станет старее.
  const byCompany = new Map<string, Record<string, unknown>>();
  let page = 0;
  let readError: string | undefined;
  let reachedEnd = false;
  for (; page < ENG_HIRING_MAX_PAGES && byCompany.size < limit; page += 1) {
    let q = baseQuery();
    if (from) q = q.or(insertionKeyset(from));
    const { data, error } = await q.order('created_at').order('id').limit(ENG_HIRING_PAGE_SIZE);
    if (error) {
      readError = `eng_hiring_cache read: ${error.message}`;
      break;
    }
    const pageRows = (data ?? []) as Record<string, unknown>[];
    let scanned = 0;
    for (const r of pageRows) {
      if (byCompany.size >= limit) break;
      scanned += 1;
      /**
       * Роль не совпала — закладку через эту строку НЕ переносим.
       *
       * Соблазнительно считать её закрытой навсегда (regex строится из roles,
       * а roles входят в ключ закладки), но строки jobhive МУТАБЕЛЬНЫ:
       * ингест делает upsert по (source, source_job_id), а source_job_id —
       * это `jh:<компания>:<страна>`, то есть фид схлопнут в ОДНУ строку на
       * компанию, и вакансия в ней переписывается, пока created_at остаётся
       * от первой вставки. Компания, у которой сегодня «Account Executive»,
       * через месяц держит в той же строке «Head of Sales» — и если бы
       * закладка её перешагнула, она навсегда осталась бы позади неё.
       * Поэтому здесь stop(): двигаться закладке разрешено только по тому,
       * с чем у проекта покончено НЕЗАВИСИМО от содержимого строки.
       */
      if (!rolesRegex.test(cell(r.vacancy_title))) {
        prefix.stop();
        continue;
      }
      const key = normalizeCompanyForDedup(cell(r.company_name));
      if (!key) {
        prefix.closed(catalogBookmark('eng_hiring', r));
        continue;
      }
      if (excludedKeys && matchesExclusion(excludedKeys, cell(r.company_name), undefined, r.company_site_url)) {
        excludedDuringFetch += 1;
        prefix.closed(catalogBookmark('eng_hiring', r));
        continue;
      }
      prefix.stop();
      const known = byCompany.get(key);
      // Свежая вакансия той же компании вытесняет прежнюю: крючок
      // персонализации должен быть самым новым из прочитанного.
      if (!known || publishedTime(r.published_at) > publishedTime(known.published_at)) {
        byCompany.set(key, r);
      }
    }
    if (byCompany.size >= limit) break;
    if (pageRows.length < ENG_HIRING_PAGE_SIZE) {
      reachedEnd = true;
      break;
    }
    const tail = pageRows[scanned - 1];
    from = tail ? catalogBookmark('eng_hiring', tail) : null;
    // Курсор с хвоста полной страницы не собрался — выдача осталась.
    if (!from) break;
  }
  const out = [...byCompany.values()].sort(
    (a, b) => publishedTime(b.published_at) - publishedTime(a.published_at),
  );
  // Досбор сайтов — ПОСЛЕ дедупа: резолвим только те строки, что реально уйдут
  // в базу, а не каждую просканированную вакансию.
  await resolveEngHiringSites(ctx, out);
  const hitCeiling = !readError && out.length < limit && page >= ENG_HIRING_MAX_PAGES;
  return {
    rows: out,
    excludedDuringFetch,
    exhausted: reachedEnd,
    hitCeiling,
    next: prefix.value(),
    ...(readError ? { error: readError } : {}),
  };
}

/** Досбор сайтов у строк без него + строка лога (общая для обоих режимов). */
async function resolveEngHiringSites(ctx: HeStageContext, out: Record<string, unknown>[]): Promise<void> {
  const missing = out.filter((r) => !cell(r.company_site_url)).length;
  if (missing === 0) return;
  const filled = await fillMissingCompanySites(ctx, out);
  stageLog(ctx, `[base_collect] eng_hiring: сайт дособран у ${filled} из ${missing} строк без него`);
}

/**
 * Закладки каталога ОДНОГО ПРОГОНА стадии: карта в памяти + запись в стор.
 *
 * Зачем прослойка, а не прямые вызовы стора: сдвиг закладки обязан ложиться в
 * БД ПОСЛЕ префикса строк (persistCollectInfo), а не вместе с ним. Потерянный
 * сдвиг стоит одного лишнего скана на следующую ночь; потерянный префикс при
 * уехавшем сдвиге стоил бы компаний, которых больше никто не прочитает.
 *
 * `stored === null` означает «стор недоступен» (миграция 20260930_0002 не
 * применена либо чтение отказало). Слот при этом ВСЁ РАВНО выдаётся — просто с
 * `from: null`: режим чтения каталога выбирается по рынку, а не по доступности
 * стора, поэтому при market='us' срез читается тем же keyset'ом по времени
 * вставки, только с первой строки и без записи закладок. Исключение уже
 * собранных компаний на выборке тоже работает без стора — ему стор не нужен.
 * Цена отсутствия миграции — не «как раньше», а проход без индексов под этот
 * keyset, поэтому миграцию применяют ДО деплоя кода.
 */
interface HeCatalogRun {
  /** Сохранённый план, если его вход совпал с текущим (иначе null — платим). */
  reusablePlan(planKey: string): HeSourcePlan | null;
  /** Запомнить новый план и выбросить закладки чужих срезов. */
  rememberPlan(plan: HeSourcePlan, planKey: string): Promise<void>;
  /**
   * Слот закладки среза задачи на ступени ослабления `widen` (0 — как
   * спланировано). У каждой ступени ключ свой: ослабленный срез —
   * надмножество исходного, и общий ключ увёл бы закладку узкого среза по
   * строкам, которых он никогда не видел (см. heCatalogSliceKey).
   */
  slotFor(task: HeCollectTask, widen?: HeWidenLevel): HeCatalogSlot | null;
  move(key: string, bookmark: HeCatalogBookmark | null): void;
  flush(): Promise<void>;
  /**
   * Платное расширение плана недавно кончилось ничем — покупать рано.
   * Вопрос задаётся ПЛАНУ, а не базе: базы у каждой ночи свои, и отметка в
   * collect_info одной базы следующую ночь ни от чего не удерживает.
   */
  widenOnCooldown(): boolean;
  /** Запомнить безрезультатную покупку рядом с планом. */
  rememberWidenFailure(): Promise<void>;
}

function createHeCatalogRun(
  ctx: HeStageContext,
  args: { verticalId: string; market: HeMarket; stored: HeCatalogCursorRow | null },
): HeCatalogRun {
  const bookmarks: Record<string, HeCatalogBookmark> = { ...(args.stored?.bookmarks ?? {}) };
  let dirty = false;
  return {
    widenOnCooldown() {
      return heWidenOnCooldown(args.stored, Date.now());
    },
    async rememberWidenFailure() {
      await rememberHeCatalogWidenFailure(ctx.supabase, args.verticalId);
    },
    reusablePlan(planKey) {
      const stored = args.stored;
      if (!stored?.plan || stored.planKey !== planKey) return null;
      // План без задач переиспользовать нельзя: сборка ушла бы в «план пуст»
      // вместо того, чтобы попробовать спланировать заново.
      return stored.plan.tasks.length > 0 ? stored.plan : null;
    },
    async rememberPlan(plan, planKey) {
      if (!args.stored) return;
      // Ключи ВСЕХ ступеней каждого среза, а не только нулевой: закладки
      // ослабленных ступеней принадлежат тем же задачам плана, и запись,
      // оставляющая только нулевые ключи, выбрасывала бы их прогресс каждый
      // раз, когда план перезаписывается. Ступени перечисляются здесь (а не
      // там, где ослабление включается), потому что набор ключей обязан
      // совпадать при ЛЮБОМ значении флага — иначе выключение флага стирало
      // бы закладки, которые включение снова заведёт.
      const sliceKeys = plan.tasks
        .flatMap((task) => [0, 1, 2].map((widen) => heCatalogSliceKey(task, widen)))
        .filter((key): key is string => key !== null);
      const ok = await saveHeCatalogCursor(
        ctx.supabase,
        {
          verticalId: args.verticalId,
          market: args.market,
          bookmarks,
          plan: { plan, planKey, sliceKeys },
        },
        (m) => stageLog(ctx, m),
      );
      // Запись выбросила закладки чужих срезов — выбрасываем их и из карты
      // прогона. Иначе ближайший flush (он пишет карту целиком) вернул бы их
      // обратно той же строкой, и обещанное «закладки чужих срезов выброшены
      // той же записью» не выполнялось бы ни разу. На отказе записи карту не
      // трогаем: в сторе остался прежний план, и его закладки ещё его.
      if (ok) {
        const wanted = new Set(sliceKeys);
        for (const key of Object.keys(bookmarks)) {
          if (!wanted.has(key)) delete bookmarks[key];
        }
      }
    },
    slotFor(task, widen = 0) {
      if (!isHeCatalogSource(task.source)) return null;
      const key = heCatalogSliceKey(task, widen);
      if (!key) return null;
      return { key, from: usableBookmark(task.source, bookmarks[key]) };
    },
    move(key, bookmark) {
      if (!bookmark || sameBookmark(bookmark, bookmarks[key] ?? null)) return;
      // Штамп времени ставится здесь, на приёме сдвига: у чтения каталога он
      // выписывался бы на каждую просмотренную строку (до 60 тысяч за задачу).
      bookmarks[key] = { ...bookmark, at: new Date().toISOString() };
      dirty = true;
    },
    async flush() {
      if (!dirty || !args.stored) return;
      const ok = await saveHeCatalogCursor(
        ctx.supabase,
        { verticalId: args.verticalId, market: args.market, bookmarks },
        (m) => stageLog(ctx, m),
      );
      if (ok) dirty = false;
    },
  };
}

async function dispatchTask(
  ctx: HeStageContext,
  state: HeCollectTaskState,
  project: HeProject,
  limit: number,
  getExcludedKeys: () => Promise<HeBaseExclusionKeys>,
  catalog: HeCatalogRun | null,
  widenMode: HeWidenMode = 'off',
): Promise<void> {
  const { task } = state;

  // Реестр — синхронно, без дочерней джобы: строки сразу ложатся в задачу.
  // Компании других баз проекта исключаются ещё на выборке (fetchDirectoryRows),
  // иначе повторная сборка сегмента заново скачивала уже собранные страницы.
  if (task.source === 'companies_directory') {
    const { rows, excludedDuringFetch, exhausted, hitCeiling, error } = await fetchDirectoryRows(
      ctx,
      mapDirectoryFilters(task.directory_filters),
      limit,
      await getExcludedKeys(),
    );
    if (error) throw new Error(`companies_directory: ${error}`);
    state.harvest = rows.map(mapDirectoryRow);
    state.status = 'done';
    state.rows = state.harvest.length;
    state.child_job_id = null;
    if (excludedDuringFetch > 0) state.excluded_during_fetch = excludedDuringFetch;
    if (exhausted) {
      // Выдача под фильтры кончилась раньше limit — сегмент собран целиком,
      // повторные сборки ничего не добавят. Пометка для UI + сигнал финальному
      // разбору нулевой сборки («сегмент исчерпан» вместо «не дала строк»).
      state.exhausted = true;
      state.note = 'реестр исчерпан';
    } else if (hitCeiling) {
      // Стоп по потолку 200 страниц (200k просканированных строк) — выдача
      // ещё есть, это предохранитель, а НЕ исчерпание сегмента: exhausted не
      // ставим, чтобы финальный разбор нулевой сборки не показал «сегмент
      // исчерпан» там, где поможет просто повторный запуск.
      state.hit_ceiling = true;
      state.note = 'достигнут предел сканирования 200k — запустите сборку ещё раз';
    }
    return;
  }

  // ENG-источники (market='us') — тоже синхронно, без дочерних джоб: справочные
  // таблицы читаются напрямую, строки сразу ложатся в задачу. Компании других
  // баз проекта исключаются ЕЩЁ НА ВЫБОРКЕ (как у реестра), а место, до которого
  // срез разобран, переживает базу — см. блок «ЧТЕНИЕ КАТАЛОГА С ЗАКЛАДКОЙ».
  if (task.source === 'pdl' || task.source === 'funded' || task.source === 'eng_hiring') {
    const slot = catalog?.slotFor(task) ?? null;
    // Ключи чужих баз читаем только когда исключение на выборке включено
    // (market='us'): у RU-плана ENG-задач не бывает, и лишнее чтение data всех
    // баз проекта там ничем не оправдано.
    const excluded = slot ? await getExcludedKeys() : null;

    /**
     * ЛЕСТНИЦА ОСЛАБЛЕНИЯ ПОРОГА (см. блок «Расширение среза…»). Гейт рынка
     * здесь один и тот же: `catalog !== null` — это ровно market='us'
     * (getCatalog отдаёт null на любом другом рынке), поэтому ни одно значение
     * HE_COLLECT_WIDEN не может расширить срез staff-сборки.
     */
    const threshold = catalog ? heWidenThreshold(task) : null;
    const maxLevel: HeWidenLevel = catalog && threshold && widenMode !== 'off' ? HE_WIDEN_MAX_LEVEL : 0;

    const rows: Record<string, unknown>[] = [];
    /** id строк, уже взятых этой задачей: ослабленная ступень читает НАДМНОЖЕСТВО. */
    const seen = new Set<string>();
    let excludedDuringFetch = 0;
    let continued = false;
    let movedAny = false;
    let level: HeWidenLevel = 0;
    let fetched: HeCatalogFetch | null = null;
    for (let step: HeWidenLevel = 0; step <= maxLevel; step = (step + 1) as HeWidenLevel) {
      const stepSlot = step === 0 ? slot : catalog?.slotFor(task, step) ?? null;
      // Остаток до limit, а не limit: ослабленная ступень ДОБИРАЕТ, а не
      // собирает заново, иначе задача вернула бы больше строк, чем у неё просили.
      const remaining = limit - rows.length;
      if (remaining <= 0) break;
      fetched =
        task.source === 'pdl'
          ? await fetchPdlRows(ctx, task.pdl_filters, remaining, excluded, stepSlot, step, seen)
          : task.source === 'funded'
            ? await fetchFundedRows(ctx, task.funded_filters, remaining, excluded, stepSlot, step, seen)
            : await fetchEngHiringRows(ctx, task.eng_hiring_query, remaining, excluded, stepSlot);
      level = step;
      excludedDuringFetch += fetched.excludedDuringFetch;
      if (stepSlot?.from) continued = true;
      const moved = stepSlot && !sameBookmark(fetched.next, stepSlot.from) ? fetched.next : null;
      if (stepSlot && moved) {
        catalog?.move(stepSlot.key, moved);
        movedAny = true;
      }
      for (const row of fetched.rows) {
        rows.push(row);
        const id = cell(row.id);
        if (id) seen.add(id);
      }
      // Следующая ступень — только когда ЭТА кончилась целиком. Обрыв чтения и
      // стоп по потолку страниц оставляют выдачу на месте: ослаблять порог на
      // них значило бы подмешать в базу компании, до которых очередь ещё не
      // дошла, и при этом объявить срез исчерпанным.
      if (!fetched.exhausted || fetched.error || fetched.hitCeiling || rows.length >= limit) break;
      if (step < maxLevel) {
        stageLog(
          ctx,
          `[base_collect] ${task.source}: срез дочитан на ${rows.length} строках из ${limit} — ступень ` +
            `${step + 1}: ${step === 0 ? `${threshold} или пустое поле` : `${threshold} снят`}`,
        );
      }
    }
    // Замер для выключённого флага. Строка пишется РОВНО там, где лестница
    // сработала бы, и это единственное место, где недобор ENG-среза вообще
    // виден: истории английских сборок нет, и включать расширение вслепую
    // нечем. Ставится и при maxLevel=0 — «ослаблять нечего» тоже ответ.
    if (catalog && fetched && fetched.exhausted && !fetched.error && !fetched.hitCeiling && rows.length < limit) {
      const why =
        !threshold
          ? 'ослаблять нечего: порога размера в срезе нет'
          : widenMode === 'off'
            ? `порог ${threshold} можно ослабить, но расширение выключено (HE_COLLECT_WIDEN)`
            : `не помогла и ступень ${level} (${threshold} снят)`;
      stageLog(ctx, `[base_collect] ${task.source}: срез дочитан на ${rows.length} строках из ${limit} — ${why}`);
    }
    // Обрыв выдачи НЕ выбрасывает разобранное: падаем только когда фиксировать
    // нечего вовсе — ни одной строки и ни одного сдвига закладки.
    if (fetched?.error && rows.length === 0 && !movedAny) {
      throw new Error(`${task.source}: ${fetched.error}`);
    }
    state.harvest = rows.map(
      task.source === 'pdl' ? mapPdlRow : task.source === 'funded' ? mapFundedRow : mapEngHiringRow,
    );
    state.status = 'done';
    state.rows = state.harvest.length;
    state.child_job_id = null;
    if (excludedDuringFetch > 0) {
      state.excluded_during_fetch = excludedDuringFetch;
      stageLog(
        ctx,
        `[base_collect] ${task.source}: ${excludedDuringFetch} строк пропущено на выборке — ` +
          'компании уже есть в других базах проекта',
      );
    }
    // Чтение стартовало с сохранённой закладки: срез уже листали прошлые
    // сборки проекта. Без этого факта «выдача кончилась» неотличимо от «в
    // срезе не было ни строки с самого начала» (см. поле `continued`).
    if (continued) state.continued = true;
    if (fetched?.error) {
      // Партия частичная: источник жив, чтение оборвалось на странице. Ни
      // исчерпания, ни потолка не заявляем — продолжение пойдёт с закладки.
      state.partial = true;
      state.note = `частичная партия: выдача каталога оборвалась (${fetched.error})`;
      stageLog(
        ctx,
        `[base_collect] ${task.source}: партия собрана частично, взято ${rows.length} строк, ` +
          `выдача оборвалась: ${fetched.error}`,
      );
    } else if (fetched?.hitCeiling) {
      // Стоп по потолку страниц — предохранитель, а НЕ исчерпание среза:
      // exhausted не ставим, иначе разбор нулевой сборки сказал бы клиенту
      // «новых компаний не осталось» на срабатывании предохранителя.
      const scanned = task.source === 'eng_hiring' ? ENG_HIRING_MAX_PAGES : ENG_CATALOG_MAX_PAGES;
      state.hit_ceiling = true;
      state.note = `остановлено на потолке сканирования каталога: ${scanned}k строк`;
    } else if (slot && fetched?.exhausted) {
      // Выдача каталога кончилась на короткой странице: за закладкой под эти
      // фильтры строк больше нет. Пометка для staff + сигнал разбору нулевой
      // сборки (segmentExhausted). Ставим только при slot — вне market='us'
      // закладки нет, признак читать некому, а RU-путь обязан остаться
      // прежним байт-в-байт.
      //
      // Флаг НЕ закрывает источник: он лежит в collect_info этой базы, его
      // не читает ни планировщик ночного добора, ни enqueue — следующая
      // сборка снова прочитает каталог с той же закладки и подберёт всё, что
      // ingest вставил за ночь (у свежей строки created_at больше закладки,
      // то есть она ВПЕРЕДИ курсора).
      state.exhausted = true;
      // Две разные правды, и ровно их различает `continued`: с закладкой срез
      // дочитан ПОСЛЕ прошлых сборок, без закладки — с первой строки. В
      // причину базы уезжает та, что случилась (breakdown ниже собирается из
      // пометок задач), иначе staff читал бы про закладку, которой не было.
      //
      // Ослабленная ступень (`level > 0`) названа в пометке отдельно: срез,
      // дочитанный уже БЕЗ порога, и срез, дочитанный с порогом, — разные
      // факты, и по второму есть что ослабить, а по первому нечего.
      const widened = level > 0 ? `; срез ослаблен до ступени ${level}` : '';
      state.note =
        (slot.from
          ? 'каталог дочитан до конца: за закладкой строк под фильтры среза больше нет'
          : 'каталог дочитан до конца с первой строки: строк под фильтры среза больше нет') + widened;
    }
    return;
  }

  // Дочерним джобам парсеров обязателен владелец (user_id NOT NULL).
  if (!project.created_by) {
    throw new Error('he_projects.created_by пуст — дочерней джобе парсера некому принадлежать');
  }
  const userId = project.created_by;

  if (task.source === 'hh_live') {
    const q = task.hh_query;
    if (!q?.text) throw new Error('hh_live: в задаче нет hh_query.text');
    // Россия по умолчанию: LLM может не указать area, а план — только рынок РФ/СНГ.
    const config: Record<string, unknown> = { text: q.text, per_page: 100, area: q.area ?? '113' };
    if (q.date_from) config.date_from = q.date_from;
    if (q.date_to) config.date_to = q.date_to;
    state.child_job_id = await insertChildJob(ctx, CHILD_JOB_TABLE.hh_live, {
      user_id: userId,
      parser_type: 'hh_vacancies',
      status: 'pending',
      progress_stage: 'pending',
      progress_percent: 0,
      config,
    });
  } else if (task.source === 'yandex_maps') {
    const q = task.maps_query;
    if (!q?.queries?.length) throw new Error('yandex_maps: в задаче нет maps_query.queries');
    const searchUrls = buildYandexSearchUrls(q);
    state.child_job_id = await insertChildJob(ctx, CHILD_JOB_TABLE.yandex_maps, {
      user_id: userId,
      status: 'pending',
      progress_stage: 'pending',
      config: {
        search_urls: searchUrls,
        max_results: YANDEX_RESULTS_PER_URL,
        headless: true,
      },
    });
  } else {
    const q = task.maps_query;
    if (!q?.queries?.length) throw new Error('google_maps: в задаче нет maps_query.queries');
    const inputLines = buildGoogleInputLines(q);
    // Язык/регион выдачи — по рынку проекта (us → en/US), раньше хардкод ru/RU.
    const gmapsLocale =
      (ctx.market ?? projectMarket(project)) === 'us'
        ? { language: 'en', region: 'US' }
        : { language: 'ru', region: 'RU' };
    state.child_job_id = await insertChildJob(ctx, CHILD_JOB_TABLE.google_maps, {
      user_id: userId,
      status: 'queued',
      total_targets: inputLines.length,
      config: {
        inputLines,
        limitPerQuery: 100,
        ...gmapsLocale,
        enrichContacts: true,
        // Вежливая пауза между запросами (как дефолты GoogleNewsParserForm);
        // без этих полей воркер считает delay от undefined → NaN.
        minDelayMs: 1200,
        maxDelayMs: 2800,
      },
    });
  }
  state.status = 'dispatched';
  // Штамп нужен WAIT-фазе: по нему зависшая дочерняя джоба (парсер умер и не
  // закрыл строку) уходит в failed по таймауту, а не ждёт вечно.
  state.dispatched_at = new Date().toISOString();
}

/* ─────────────────────────── Фаза WAIT ─────────────────────────── */

/** Прочитать строки завершённой дочерней джобы (кап — limit сборки) → унифицированные строки. */
async function readChildRows(
  ctx: HeStageContext,
  state: HeCollectTaskState,
  limit: number,
): Promise<HeUnifiedRow[]> {
  const jobId = state.child_job_id;
  if (!jobId) return [];

  if (state.source === 'hh_live') {
    const { data, error } = await ctx.supabase
      .from('hh_vacancies')
      .select('name, company_name, company_site_url, area')
      .eq('job_id', jobId)
      .limit(limit);
    if (error) throw new Error(`hh_vacancies read: ${error.message}`);
    const queryText = state.task.hh_query?.text ?? '';
    return (data ?? []).map((r) => mapHhRow(r as Record<string, unknown>, queryText));
  }

  if (state.source === 'yandex_maps') {
    const { data, error } = await ctx.supabase
      .from('yandex_maps_organizations')
      .select('name, website, email, phone, address, categories')
      .eq('job_id', jobId)
      .limit(limit);
    if (error) throw new Error(`yandex_maps_organizations read: ${error.message}`);
    return (data ?? []).map((r) => mapYandexRow(r as Record<string, unknown>));
  }

  const { data, error } = await ctx.supabase
    .from('google_maps_places')
    .select('name, website, emails, phone, address, category')
    .eq('job_id', jobId)
    .limit(limit);
  if (error) throw new Error(`google_maps_places read: ${error.message}`);
  return (data ?? []).map((r) => mapGoogleRow(r as Record<string, unknown>));
}

/** Опросить дочернюю джобу задачи: completed → harvest, failed/stopped → failed. */
async function pollTask(ctx: HeStageContext, state: HeCollectTaskState, limit: number): Promise<void> {
  // До poll доходят только источники с дочерними джобами (остальные done на dispatch).
  const table = CHILD_JOB_TABLE[state.source as keyof typeof CHILD_JOB_TABLE];
  if (!table || !state.child_job_id) return;

  const { data, error } = await ctx.supabase
    .from(table)
    .select('status, error_message')
    .eq('id', state.child_job_id)
    .maybeSingle();
  if (error) throw new Error(`${table} read: ${error.message}`);
  if (!data) {
    state.status = 'failed';
    state.error = `дочерняя джоба ${state.child_job_id} не найдена`;
    return;
  }

  const row = data as { status?: unknown; error_message?: unknown };
  const status = String(row.status ?? '');
  if (status === 'completed') {
    state.harvest = await readChildRows(ctx, state, limit);
    state.status = 'done';
    state.rows = state.harvest.length;
  } else if (isChildFailed(state.source, status)) {
    state.status = 'failed';
    state.error =
      (typeof row.error_message === 'string' && row.error_message) || `дочерняя джоба: ${status}`;
  }
  // queued/running/pending — задача остаётся dispatched, ждём следующий тик.
}

/* ─────────────────────────── Self-requeue ─────────────────────────── */

/**
 * Вернуть свою джобу в pending БЕЗ инкремента attempts — воркер клеймит её
 * не раньше run_after (пауза между тиками ожидания: 30с — дочерние парсеры,
 * 60с — конструктор баз; без паузы цикл claim→requeue крутился с нулевой
 * задержкой, ~10 запросов к БД на итерацию в течение всего ожидания).
 * Финальный done-апдейт воркер пропускает, видя, что строка больше не running
 * (см. app/worker/hypothesisEngine.ts).
 */
async function requeueSelf(ctx: HeStageContext, job: HeJob, cooldownMs = 30_000): Promise<void> {
  const { error } = await ctx.supabase
    .from('he_jobs')
    .update({
      status: 'pending',
      started_at: null,
      run_after: new Date(Date.now() + cooldownMs).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id);
  if (error) throw new Error(`he_jobs requeue: ${error.message}`);
}

/* ─────────────────────────── Исключение чужих баз проекта ─────────────────────────── */

/** Нормализация ИНН для дедупа: только цифры, валидная длина 10/12. */
function normalizeInnForDedup(value: unknown): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length === 10 || digits.length === 12 ? digits : '';
}

/**
 * Ключи исключения по другим базам проекта. Каналы матча:
 *  - ИНН: то же юрлицо под другим написанием имени («ООО Ромашка» vs
 *    «РОМАШКА ООО») ловится по множеству всех ИНН;
 *  - домен (ТОЛЬКО market='us', см. useWebsite): для ENG-источников
 *    (pdl/funded/eng_hiring/google maps) сайт — это и есть удостоверение
 *    компании, ИНН у них не бывает никогда. «Acme Technologies» и «Acme» на
 *    одном домене — одна компания, хотя ключи имён у них разные;
 *  - имя: если под этим именем в других базах есть ИНН и у входящей строки
 *    тоже — сравниваем юрлица точно (одноимённые компании разных регионов
 *    с разными ИНН больше НЕ вымываются); при market='us' то же уточнение
 *    делает домен (две разные фирмы «Acme» с разными сайтами больше не
 *    вымывают друг друга); если уточнять нечем — консервативный матч по
 *    имени, как раньше.
 *
 * Почему домен НЕ включён для RU: у RU-источников одна фирма легко приходит
 * с разными сайтами (реестр — корпоративный домен, карты — лендинг), а под
 * одним корпоративным сайтом живут несколько юрлиц холдинга. Там точное
 * удостоверение — ИНН, и он есть. Включение домена для RU меняло бы поведение
 * ежедневного staff-инструмента в обе стороны сразу: это отдельное решение,
 * а не побочный эффект правки ENG.
 */
export interface HeBaseExclusionKeys {
  /** нормализованное имя → ИНН'ы, встреченные под ним в других базах. */
  nameInns: Map<string, Set<string>>;
  /** Все ИНН других баз (матч «то же юрлицо, другое написание»). */
  inns: Set<string>;
  /** нормализованное имя → домены, встреченные под ним (только useWebsite). */
  nameSites: Map<string, Set<string>>;
  /** Все домены других баз (матч «та же компания, другое имя»; только useWebsite). */
  sites: Set<string>;
  /** market='us': домен участвует в ключе. Для RU оба множества выше пусты. */
  useWebsite: boolean;
}

/**
 * Домен как удостоверение компании: только собственный сайт. Соцсети,
 * сокращатели и бесплатные почтовые домены в колонке «сайт» (обычное дело у
 * google maps) принадлежат многим компаниям сразу — по ним исключение
 * вымывало бы всех, кроме первой. Отсев берём готовый,
 * normalizeLeadWebsite (instantly/leadContactValues) уже содержит этот список
 * и поддерживается: он возвращает null для не-компанейского хоста.
 */
function companySiteKey(website: unknown): string {
  const raw = cell(website);
  if (!raw || !normalizeLeadWebsite(raw)) return '';
  return normalizeWebsiteForDedup(raw);
}

/** Строка исключена: совпал непустой ИНН, домен или имя (с уточнением, см. выше). */
function matchesExclusion(
  keys: HeBaseExclusionKeys,
  company: string,
  inn: unknown,
  website?: unknown,
): boolean {
  const innKey = normalizeInnForDedup(inn);
  if (innKey && keys.inns.has(innKey)) return true;
  const siteKey = keys.useWebsite ? companySiteKey(website) : '';
  if (siteKey && keys.sites.has(siteKey)) return true;
  const nameKey = normalizeCompanyForDedup(company);
  if (!nameKey) return false;
  const knownInns = keys.nameInns.get(nameKey);
  if (knownInns === undefined) return false;
  // Точное сравнение юрлиц только когда ИНН есть с обеих сторон.
  if (innKey && knownInns.size > 0) return knownInns.has(innKey);
  if (siteKey) {
    // То же уточнение доменом: одноимённые компании с РАЗНЫМИ собственными
    // сайтами — разные компании. Когда домена нет хотя бы с одной стороны,
    // остаёмся на консервативном матче по имени.
    const knownSites = keys.nameSites.get(nameKey);
    if (knownSites && knownSites.size > 0) return knownSites.has(siteKey);
  }
  return true;
}

/**
 * Ключи компаний из ДРУГИХ he_bases того же проекта (любой
 * source, любой статус кроме failed; текущая база исключена). Без этого одна
 * и та же компания копилась в нескольких базах проекта через повторные
 * сборки. Компания — из колонки 'company', ИНН — из 'inn', сайт — из
 * 'website' (только market='us', см. HeBaseExclusionKeys). data jsonb чужой базы и так читается целиком (одно поле
 * строки), поэтому slice до MAX_ROWS_LIMIT — лишь JS-предохранитель; он
 * обязан быть не меньше максимального размера базы: кап 10k при лимите
 * сборки до 50k отрезал хвост чужой базы из исключений, и вторая сборка
 * собирала компании 10001–50000 первой заново как «новые».
 *
 * ЦЕНА И ПОЧЕМУ ОНА ТАКАЯ. Исключению нужны три поля строки (company, inn,
 * website), а читается строка целиком — вместе с описанием компании и
 * вердиктами валидации. Спроецировать внутрь jsonb-МАССИВА PostgREST не умеет:
 * путь вида `collect_info->target_checkpoint` работает для объекта, для
 * `$[*].company` нужна SQL-функция или computed column, то есть миграция. Она
 * тут сознательно НЕ заведена: пока миграция не применена, коду пришлось бы
 * держать фолбэк на это же чтение, и выигрыш был бы нулевым.
 *
 * СКОЛЬКО РАЗ ЗА СБОРКУ это читается — считаем честно, потому что мемоизация
 * (getExcludedKeys) живёт внутри ОДНОГО прогона стадии, а сборка растянута на
 * несколько прогонов. У ENG-сборки прогонов, доходящих до HARVEST, ДВА, то есть
 * чтений тоже два: тик диспатча-и-харвеста (ENG-источники синхронные, поэтому
 * фаза HARVEST случается в том же прогоне) и тик импорта после конструктора. Тик
 * чистого ожидания конструктора не добавляет ничего — он выходит из стадии
 * раньше (см. «ТИК ЧИСТОГО ОЖИДАНИЯ КОНСТРУКТОРА») и сюда не доходит. У
 * RU-сборки с дочерними парсерами добавляется по одному чтению на каждый тик,
 * который ДИСПАТЧИТ реестр: такой тик уходит в self-requeue, не дойдя до
 * HARVEST, и его мемо умирает вместе с прогоном (тики чистого ожидания дочерних
 * джоб чтения не делают — pending-задач у них нет).
 *
 * `row_count = 0` в фильтр НЕ добавлен намеренно: у загруженной специалистом
 * базы (`source='upload'`) счётчик мог не заполниться, и такая база молча
 * выпала бы из исключения — проект начал бы собирать компании, которые у
 * клиента уже есть. Экономия была бы нулевой (у базы без строк `data` пуст),
 * а цена ошибки — оплаченный повторный сбор.
 */
async function loadOtherBaseExclusionKeys(
  ctx: HeStageContext,
  projectId: string,
  baseId: string,
  market: HeMarket,
): Promise<HeBaseExclusionKeys> {
  const { data, error } = await ctx.supabase
    .from('he_bases')
    .select('data')
    .eq('project_id', projectId)
    .neq('status', 'failed')
    .neq('id', baseId);
  if (error) throw new Error(`he_bases exclusion read: ${error.message}`);

  const keys: HeBaseExclusionKeys = {
    nameInns: new Map<string, Set<string>>(),
    inns: new Set<string>(),
    nameSites: new Map<string, Set<string>>(),
    sites: new Set<string>(),
    useWebsite: market === 'us',
  };
  for (const row of (data ?? []) as Array<{ data?: unknown }>) {
    const rows = Array.isArray(row.data) ? row.data.slice(0, MAX_ROWS_LIMIT) : [];
    for (const item of rows) {
      const rec = item as Record<string, unknown> | null;
      const innKey = normalizeInnForDedup(rec?.inn);
      if (innKey) keys.inns.add(innKey);
      const siteKey = keys.useWebsite ? companySiteKey(rec?.website) : '';
      if (siteKey) keys.sites.add(siteKey);
      const company = rec?.company;
      if (typeof company !== 'string') continue;
      const nameKey = normalizeCompanyForDedup(company);
      if (!nameKey) continue;
      let bucket = keys.nameInns.get(nameKey);
      if (!bucket) {
        bucket = new Set<string>();
        keys.nameInns.set(nameKey, bucket);
      }
      if (innKey) bucket.add(innKey);
      if (siteKey) {
        let sites = keys.nameSites.get(nameKey);
        if (!sites) {
          sites = new Set<string>();
          keys.nameSites.set(nameKey, sites);
        }
        sites.add(siteKey);
      }
    }
  }
  return keys;
}

/* ─────────────────────────── Фаза CONSTRUCT ─────────────────────────── */

/**
 * Шаги конструктора для авто-базы HE. Список ВЫБИРАЕТСЯ ПО РЫНКУ ПРОЕКТА —
 * это главное, что нужно знать про эту функцию.
 *
 * RU (staff-инструмент /tools/hypothesis-engine, работает ежедневно) — список
 * прежний, байт-в-байт: дедуп почт → (поиск на сайтах, если база бедная) →
 * ВАЛИДАЦИЯ → кап на компанию → описания.
 *
 * ENG (market='us', клиентский кабинет /client/eng) — (поиск на сайтах, если
 * база бедная) → описания → РАЗНОС АДРЕСОВ ПО СТРОКАМ → дедуп почт →
 * ВАЛИДАЦИЯ → кап на компанию.
 *
 * Почему ENG-порядок именно такой — по колонкам, которые трогает каждый шаг:
 *
 *  1. find_emails пишет найденные адреса в ОТДЕЛЬНУЮ колонку («Found Email»:
 *     target='separate' — дефолт STEP_RUNNERS воркера). Перед каждым
 *     следующим шагом воркер сливает её в исходную Email через запятую
 *     (mergeFoundEmailColumn, merge_mode по умолчанию 'all'). Значит любой шаг
 *     ПОСЛЕ поиска видит мульти-адресную ячейку — и split_emails обязан стоять
 *     после поиска: иначе найденные адреса склеятся только на финальном
 *     мёрдже, разносить их будет уже некому.
 *  2. enrich_descriptions зависит только от компании/сайта и ходит на сайт ПО
 *     СТРОКЕ (кеша по хосту у шага нет). Держим его ДО split_emails: после
 *     разноса одна компания занимает до N строк, и тот же сайт качался бы N
 *     раз — прямой путь в 6-часовой таймаут конструктора. Тот же порядок и по
 *     той же причине выбран в V2.
 *  3. split_emails — одна строка на один адрес. Ради него список и переставлен:
 *     без разноса validate_emails писал ОДИН вердикт на всю склеенную ячейку
 *     (живой и мёртвый адрес получали общий статус), cap_emails_per_company
 *     считал СТРОКИ и потому не делал ничего, а на запуске анкоренный
 *     email-регекс (clientLaunch/mapRowsToLeads) ячейку с запятой не принимал —
 *     и компания молча выпадала целиком.
 *  4. dedup_email — ПОСЛЕ разноса. До него он дедупит по ПЕРВОМУ адресу ячейки
 *     (deduplicateByEmail → extractEmail), то есть решает судьбу всей строки по
 *     одному из нескольких адресов. Вдобавок до 26.09.2026 он стоял ПЕРЕД
 *     поиском и найденных адресов не видел вовсе.
 *  5. validate_emails — теперь в ячейке один адрес, поэтому вердикт в колонке
 *     «Email Статус» принадлежит именно ему.
 *  6. cap_emails_per_company — последним: он оставляет N лучших СТРОК компании,
 *     ранжируя их по вердикту, значит ему нужны и строки (split), и статусы
 *     (validate).
 *
 * validate_emails — ВСЕГДА и в обоих рынках: раньше конструктор запускался
 * только при бедных почтах, и базы реестра/карт (email уже есть, но это
 * протухшие info@ из ЕГРЮЛ-источников) уходили в рассылку без валидации —
 * баунсы ложились на домен клиента. find_emails — только когда email есть у
 * ≤50% строк (ENG-базы pdl/funded/eng_hiring, бедные hh-сборки).
 *
 * AI-шагов (ta_scoring/personalization) нет ни в одном из списков — генерация и
 * скоринг остаются в Движке.
 */
const CONSTRUCT_STEPS_TAIL_RU = ['validate_emails', 'cap_emails_per_company', 'enrich_descriptions'];

/** ENG-хвост после поиска почт и описаний: разнос адресов обязателен (см. выше). */
const CONSTRUCT_STEPS_AFTER_SPLIT_US = [
  'split_emails',
  'dedup_email',
  'validate_emails',
  'cap_emails_per_company',
];

/** Свыше этого размера enrich_descriptions (per-site фетчи) не укладывается в
 *  6-часовой таймаут конструктора — для больших баз шаг пропускаем. */
const CONSTRUCT_ENRICH_MAX_ROWS = 5000;

/** Бедная база: адрес есть у ≤50% строк — тогда конструктор идёт искать почты. */
function emailPoorRows(rows: HeUnifiedRow[]): boolean {
  return rows.filter((r) => r.email.trim() !== '').length * 2 <= rows.length;
}

/**
 * Шаги BC-джобы под сетку `rows`.
 *
 * `harvest` — ВЕСЬ собранный merged, из которого сетка вырезана релевант-гейтом
 * (market='us'); по умолчанию это сама сетка, и тогда решения ровно те, что до
 * гейта: у RU-инструмента и у ENG-сборки, где гейт никого не снял, оба массива —
 * один и тот же объект.
 *
 * Почему тесты берут РАЗНЫЕ наборы:
 *  - «бедная база» (find_emails) — по ОБОИМ: шаг включён, если адресов мало хоть
 *    в одном. Гейт судит РЕЛЕВАНТНОСТЬ, а не наличие адреса, и снимает он именно
 *    шумные строки карт/вакансий/каталога — те, у кого адреса чаще и нет. На
 *    сетке остаток выглядит БОГАЧЕ целого, и одна прогонка мини-модели молча
 *    выключала бы поиск почт всей базе: строки без адреса (их могут быть сотни)
 *    уезжали бы в валидацию пустыми, то есть компании терялись бы совсем.
 *    Обратная ошибка так же реальна: снял гейт как раз строки С адресами —
 *    беднее оказывается сетка, и мерить только по merged значило бы выключить
 *    поиск там, где он нужен. Поэтому «или», а не выбор одного из двух: включить
 *    шаг лишний раз стоит одного обхода сайта в рамках max_pages/max_per_site/
 *    site_timeout_ms и может только ДОБАВИТЬ адрес, а не включить — стоит
 *    компаний. Монотонность здесь и есть гарантия: пометки гейта не могут отнять
 *    у базы шаг, который она получила бы без него.
 *  - enrich_descriptions — по САМОЙ сетке: порог CONSTRUCT_ENRICH_MAX_ROWS это
 *    срок на per-site фетч КАЖДОЙ строки джобы в шестичасовом окне, а строки, не
 *    попавшие в сетку, конструктор не качает вовсе. Мерить их значило бы терять
 *    описания у джобы, которой времени хватало.
 */
function constructStepsFor(
  rows: HeUnifiedRow[],
  market: HeMarket,
  harvest: HeUnifiedRow[] = rows,
): string[] {
  const poor = emailPoorRows(rows) || emailPoorRows(harvest);
  const find = poor ? ['find_emails'] : [];
  if (market !== 'us') {
    const tail =
      rows.length > CONSTRUCT_ENRICH_MAX_ROWS
        ? CONSTRUCT_STEPS_TAIL_RU.filter((s) => s !== 'enrich_descriptions')
        : CONSTRUCT_STEPS_TAIL_RU;
    return ['dedup_email', ...find, ...tail];
  }
  const enrich = rows.length > CONSTRUCT_ENRICH_MAX_ROWS ? [] : ['enrich_descriptions'];
  return [...find, ...enrich, ...CONSTRUCT_STEPS_AFTER_SPLIT_US];
}
/** Канонические заголовки сетки конструктора (порядок — как HE_AUTO_COLLECT_COLUMNS). */
const CONSTRUCT_HEADERS_RU = ['Компания', 'Сайт', 'Email', 'Телефон', 'Вакансия', 'Адрес', 'Категория', 'Сотрудники', 'Выручка', 'ИНН', 'Источник'];
const CONSTRUCT_HEADERS_EN = ['Company', 'Site', 'Email', 'Phone', 'Vacancy', 'Address', 'Category', 'Employees', 'Revenue', 'INN', 'Source'];
/** Сколько ждём BC-джобу, прежде чем считать её зависшей (база → failed). */
const CONSTRUCT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/** Пауза между тиками ожидания BC-джобы (run_after). */
const CONSTRUCT_REQUEUE_MS = 60_000;

/**
 * Джоба конструктора закончила работу: дальше импорт, а не ожидание.
 *
 * Это type guard, а не `boolean`: фаза CONSTRUCT кладёт `bcStatus` прямо в
 * `construct.status` (union из четырёх значений), и без сужения компилятор
 * перестал бы ловить чужой статус, приехавший из base_constructor_jobs.
 */
function isConstructJobSettled(status: string): status is 'completed' | 'failed' | 'cancelled' {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Шестичасовое окно ожидания конструктора истекло. У записи без
 * `dispatched_at` (collect_info до появления штампа) окна нет — поведение как
 * раньше. Один предикат на оба места, где окно проверяется: ранний выход тика
 * ожидания и терминал таймаута в фазе CONSTRUCT.
 */
function constructWaitExpired(construct: HeConstructInfo): boolean {
  return (
    !!construct.dispatched_at &&
    Date.now() - new Date(construct.dispatched_at).getTime() > CONSTRUCT_TIMEOUT_MS
  );
}

/**
 * Срок на один сайт для шага find_emails (только market='us', см. step_config
 * ниже). Своего потолка у шага нет — в отличие от enrich, который жёстко
 * режет сайт на 60 с. Худший случай на одну строку: 5 страниц по 2 попытки
 * × 15 с + 400 мс backoff, плюс прокси-ретрай 8 с на главную ≈ 170 с, и всё
 * это время строка держит 1 из 15 слотов пула. На базе в 1000 строк такой
 * хвост упирается в CONSTRUCT_TIMEOUT_MS и теряется ВСЯ база, поэтому ждать
 * молчащий сайт дольше 30 с смысла нет: адреса, найденные до срока, шаг
 * сохраняет (abort прерывает обход страниц, а не результат).
 *
 * С 26.09.2026 этот срок ещё важнее: обход больше не обрывается на первом
 * найденном адресе (stop_at_first=false, см. step_config), то есть страницы
 * из CONSTRUCT_FIND_EMAILS_MAX_PAGES теперь перебираются не в худшем случае,
 * а на КАЖДОМ живом сайте. Срок — единственное, что держит эту цену.
 */
const CONSTRUCT_FIND_EMAILS_SITE_DEADLINE_MS = 30_000;

/**
 * Страниц на сайт при глубоком обходе (market='us'). Дефолт шага — 5, берём 4:
 * столько же, сколько V2 оставил после замеров, и заведомо не больше, чем
 * обходилось до включения глубокого поиска. Контакты лежат на главной и на
 * «contact/about», хвост страниц даёт адреса всё реже, а платим за него
 * временем каждого сайта.
 */
const CONSTRUCT_FIND_EMAILS_MAX_PAGES = 4;

/**
 * Потолок адресов с одного сайта — предохранитель от «сайта-простыни»
 * (десятки адресов в футере или на team-странице), если кап на компанию
 * когда-нибудь выставят большим.
 */
const CONSTRUCT_FIND_EMAILS_PER_SITE_MAX = 10;

/**
 * Сколько адресов забирать с одного сайта: кап компании плюс один. Каждый
 * найденный адрес дальше оплачивается SMTP-пробой в validate_emails, а лишние
 * всё равно отрежет cap_emails_per_company — но уже ПОСЛЕ проверки (у V2 на
 * «все адреса с 12 страниц» доходило до 167 проверенных адресов одной
 * компании). Небольшой запас сверх капа нужен ровно затем, чтобы кап мог
 * предпочесть подтверждённый адрес catch-all'у.
 */
function constructFindEmailsPerSite(contactCap: number): number {
  return Math.min(CONSTRUCT_FIND_EMAILS_PER_SITE_MAX, contactCap + 1);
}

/** Заголовок сетки конструктора (lowercase) → унифицированная колонка / description. */
const CONSTRUCT_HEADER_MAP: Record<string, keyof HeUnifiedRow | 'description'> = {
  company: 'company',
  'компания': 'company',
  site: 'website',
  // Конструктор при locale='en' канонизирует заголовок сетки 'Site' в 'Website'
  // (EN_HEADER_ALIASES, baseConstructorWorker.normalizeEnHeaders) и сохраняет
  // переписанный заголовок в base_constructor_jobs.data. Без этого ключа
  // обратный разбор колонку не находил и домен терялся у КАЖДОЙ английской
  // базы. Остальные десять колонок EN-сетки конструктор не переименовывает.
  website: 'website',
  'сайт': 'website',
  email: 'email',
  phone: 'phone',
  'телефон': 'phone',
  vacancy: 'vacancy_title',
  'вакансия': 'vacancy_title',
  address: 'address',
  'адрес': 'address',
  category: 'category',
  'категория': 'category',
  employees: 'employees',
  'сотрудники': 'employees',
  revenue: 'revenue',
  'выручка': 'revenue',
  inn: 'inn',
  'инн': 'inn',
  source: 'source_detail',
  'источник': 'source_detail',
  description: 'description',
  'описание': 'description',
};

/**
 * Ключ компании «нормализованная компания|домен» — ровно тот, по которому
 * схлопывает строки дедуп HARVEST (dedupUnifiedRows), поэтому у merged-строк он
 * уникален, а строки, на которые split_emails разнёс адреса одной компании,
 * держат ключ своей merged-строки.
 *
 * Функция, а не два инлайна: по этому ключу релевант-гейт (см. фазу CONSTRUCT)
 * возвращает в базу строки, которых конструктор не видел, и любое расхождение
 * между «как считали при отборе» и «как считаем при возврате» пометило бы чужую
 * строку.
 */
function heCompanyRowKey(row: Pick<HeUnifiedRow, 'company' | 'website'>): string {
  return `${normalizeCompanyForDedup(row.company)}|${normalizeWebsiteForDedup(row.website)}`;
}

/**
 * Конструктор нужен всегда (см. constructStepsFor): валидация почт обязательна
 * для любых источников; поиск почт — только для бедных баз.
 */
function needsConstruct(merged: HeUnifiedRow[]): boolean {
  return merged.length > 0;
}

/** merged-строки → сетка string[][] конструктора (заголовок по локали рынка). */
function buildConstructGrid(rows: HeUnifiedRow[], market: HeMarket): string[][] {
  const headers = market === 'us' ? CONSTRUCT_HEADERS_EN : CONSTRUCT_HEADERS_RU;
  return [
    [...headers],
    ...rows.map((r) => [
      r.company, r.website, r.email, r.phone, r.vacancy_title, r.address,
      r.category, r.employees, r.revenue, r.inn, r.source_detail,
    ]),
  ];
}

/** Статус BC-джобы (null — строка потерялась: трактуем как failed без данных). */
async function readConstructJobStatus(
  ctx: HeStageContext,
  bcJobId: string,
): Promise<{ status: string; error_message: string | null; selected_steps: string[] | null } | null> {
  const { data, error } = await ctx.supabase
    .from('base_constructor_jobs')
    .select('status, error_message, workload_origin, selected_steps')
    .eq('id', bcJobId)
    .maybeSingle();
  if (error) throw new Error(`base_constructor_jobs read: ${error.message}`);
  if (!data) return null;
  if (data.workload_origin !== 'automation') await markAutomatedConstructor(ctx.supabase, bcJobId);
  const row = data as { status?: unknown; error_message?: unknown; selected_steps?: unknown };
  return {
    status: String(row.status ?? ''),
    error_message: typeof row.error_message === 'string' ? row.error_message : null,
    // Список шагов нужен импорту: результат джобы БЕЗ split_emails нельзя
    // принимать за базу с поадресными вердиктами (см. фазу CONSTRUCT).
    // null — колонку не отдали: тогда доверяем джобе, как и раньше.
    selected_steps: Array.isArray(row.selected_steps)
      ? row.selected_steps.map((s) => String(s))
      : null,
  };
}

/**
 * Создать джобу конструктора под собранные строки. Один вход для обоих
 * случаев: первичный DISPATCH-CONSTRUCT и повтор legacy-джобы, поставленной до
 * того, как split_emails стал обязательным для ENG (см. WAIT-CONSTRUCT). Общий
 * код нужен именно затем, чтобы повтор шёл по ТЕКУЩЕМУ контракту, а не по
 * копии старого.
 */
async function dispatchConstructJob(input: {
  ctx: HeStageContext;
  ownerId: string | null | undefined;
  baseLabel: string;
  rows: HeUnifiedRow[];
  /**
   * Весь harvest сборки, если сетка `rows` — его подмножество (релевант-гейт
   * до конструктора, market='us'). Нужен ровно одному решению — «бедная база»
   * в constructStepsFor; всё остальное (сетка, initial_row_count, порог
   * enrich) считается по САМОЙ сетке. Не передан — сетка и есть harvest.
   */
  harvest?: HeUnifiedRow[];
  market: HeMarket;
  /** Кап «адресов на компанию» этой базы (см. resolveContactCap у стадии). */
  contactCap: number;
}): Promise<{ bcJobId: string; locale: 'ru' | 'en'; steps: string[]; construct: HeConstructInfo }> {
  const { ctx, ownerId, baseLabel, rows, harvest, market, contactCap } = input;
  if (!ownerId) {
    throw new Error('he_projects.created_by пуст — джобе конструктора некому принадлежать');
  }
  const locale = market === 'us' ? 'en' : 'ru';
  const steps = constructStepsFor(rows, market, harvest ?? rows);
  // Настройки шага find_emails — только для ENG-пути. RU-ветка
  // staff-инструмента остаётся байт-в-байт прежней: правка дефолтов общего
  // конструктора для RU-баз — отдельное решение.
  //
  // reuse_website_description: описание берём из главной страницы, которую
  // поиск почт уже скачал. Шаг пишет его в колонку Description, а
  // enrich_descriptions строки с непустым описанием пропускает — второй
  // закачки тех же сайтов (ещё по одному фетчу на строку, 5 потоков, до
  // 60 с на сайт) не будет. Текст тот же: reusableMainPageDescription
  // применяет тот же порог 220 символов, что и fetchAndExtract, и при
  // коротком тексте возвращает пусто — такую строку enrich по-прежнему
  // обойдёт сам, со своим фоллбеком на страницу «о компании».
  //
  // stop_at_first=false — глубокий обход: по умолчанию шаг обрывается на
  // ПЕРВОМ пригодном адресе, поэтому второго адреса компании просто не
  // существовало и выбирать капу было не из чего. Цена ограничена тремя
  // рамками: страницы (max_pages), адреса с сайта (max_per_site) и срок на
  // сайт (site_timeout_ms). merge_mode НЕ задаём: дефолтный 'all' и есть то
  // самое склеивание исходного адреса с найденными, которое потом разносит
  // split_emails.
  const findEmailsConfig =
    market === 'us'
      ? {
          reuse_website_description: true,
          site_timeout_ms: CONSTRUCT_FIND_EMAILS_SITE_DEADLINE_MS,
          stop_at_first: false,
          max_per_site: constructFindEmailsPerSite(contactCap),
          max_pages: CONSTRUCT_FIND_EMAILS_MAX_PAGES,
        }
      : null;
  const bcJobId = await insertChildJob(ctx, 'base_constructor_jobs', {
    user_id: ownerId,
    workload_origin: 'automation',
    file_name: `HE · ${baseLabel}`,
    status: 'pending',
    locale,
    selected_steps: steps,
    // Кап «до N почт на компанию» — ключ max, как читает STEP_RUNNERS воркера.
    step_config: {
      cap_emails_per_company: { max: contactCap },
      ...(findEmailsConfig ? { find_emails: findEmailsConfig } : {}),
    },
    data: buildConstructGrid(rows, market),
    initial_row_count: rows.length,
    total_steps: steps.length,
  });
  return {
    bcJobId,
    locale,
    steps,
    construct: {
      bc_job_id: bcJobId,
      status: 'dispatched',
      dispatched_at: new Date().toISOString(),
      contact_cap: contactCap,
    },
  };
}

export interface HeConstructImport {
  rows: Array<HeUnifiedRow & { description: string }>;
  /**
   * Вердикт валидации (колонка «Email Статус») по каждой строке rows,
   * lowercase; null — колонки статуса в сетке не было / у строки пусто.
   * Нужен refill-ветке (ENG auto-pipeline): в лиды идут только 'ok'.
   */
  emailStatuses: Array<string | null>;
  /** Почт найдено (result_stats.emails_found; фолбэк — строки с email). */
  emailsFound: number;
  /** Почт с вердиктом ok (колонка «Email Статус»; 0, если валидация не дошла). */
  validCount: number;
  /** В сетке была колонка описания — добавить 'description' в заголовки базы. */
  hasDescription: boolean;
}

/**
 * Сетка завершённой BC-джобы → унифицированные строки. Маппинг по имени
 * заголовка (RU/EN каноника + Description/Описание); лишние колонки шагов
 * («Email Статус» и пр.) в базу не переносятся. email — первый адрес
 * merged-ячейки (контракт he_bases — один email на строку). Строки без
 * компании отбрасываются. null — данных нет/пусто (импортировать нечего).
 */
async function importConstructRows(ctx: HeStageContext, bcJobId: string): Promise<HeConstructImport | null> {
  const { data, error } = await ctx.supabase
    .from('base_constructor_jobs')
    .select('data, result_stats')
    .eq('id', bcJobId)
    .maybeSingle();
  if (error) throw new Error(`base_constructor_jobs data read: ${error.message}`);
  const grid = (data as { data?: unknown } | null)?.data;
  if (!Array.isArray(grid) || grid.length < 2) return null;

  const header = (grid[0] as unknown[]).map((h) => String(h ?? '').trim().toLowerCase());
  const idxByKey = new Map<string, number>();
  header.forEach((h, i) => {
    const key = CONSTRUCT_HEADER_MAP[h];
    if (key && !idxByKey.has(key)) idxByKey.set(key, i);
  });
  const statusIdx = header.indexOf('email статус');

  const rows: Array<HeUnifiedRow & { description: string }> = [];
  const emailStatuses: Array<string | null> = [];
  let validCount = 0;
  for (const bodyRow of grid.slice(1) as unknown[][]) {
    const get = (key: keyof HeUnifiedRow | 'description'): string => {
      const idx = idxByKey.get(key);
      return idx === undefined ? '' : String(bodyRow[idx] ?? '').trim();
    };
    const company = get('company');
    // Мусорные строки (пустая/схлопнутая компания) — как на HARVEST: выбросить.
    if (!normalizeCompanyForDedup(company)) continue;
    const emailStatus = statusIdx >= 0 ? String(bodyRow[statusIdx] ?? '').trim().toLowerCase() : '';
    if (emailStatus === 'ok') validCount += 1;
    emailStatuses.push(emailStatus || null);
    rows.push({
      ...unifiedRow({
        company,
        website: get('website'),
        // Мerged-ячейка может держать несколько адресов через запятую —
        // в базе один email на строку: первый (исходный приоритетнее scrape).
        email: extractEmail(get('email')) ?? '',
        phone: get('phone'),
        vacancy_title: get('vacancy_title'),
        address: get('address'),
        category: get('category'),
        employees: get('employees'),
        revenue: get('revenue'),
        inn: get('inn'),
        source_detail: get('source_detail'),
      }),
      description: get('description'),
    });
  }
  if (rows.length === 0) return null;

  const stats = (data as { result_stats?: unknown } | null)?.result_stats as { emails_found?: unknown } | null;
  const emailsFound =
    typeof stats?.emails_found === 'number' && Number.isFinite(stats.emails_found)
      ? stats.emails_found
      : rows.filter((r) => r.email !== '').length;
  return { rows, emailStatuses, emailsFound, validCount, hasDescription: idxByKey.has('description') };
}

/* ────────── Пост-импортный кап: «N компаний × до K адресов» ────────── */

/**
 * Ранг вердикта валидации при выборе, какие адреса компании оставить: копия
 * таблицы шага cap_emails_per_company (lib/tools/processingSteps.ts,
 * STATUS_RANK) — ok > catch_all > unknown > error > invalid > disposable,
 * незнакомый вердикт ниже всех. Дубль намеренный: тянуть в воркер весь модуль
 * шагов конструктора ради шести чисел дороже, чем держать копию рядом с местом
 * применения. При правке рангов правятся ОБА места, иначе кап конструктора и
 * кап здесь оставят разные адреса одной компании.
 */
const IMPORT_STATUS_RANK: Record<string, number> = {
  ok: 5,
  catch_all: 4,
  unknown: 3,
  error: 2,
  invalid: 1,
  disposable: 0,
};

/** Строка без адреса не уедет никуда — она проигрывает любому адресу. */
function importedRowRank(email: string, status: string | null): number {
  if (email.trim() === '') return -2;
  return IMPORT_STATUS_RANK[(status ?? '').trim().toLowerCase()] ?? -1;
}

export interface HeImportCapResult<T> {
  rows: T[];
  /** Вердикты, параллельные rows (исходный порядок строк сохранён). */
  emailStatuses: Array<string | null>;
  /** Компаний в базе после капа — уникальных ключей «компания|домен». */
  companies: number;
  /** Адресов с вердиктом 'ok' среди ОСТАВЛЕННЫХ строк. */
  validCount: number;
  /** Адресов отброшено сверх капа «адресов на компанию». */
  droppedOverContactCap: number;
  /** Строк отброшено у компаний сверх лимита сборки. */
  droppedOverCompanyCap: number;
}

/**
 * Наложить на импортированную сетку конструктора ОБА числа, которые обещаны
 * клиенту: «не больше companyCap компаний» (лимит сборки) и «не больше
 * contactCap адресов у одной компании».
 *
 * Зачем повторно, если кап есть у конструктора (шаг cap_emails_per_company):
 * шаг живёт в ЧУЖОМ процессе, и его может не оказаться в результате.
 *  - Джоба упала или отменена на неизвестном шаге, а частичную сетку импорт
 *    принимает (и правильно: платить второй раз не за что). Если она
 *    оборвалась после split_emails, но до cap_emails_per_company, база до
 *    26.09.2026 уезжала со ВСЕМИ найденными адресами: глубокий обход берёт с
 *    сайта до constructFindEmailsPerSite адресов, то есть до десяти строк на
 *    компанию вместо выбранных клиентом.
 *  - Список шагов джобы мог быть собран старым кодом (см. проверку
 *    split_emails в фазе CONSTRUCT).
 * Кап после импорта делает число клиента правдой независимо от того, чем
 * кончилась джоба, — и ровно поэтому штамп contact_cap_applied теперь ставится
 * у любого импорта, а не только у дошедшей до конца джобы.
 *
 * Ключ компании — тот же, что у дедупа HARVEST (нормализованные компания и
 * домен), поэтому группы соответствуют merged-строкам один-к-одному: строки,
 * на которые split_emails разнёс адреса одной merged-строки, держат её company
 * и website. Отсюда два следствия. У ДОШЕДШЕЙ до конца ENG-джобы кап
 * идемпотентен — конструктор уже оставил ≤ contactCap строк на компанию.
 * RU-сборку staff-инструмента он не меняет вовсе: без split_emails у каждой
 * компании ровно одна строка (дедуп HARVEST схлопнул повторы), а companyCap
 * равен лимиту сборки, которого merged-строки уже не превышают.
 *
 * Компании сверх companyCap — инвариант, а не рабочая ветка: сетка приходит из
 * merged, где строк уже не больше лимита. Считаем и записываем в воронку на
 * случай, если конструктор когда-нибудь вернёт строки компаний, которых мы ему
 * не отдавали: молча потерять оплаченные компании нельзя.
 *
 * Пустой базы кап не делает никогда: у каждой компании остаётся минимум одна
 * строка, а companyCap ≥ 1 оставляет минимум одну компанию.
 */
export function capImportedRows<T extends HeUnifiedRow>(input: {
  rows: T[];
  emailStatuses: Array<string | null>;
  contactCap: number;
  companyCap: number;
}): HeImportCapResult<T> {
  const { rows, emailStatuses } = input;
  // Кап 0 обнулил бы оплаченную сборку: мусор в настройке не должен
  // превращаться в «ни одного адреса» (та же граница, что у
  // normalizeHeMaxEmailsPerCompany).
  const contactCap = Math.max(1, input.contactCap);
  const companyCap = Math.max(1, input.companyCap);

  const groups = new Map<string, number[]>();
  rows.forEach((row, i) => {
    const key = heCompanyRowKey(row);
    const idxs = groups.get(key);
    if (idxs) idxs.push(i);
    else groups.set(key, [i]);
  });

  const keep = new Set<number>();
  let companies = 0;
  let droppedOverContactCap = 0;
  let droppedOverCompanyCap = 0;
  for (const idxs of groups.values()) {
    // Порядок групп — первое появление компании в сетке, то есть порядок
    // приоритета задач плана (round-robin мёрджа): при переполнении уходят
    // последние компании, а не случайные.
    if (companies >= companyCap) {
      droppedOverCompanyCap += idxs.length;
      continue;
    }
    companies += 1;
    if (idxs.length <= contactCap) {
      for (const i of idxs) keep.add(i);
      continue;
    }
    // Оставляем лучшие адреса компании по вердикту, при равенстве — порядок
    // сетки. Выходной порядок строк остаётся исходным (фильтр по keep ниже).
    const ranked = [...idxs].sort((a, b) => {
      const rb = importedRowRank(rows[b].email, emailStatuses[b] ?? null);
      const ra = importedRowRank(rows[a].email, emailStatuses[a] ?? null);
      return rb - ra || a - b;
    });
    for (const i of ranked.slice(0, contactCap)) keep.add(i);
    droppedOverContactCap += idxs.length - contactCap;
  }

  const keptRows: T[] = [];
  const keptStatuses: Array<string | null> = [];
  // Валидных считаем по ОСТАВЛЕННЫМ строкам: кабинет показывает это число
  // рядом с row_count («N of M rows with a verified email»), и счёт по сетке
  // ДО капа дал бы «валидных больше, чем строк в базе».
  let validCount = 0;
  rows.forEach((row, i) => {
    if (!keep.has(i)) return;
    const status = emailStatuses[i] ?? null;
    if (status === 'ok') validCount += 1;
    keptRows.push(row);
    keptStatuses.push(status);
  });

  return {
    rows: keptRows,
    emailStatuses: keptStatuses,
    companies,
    validCount,
    droppedOverContactCap,
    droppedOverCompanyCap,
  };
}

/**
 * Релевант-гейт ENG-сборки, отработавший ДО конструктора: дешёвый префильтр без
 * модели, затем мини-модель по merged-строкам, и обе пометки — в один набор
 * ключей компаний для collect_info.
 *
 * Почему до конструктора. Гейту нужны только company/website/category/
 * vacancy_title — все четыре поля есть сразу после HARVEST, а конструктор не
 * добавляет ни одного из них. Пока гейт стоял ПОСЛЕ импорта, каждая
 * вычеркнутая строка успевала пройти весь конструктор — при том, что и запуск
 * (launchTemplate), и ночной долив (baseCollectRefill) всё равно выбрасывают её
 * по _low_relevance.
 *
 * Что именно на ней тратилось — БЕЗ преувеличений: платных провайдеров шаги
 * конструктора не зовут (поиск почт — свой краул, валидация — node dns/net),
 * поэтому за строку доллары не списываются. Тратятся обход её сайта (до 4
 * страниц и до 30 с в одном из 15 слотов пула), прокси-трафик, часы воркера и
 * доля шестичасового окна ожидания джобы: чем больше таких строк в сетке, тем
 * ближе база к таймауту, в котором теряется ВСЯ база.
 *
 * Сама модель гейта тоже дешевеет: после split_emails у компании столько строк,
 * сколько адресов нашлось, и гейт судил одну компанию по несколько раз, упираясь
 * при этом во внутренний кап MAX_ROWS_TO_CHECK — то есть у большой базы часть
 * компаний не судилась вовсе. По merged-строкам одна компания = одна строка: тот
 * же кап покрывает больше компаний за меньшее число батчей.
 *
 * Never-throw: любой сбой = «никто не помечен», и сборка идёт дальше целиком.
 * Fail-open здесь обязателен — разовый отказ провайдера не должен превращаться
 * в пустой запуск (поэтому пометки «не проверено» в фильтрах запуска и добора
 * нет и не будет).
 *
 * Но fail-open ≠ «считать, что судили». Отказ возвращается с ran=false, и это
 * ОТДЕЛЬНЫЙ исход от «судили, никого не вычеркнули»: по ran=false вызывающий
 * судит заново на следующем тике, а дошедшую до импорта базу проверяет прежним
 * путём после импорта. Судить по одному пустому flagged_keys нельзя — у обоих
 * исходов он пустой.
 */
async function judgeRowsBeforeConstruct(input: {
  ctx: HeStageContext;
  rows: HeUnifiedRow[];
  vertical: HeVertical;
  brief?: Record<string, unknown> | null;
}): Promise<HeRelevanceGateInfo> {
  const { ctx, rows, vertical, brief } = input;
  const judgedAt = new Date().toISOString();
  // Префильтр — до модели: его строки модели не отдаём, это единственная
  // экономия, которую он приносит (и она нулевая, пока маркеров нет, см.
  // heOffTargetMarkersFor).
  const offTarget = findOffTargetRows(rows, heOffTargetMarkersFor({ vertical, brief }));
  const judged = offTarget.size > 0 ? rows.filter((_, i) => !offTarget.has(i)) : rows;
  const flaggedKeys = new Set<string>();
  for (const i of offTarget) flaggedKeys.add(heCompanyRowKey(rows[i]));
  let checked = 0;
  let judgedRows = 0;
  let tokensUsed = 0;
  let costUsd = 0;
  let error: string | null = null;
  try {
    const gate = await findIrrelevantRows({
      rows: judged,
      verticalName: vertical.name,
      verticalSummary: vertical.summary ?? '',
      language: 'en',
      log: (m) => stageLog(ctx, m),
    });
    checked = gate.checkedRows;
    judgedRows = gate.judgedRows;
    tokensUsed = gate.tokensUsed;
    costUsd = gate.costUsd;
    // Индексы гейта — во входном массиве judged, поэтому ключ берём из него же.
    for (const i of gate.flagged) flaggedKeys.add(heCompanyRowKey(judged[i]));
    // Ни одного вердикта на непустом входе: модуль глотает падение батча сам
    // (never-throw), поэтому «все батчи упали» приходит сюда молча — как пустой
    // flagged при checkedRows>0. Это НЕ суд.
    if (judgedRows === 0 && judged.length > 0) {
      error =
        checked === 0
          ? `гейту нечего было судить: у вертикали «${vertical.name}» пустое имя`
          : `модель не дала ни одного вердикта по ${checked} строкам`;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  if (error) stageLog(ctx, `[base_collect] релевант-гейт не отработал: ${error}`);
  return {
    // Суд состоялся, если вердикт получила хоть одна строка ЛИБО судить моделью
    // было нечего, потому что префильтр снял всё сам (детерминированный проход,
    // модель ему не нужна).
    ran: error === null,
    ...(error ? { error: error.slice(0, 300) } : {}),
    checked,
    judged: judgedRows,
    off_target: offTarget.size,
    flagged_keys: [...flaggedKeys],
    tokens_used: tokensUsed,
    cost_usd: costUsd,
    judged_at: judgedAt,
  };
}

/**
 * Поставить стадию анализа базы, если её ещё нет.
 *
 * Дедуп той же формы, что у остальных постановок движка (ручной роут
 * bases/[id]/template, дочейн автопилота, ремонт осиротевшей базы в
 * autopilotNext): активная джоба этой стадии по этой базе уже есть → второй не
 * ставим. Без него каждый повторный вход в финал сборки — а их стало больше,
 * см. ниже про незакрытую пару, — ставил ВТОРОЙ base_analyze, то есть платил за
 * анализ одной и той же базы дважды.
 *
 * Ошибку ЧТЕНИЯ дедупа бросаем, а не глотаем: пустой список после сбоя чтения
 * означает не «джобы нет», а «неизвестно», и вставка на этом месте — платный
 * анализ «на догадке».
 */
async function ensureBaseAnalyzeJob(
  ctx: HeStageContext,
  job: HeJob,
  baseId: string,
): Promise<'enqueued' | 'existing'> {
  const { data: active, error: activeErr } = await ctx.supabase
    .from('he_jobs')
    .select('id, payload')
    .eq('project_id', job.project_id)
    .eq('stage', 'base_analyze')
    .in('status', ['pending', 'running']);
  if (activeErr) throw new Error(`he_jobs base_analyze dedup read: ${activeErr.message}`);
  const queued = (active ?? []).some(
    (j) => (j.payload as { base_id?: unknown } | null)?.base_id === baseId,
  );
  if (queued) return 'existing';

  const { error: jobError } = await ctx.supabase.from('he_jobs').insert({
    project_id: job.project_id,
    stage: 'base_analyze',
    status: 'pending',
    payload: { base_id: baseId },
  });
  if (jobError) throw new Error(`he_jobs base_analyze enqueue: ${jobError.message}`);
  return 'enqueued';
}

/* ─────────────────────────── Стадия ─────────────────────────── */

export async function runBaseCollectStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  const usage = newUsage();
  const baseId = payloadString(job, 'base_id');
  // Лимит сборки из payload (route кладёт туда выбор пользователя): один на
  // всё — пагинация реестра, чтение дочерних джоб, итоговый кап базы. У
  // refill-сборки ниже уменьшается под дневной кап лидов проекта («РАЗМЕР
  // REFILL-СБОРКИ»), поэтому let, а не const.
  let limit = totalRowsCap(job);
  // Refill-режим ENG auto-pipeline: финал — долив в запущенную кампанию
  // (stages/baseCollectRefill.ts), а не analyzing + base_analyze.
  const isRefill = job.payload?.refill === true;

  const { data: baseRow, error: bError } = await ctx.supabase
    .from('he_bases')
    .select('*')
    .eq('id', baseId)
    .single();
  if (bError || !baseRow) throw new Error(`he_bases ${baseId}: ${bError?.message ?? 'not found'}`);
  const base = baseRow as HeAutoBase;

  if (base.source !== 'auto') {
    throw new Error(`he_bases ${baseId}: source='${base.source ?? 'upload'}' — base_collect работает только с source='auto'`);
  }
  if (base.status !== 'collecting') {
    /**
     * НЕЗАКРЫТАЯ ПАРА «база в analyzing + поставленный base_analyze».
     *
     * Финал сборки пишет её двумя запросами (harvest-апдейт со статусом
     * 'analyzing', затем вставка base_analyze), и в щель между ними попадали
     * смерть пода и блип БД. Атомарной пару сделать нечем: это две таблицы, а
     * PostgREST транзакции не даёт; поменять порядок — тоже нельзя, стадия
     * base_analyze своего гейта готовности не имеет и на базе без строк
     * оплатила бы вызов модели по нулю строк, выставив ей 'analyzed'.
     *
     * Поэтому пара закрывается ИДЕМПОТЕНТНО, повтором этой же джобы: строки
     * собраны (row_count/columns непусты — тот же признак годности к анализу, по
     * которому судит ремонт в autopilotNext), harvest оплачен, и единственное,
     * чего не хватает, — бесплатная вставка he_jobs. Раньше повтор умирал здесь
     * с «сборка уже завершена», джоба сгорала тремя попытками, и база
     * оставалась осиротевшей до ремонта из финального фейла (worker/
     * hypothesisEngine: repairBaseAfterCollectFinalFail) или до следующего
     * прохода автопилота. Теперь тот же ремонт — на первом же повторе, бесплатно
     * и без единого платного вызова: ни PLAN, ни CONSTRUCT, ни релевант-гейт
     * второй раз не исполняются, потому что до них дело не доходит.
     *
     * Refill сюда не относится: у долива нет фазы анализа вовсе, его терминалы
     * пишет baseCollectRefill.
     */
    const analyzingRows = typeof base.row_count === 'number' ? base.row_count : 0;
    const analyzingColumns = Array.isArray(base.columns) ? base.columns.length : 0;
    if (!isRefill && base.status === 'analyzing' && analyzingRows > 0 && analyzingColumns > 0) {
      const outcome = await ensureBaseAnalyzeJob(ctx, job, baseId);
      stageLog(
        ctx,
        `[base_collect] база уже в analyzing со ${analyzingRows} собранными строками: ` +
          `сборка закончена, ${outcome === 'enqueued' ? 'доставлен пропавший' : 'анализ уже поставлен'} base_analyze`,
      );
      return {
        result: { base_id: baseId, rows: analyzingRows, analysis_enqueue: outcome },
        tokensUsed: usage.tokensUsed,
        costUsd: usage.costUsd,
      };
    }
    throw new Error(`he_bases ${baseId}: status='${base.status}' — сборка уже завершена или не начиналась`);
  }

  const { data: verticalRow, error: vError } = await ctx.supabase
    .from('he_verticals')
    .select('*')
    .eq('id', base.vertical_id)
    .single();
  if (vError || !verticalRow) {
    throw new Error(`he_verticals ${base.vertical_id}: ${vError?.message ?? 'not found'}`);
  }
  const vertical = verticalRow as HeVertical;

  const project = await readProject(ctx.supabase, job.project_id);
  // Рынок проекта: выбор промпта планировщика (EN-источники при 'us').
  // ctx.market прокидывает воркер, фолбэк — колонка he_projects.market.
  const market = ctx.market ?? projectMarket(project);

  // Кап «адресов на компанию» для этой базы: штамп с проекта, поставленный при
  // постановке сборки (baseCollectEnqueue), иначе дефолт движка — прежняя
  // пятёрка. Проект читаем НЕ здесь: значение должно быть стабильным на всю
  // сборку, а перечитывание давало бы разный кап на разных тиках одной джобы.
  const ownContactCap = normalizeHeMaxEmailsPerCompany(base.max_emails_per_company);
  const contactCap = ownContactCap ?? HE_MAX_EMAILS_PER_COMPANY_DEFAULT;
  // Непустое значение на строке доказывает, что миграция
  // 20260926_0001_he_emails_per_company.sql применена, — значит и колонку
  // contact_cap_applied писать безопасно. Без этой проверки финальный апдейт
  // оплаченной сборки мог бы упасть на неизвестной колонке.
  const contactCapColumnsPresent = ownContactCap !== null;

  const info: HeCollectInfo =
    base.collect_info && typeof base.collect_info === 'object' ? base.collect_info : {};

  // ─── РАЗМЕР REFILL-СБОРКИ ───
  // Ночной долив просит КОМПАНИИ, а его дневной бюджет daily_leads_cap считает
  // СТРОКИ-лиды, и одна компания после разноса адресов даёт их до contactCap.
  // Пока объём сборки был флэтовым (HE_AUTO_REFILL_ROWS_LIMIT), лишние компании
  // проходили оплаченный краул сайта и SMTP-пробу на каждый адрес, который кап
  // того же вечера выбросит, и при этом оставались выжженными: база уходит в
  // 'analyzed', её компании исключены из будущих сборок проекта
  // (loadOtherBaseExclusionKeys), вернуть их нельзя. Перевод «лиды → компании» и
  // запас на компании без допущенного адреса здесь НЕ дублируются — их считает
  // resolveHeRefillCollectCompanies (stages/baseCollectRefill.ts), рядом с самим
  // доливом, иначе два числа со временем разъехались бы. Расчёт умеет только
  // УМЕНЬШИТЬ сборку (внутри min с payloadLimit): рост объёма — новые деньги и
  // решение владельца, а не функции.
  //
  // Считается ДО DISPATCH: платит сборка, а не долив. Итог штампуется в
  // collect_info.limit и на следующих тиках берётся оттуда — лимит обязан быть
  // один на всю сборку (как contactCap выше), и долив читает это же поле как
  // stats.company_limit, «с каким лимитом сборка реально шла». Ни одно правило
  // допуска (вердикт валидации, чёрный список, возврат компаний при отказе, кап
  // компаний) этим не затрагивается: меняется только СКОЛЬКО компаний собирать.
  if (isRefill) {
    const plannedLimit =
      typeof info.limit === 'number' && Number.isFinite(info.limit)
        ? Math.min(limit, info.limit)
        : limit;
    limit = await resolveHeRefillCollectCompanies(ctx, {
      projectId: job.project_id,
      payloadLimit: plannedLimit,
      contactCap,
    });
    if (limit < plannedLimit) {
      stageLog(
        ctx,
        `[base_collect] refill: лимит сборки ${plannedLimit} → ${limit} компаний под дневной кап ` +
          `лидов проекта (до ${contactCap} адресов на компанию)`,
      );
    }
    if (info.limit !== limit) {
      info.limit = limit;
      await persistCollectInfo(ctx, baseId, info);
    }
  }

  /**
   * Закладки каталога вертикали — ЛЕНИВО, ровно как ключи чужих баз.
   *
   * Тик чистого ожидания конструктора до DISPATCH не доходит и к стору не
   * обращается; за всю ENG-сборку чтение одно — тик, который строит план и/или
   * диспатчит каталожные задачи. `market !== 'us'` не читает стор никогда: у
   * RU-плана каталог — это реестр со своей закладкой в задаче.
   */
  let catalogRun: HeCatalogRun | null = null;
  let catalogLoaded = false;
  const getCatalog = async (): Promise<HeCatalogRun | null> => {
    if (market !== 'us') return null;
    if (!catalogLoaded) {
      catalogLoaded = true;
      const stored = await loadHeCatalogCursor(ctx.supabase, base.vertical_id, (m) => stageLog(ctx, m));
      catalogRun = createHeCatalogRun(ctx, { verticalId: base.vertical_id, market, stored });
    }
    return catalogRun;
  };

  // ─── PLAN ───
  /**
   * Вход планировщика этого тика. Нужен ДВУМ местам: самой фазе PLAN и платному
   * расширению плана после DISPATCH. Читается бесплатно (гипотезы + вокабуляр),
   * поэтому ленивый геттер ниже, а не обязательное чтение на каждом тике.
   */
  let planInput: HePlanInput | null = null;
  /**
   * Тот же вход для тика, который фазу PLAN НЕ проходил (план уже сохранён, а
   * задачи ещё pending: джоба умерла между записью плана и диспатчем — это одна
   * запись, поэтому состояние достижимо). Ошибку здесь НЕ бросаем: в фазе PLAN
   * она честный фейл сборки, а расширение плана — улучшение, и его отказ обязан
   * оставить сборку такой, какой она была бы без него.
   */
  const getPlanInput = async (): Promise<HePlanInput | null> => {
    if (planInput) return planInput;
    try {
      planInput = await collectPlanInput(job, ctx, vertical, market);
    } catch (e) {
      stageLog(
        ctx,
        `[base_collect] вход планировщика перечитать не удалось: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
    return planInput;
  };
  if (!info.plan) {
    // Вход планировщика читается бесплатно (гипотезы + вокабуляр) — по его хешу
    // и решается, нужен ли платный вызов модели вообще. Бросает здесь, как и
    // раньше: пустое пересечение с выбором специалиста — честный фейл.
    const planned = await collectPlanInput(job, ctx, vertical, market);
    planInput = planned;
    const catalog = await getCatalog();
    const reusedPlan = catalog?.reusablePlan(planned.planKey) ?? null;
    // Провенанс плана считаем всегда по ТЕКУЩЕМУ чтению гипотез, а не копией из
    // стора: иначе переиспользование показывало бы вчерашнюю разметку.
    info.hypotheses = planned.usedHypotheses;
    let planRepair: HePlanRepair | undefined;
    let sliceProbe: HeSliceProbe | undefined;
    if (reusedPlan) {
      // Тот же вход планировщика, что и у сохранённого плана: срезы те же, и
      // закладки в сторе указывают ровно в них. Экономия — вызов планировщика
      // и проба среза, то есть весь платёж фазы PLAN.
      info.plan = reusedPlan;
      stageLog(
        ctx,
        `[base_collect] план источников взят из закладки вертикали (${reusedPlan.tasks.length} задач: ` +
          `${reusedPlan.tasks.map((t) => t.source).join(', ')}) — планировщик и проба среза не оплачиваются`,
      );
    } else {
      const built = await buildPlan(ctx, vertical, planned, usage, market);
      info.plan = built.plan;
      planRepair = built.planRepair;
      sliceProbe = built.sliceProbe;
    }
    if (planRepair) info.plan_repair = planRepair;
    if (sliceProbe) info.slice_probe = sliceProbe;

    // Отказ пробы: срез не про эту вертикаль и перепланирование не помогло.
    // Сохраняем провенанс и валим сбор ДО дозвона до коллекторов — час
    // конструктора и рассылка по мусору дороже пропущенной вертикали.
    if (sliceProbe?.outcome === 'rejected') {
      info.tasks = [];
      const examples = sliceProbe.off_target_examples?.slice(0, 3).join(', ');
      const note =
        `Вертикаль «${vertical.name}» не покрывается каталогом: в пробе среза подошло ` +
        `${Math.round(sliceProbe.hit_rate * 100)}% из ${sliceProbe.sampled} компаний` +
        (examples ? ` (мимо: ${examples})` : '') +
        '. База не собиралась — рассылка по такому срезу навредила бы рабочим вертикалям.';
      // Базу валим здесь же, с этой причиной (как путь «ноль строк»). Отдать её
      // воркеру нельзя: отказ — решение, а не транзиент, но failJob ретраит до
      // MAX_ATTEMPTS, и повторные попытки (план уже сохранён, tasks=[]) умерли
      // бы в других ветках, перетерев причину на «план пуст» / start-guard.
      await ctx.supabase
        .from('he_bases')
        .update({
          status: 'failed',
          error: note.slice(0, 500),
          collect_info: dropCollectWorkState(info),
          updated_at: new Date().toISOString(),
        })
        .eq('id', baseId);
      throw new Error(note);
    }
    info.tasks = info.plan.tasks.map((task) => ({
      source: task.source,
      status: 'pending' as const,
      child_job_id: null,
      rows: 0,
      task,
    }));
    await persistCollectInfo(ctx, baseId, info);
    // Новый план — в стор вертикали: следующая ночь возьмёт его вместо платного
    // вызова, и её закладки совпадут по ключу фильтров с этими срезами. Отказ
    // записи ничего не ломает — будет оплачен ещё один план.
    if (!reusedPlan) await catalog?.rememberPlan(info.plan, planned.planKey);
    stageLog(ctx, `[base_collect] план: ${info.tasks.length} задач (${info.tasks.map((t) => t.source).join(', ')})`);
  }
  const tasks = info.tasks ?? [];

  /**
   * ТИК ЧИСТОГО ОЖИДАНИЯ КОНСТРУКТОРА — выходим до всего остального.
   *
   * Фаза CONSTRUCT растянута на десятки заходов джобы (пауза 60 с, окно до 6 ч),
   * и джоба перезапускает стадию С НАЧАЛА. Пока BC-джоба ещё работает, такой тик
   * НЕ МОЖЕТ ничего решить: задачи все settled (фаза CONSTRUCT начинается только
   * после `waiting.length === 0`, а статус задачи назад никто не пишет), поэтому
   * DISPATCH и WAIT — пустые проходы, и весь тик сводится к «опросить BC-джобу и
   * уснуть». До этой правки он попутно:
   *  - перечитывал `data` ВСЕХ прочих баз проекта (loadOtherBaseExclusionKeys) —
   *    у зрелого проекта это десятки МБ на тик, а результат тика выбрасывался;
   *  - заново мёржил и дедуплицировал до 4 × limit строк харвеста;
   *  - ПЕРЕПИСЫВАЛ `he_bases.collect_info` целиком тем же значением
   *    (persistCollectInfo ниже безусловен) — до 82 МБ jsonb каждые 60 с.
   *
   * Что осталось прежним: сам опрос BC-джобы, пауза 60 с и self-requeue. Окно
   * таймаута и терминальный статус спрашиваем ТЕМИ ЖЕ предикатами, что и фаза
   * CONSTRUCT ниже, — и любой их исход, кроме «джоба ещё идёт», проваливается в
   * обычный путь, где живут импорт, повтор без split_emails и терминал таймаута
   * (ему нужна воронка `stats`, то есть полный мёрдж).
   *
   * Побочно закрыт отказ: у тика ожидания мёрдж мог сжаться до нуля (соседняя
   * сборка проекта забрала те же компании), и ветка «ноль строк» валила базу в
   * 'failed' ПОВЕРХ живой, уже оплаченной джобы конструктора — результат
   * терялся молча.
   */
  const awaitedConstruct = info.construct;
  if (
    awaitedConstruct?.status === 'dispatched' &&
    awaitedConstruct.bc_job_id &&
    !constructWaitExpired(awaitedConstruct)
  ) {
    // Цена: на тике, который ДОЙДЁТ до импорта, статус BC-джобы читается дважды
    // (здесь и в фазе CONSTRUCT) — один запрос по первичному ключу за одну
    // сборку. Протаскивать значение через две фазы дороже, чем этот запрос.
    const awaited = await readConstructJobStatus(ctx, awaitedConstruct.bc_job_id);
    if (awaited && !isConstructJobSettled(awaited.status)) {
      await requeueSelf(ctx, job, CONSTRUCT_REQUEUE_MS);
      return {
        result: { waiting: true, base_id: baseId, construct: awaited.status },
        tokensUsed: usage.tokensUsed,
        costUsd: usage.costUsd,
      };
    }
  }

  // Ключи компаний других баз проекта: нужны реестру ещё на DISPATCH
  // (исключение на выборке — продолжение больших сегментов) и повторно на
  // HARVEST (страховка для строк hh/карт). Лениво + мемоизация: внутри ОДНОГО
  // прогона чтение одно, на тиках чистого ожидания дочерних парсеров его нет
  // вовсе, а тик ожидания конструктора до этого места уже не доходит (ранний
  // выход выше). Мемо умирает вместе с прогоном, поэтому за всю ENG-сборку
  // чтений два — прогон диспатча-и-харвеста и прогон импорта (полный расчёт,
  // включая RU-тики с дочерними парсерами, — в доке loadOtherBaseExclusionKeys).
  let excludedKeysCache: HeBaseExclusionKeys | null = null;
  const getExcludedKeys = async (): Promise<HeBaseExclusionKeys> => {
    if (!excludedKeysCache) {
      excludedKeysCache = await loadOtherBaseExclusionKeys(ctx, job.project_id, baseId, market);
    }
    return excludedKeysCache;
  };

  // ─── DISPATCH ───
  // Закладки нужны только тику, который реально диспатчит каталожную задачу.
  const dispatchCatalog = tasks.some((t) => t.status === 'pending' && isHeCatalogSource(t.source))
    ? await getCatalog()
    : null;
  // Режим расширения среза читается один раз на ТИК, а не на каждую каталожную
  // задачу: иначе строка про нераспознанное значение переменной окружения
  // печаталась бы по разу на задачу. Вне market='us' расширения нет вовсе — и
  // решает это РЫНОК, а не наличие закладок: тик, диспатчащий только карты,
  // каталожного прогона не заводит, но платное расширение плана на нём ещё
  // может понадобиться.
  const widenMode: HeWidenMode = market === 'us' ? heWidenMode(ctx) : 'off';
  const runDispatch = async (state: HeCollectTaskState, catalog: HeCatalogRun | null): Promise<void> => {
    try {
      await dispatchTask(ctx, state, project, limit, getExcludedKeys, catalog, widenMode);
      stageLog(
        ctx,
        `[base_collect] dispatch ${state.source}: ${state.status}` +
          `${state.child_job_id ? ` (job ${state.child_job_id})` : ''}, строк: ${state.rows}`,
      );
    } catch (e) {
      state.status = 'failed';
      state.error = e instanceof Error ? e.message : String(e);
      stageLog(ctx, `[base_collect] dispatch ${state.source} упал: ${state.error}`);
    }
    await persistCollectInfo(ctx, baseId, info);
    // Сдвиг закладки — строго ПОСЛЕ префикса строк, и только после его успешной
    // записи: потерянный сдвиг стоит одного лишнего скана следующей ночью,
    // потерянный префикс при уехавшем сдвиге стоил бы компаний, которых больше
    // никто не прочитает. Запись закладки не бросает by design.
    if (catalog) await catalog.flush();
  };
  for (const state of tasks) {
    if (state.status !== 'pending') continue;
    await runDispatch(state, dispatchCatalog);
  }

  /**
   * ПЛАТНОЕ РАСШИРЕНИЕ ПЛАНА — последняя ступень лестницы и единственная, за
   * которую платят. Условия все до одного обязательны:
   *  - market='us' и HE_COLLECT_WIDEN=replan (по умолчанию расширения нет);
   *  - в этой сборке за расширение ещё не платили (`plan_widening` — тот самый
   *    признак: добавленный срез сам становится каталожной задачей, и без
   *    признака следующий тик увидел бы ту же картину и заплатил снова);
   *  - у плана есть куда добавить задачу (потолок 4, HeSourcePlanSchema);
   *  - каталожные задачи ЕСТЬ и ВСЕ дочитаны до конца (`exhausted`). Задача,
   *    вставшая по потолку сканирования или оборванная, — НЕ дочитана: там
   *    поможет повторный запуск, а не новый срез, и платить за срез значило бы
   *    покупать обход собственного предохранителя;
   *  - даже ВЕРХНЯЯ оценка собранного (сумма строк задач, до дедупа и
   *    межбазового исключения) не дотягивает до limit. Оценка сверху нарочно:
   *    расширяемся, только когда недобор доказан при самом благоприятном счёте.
   *
   * Цену ограничивает не только «раз на сборку»: добавленный срез живёт в
   * сохранённом плане, а план не может быть длиннее четырёх задач — значит за
   * всю жизнь плана таких покупок не больше, чем (4 − задач в плане).
   */
  const catalogStates = tasks.filter((t) => isHeCatalogSource(t.source));
  const harvestedUpperBound = tasks.reduce((sum, t) => sum + (t.status === 'done' ? t.rows : 0), 0);
  if (
    widenMode === 'replan' &&
    !info.plan_widening &&
    info.plan &&
    info.plan.tasks.length < HE_PLAN_MAX_TASKS &&
    catalogStates.length > 0 &&
    // Ни одной незавершённой задачи: пока дочерний парсер карт жив, сколько
    // собрано — неизвестно, и «недобор» был бы догадкой, за которую платят.
    tasks.every((t) => t.status === 'done' || t.status === 'failed') &&
    catalogStates.every((t) => t.status === 'done' && t.exhausted === true) &&
    harvestedUpperBound < limit
  ) {
    // Прогон закладок нужен и здесь — тик мог не диспатчить ни одной каталожной
    // задачи (ждал карты). Чтение мемоизировано, лишнего запроса нет.
    const replanCatalog = await getCatalog();
    // Остывание: прошлая покупка уже ничего не дала. Проверяем ПЕРЕД тем, как
    // читать вход планировщика, — это единственное место, где отказ прошлой
    // ночи вообще виден, потому что info у сегодняшней базы пустой.
    const onCooldown = replanCatalog?.widenOnCooldown() === true;
    if (onCooldown) {
      stageLog(
        ctx,
        '[base_collect] расширение плана пропущено: прошлая платная попытка ничего не дала, окно остывания ещё идёт',
      );
    }
    const input = replanCatalog && !onCooldown ? await getPlanInput() : null;
    if (input && replanCatalog) {
      const added = await widenPlanWithPaidSlice(ctx, {
        info,
        input,
        catalogStates,
        harvested: harvestedUpperBound,
        limit,
        usage,
      });
      // Покупка кончилась ничем — отмечаем это У ПЛАНА, иначе завтрашняя база
      // с пустым collect_info купит ровно тот же отказ ещё раз, и так каждую
      // ночь: один bulk-вызов за ноль строк. `outcome: 'failed'` ставит сама
      // widenPlanWithPaidSlice во всех своих безрезультатных ветках.
      if (!added && heWidenFailed(info)) {
        await replanCatalog.rememberWidenFailure();
      }
      // Запись оплаты — КЛИЕНТОМ БЕЗ СИГНАЛА ДЖОБЫ (paidCheckpointDb) и ДО
      // диспатча нового среза: прогон уже мог быть прерван, а без этой записи
      // следующий тик купил бы срез второй раз.
      //
      // Купленная задача уезжает в ТУ ЖЕ запись, а не после диспатча, и это не
      // порядок ради порядка. Фазу PLAN тик с уже сохранённым планом больше не
      // проходит, а `info.tasks` собирается ТОЛЬКО там (из `info.plan.tasks`) —
      // значит запись, где срез есть в плане, но не в списке задач, оставила бы
      // оплаченный срез без единого исполнителя: заплатили и не собрали. Здесь
      // прерванный прогон находит задачу в 'pending' и диспатчит её сам.
      if (added) tasks.push(added);
      await persistCollectInfo(ctx, baseId, info, { paidCheckpoint: true });
      if (added) {
        await runDispatch(added, replanCatalog);
        // План со свежим срезом — в стор вертикали: иначе за него платила бы
        // КАЖДАЯ следующая ночь той же вертикали.
        await replanCatalog.rememberPlan(info.plan, input.planKey);
      }
    }
  }

  // ─── WAIT ───
  for (const state of tasks) {
    if (state.status !== 'dispatched') continue;
    // Дочерняя джоба висит дольше 3ч (парсер умер/потерял строку) — вечно
    // не ждём: задача failed, сборка продолжается по остальным задачам.
    // У задач без dispatched_at (collect_info до появления штампа) таймаута
    // нет — поведение как раньше.
    if (
      state.dispatched_at &&
      Date.now() - new Date(state.dispatched_at).getTime() > CHILD_TIMEOUT_MS
    ) {
      state.status = 'failed';
      state.error = 'timeout: дочерняя джоба зависла';
      stageLog(ctx, `[base_collect] ${state.source}: ${state.error} (${state.child_job_id})`);
      continue;
    }
    try {
      await pollTask(ctx, state, limit);
    } catch (e) {
      state.status = 'failed';
      state.error = e instanceof Error ? e.message : String(e);
      stageLog(ctx, `[base_collect] poll ${state.source} упал: ${state.error}`);
    }
  }
  await persistCollectInfo(ctx, baseId, info);

  const waiting = tasks.filter((t) => t.status === 'pending' || t.status === 'dispatched');
  if (waiting.length > 0) {
    await requeueSelf(ctx, job);
    return {
      result: { waiting: true, base_id: baseId, pending_sources: waiting.map((t) => t.source) },
      tokensUsed: usage.tokensUsed,
      costUsd: usage.costUsd,
    };
  }

  // ─── HARVEST ───
  const done = tasks.filter((t) => t.status === 'done');
  const failed = tasks.filter((t) => t.status === 'failed');
  // Round-robin по задачам (а не concat): ни один источник не съедает кап
  // целиком. Строки без компании и строки-мусор, чья компания схлопывается в
  // пустой ключ («ООО», «—», «»), выбрасываем до мёрджа — все они делили бы
  // один пустой ключ «|» (дедуп ниже их тоже отбрасывает, это первая линия).
  //
  // Внутри КАЖДОЙ задачи (только market='us') строки с сайтом/почтой поднимаем
  // наверх — contactableFirst. Между задачами порядок не трогаем ни здесь, ни
  // где-либо ещё: очерёдность источников — дело round-robin'а, и общая
  // сортировка сломала бы ровно то, против чего он заведён. RU-путь получает
  // тот же массив, что и до правки.
  const interleaved = dedupUnifiedRows(
    interleaveTaskHarvests(
      done.map((t) => {
        const rows = (t.harvest ?? []).filter((r) => normalizeCompanyForDedup(r.company) !== '');
        return market === 'us' ? contactableFirst(rows) : rows;
      }),
    ),
  );

  // Исключаем компании, уже собранные в других базах этого проекта. Для
  // реестра это страховка (основное исключение прошло на выборке), для
  // hh/карт — единственная точка исключения.
  const existingKeys = await getExcludedKeys();
  const kept = interleaved.filter((r) => !matchesExclusion(existingKeys, r.company, r.inn, r.website));
  const excludedExisting = interleaved.length - kept.length;
  if (excludedExisting > 0) {
    stageLog(ctx, `[base_collect] исключено ${excludedExisting} строк — компании уже есть в других базах проекта`);
  }
  // Кап — после дедупа и исключения, как раньше после дедупа (limit уже
  // посчитан выше: totalRowsCap(job), у refill — уменьшенный под дневной кап).
  const merged = kept.slice(0, limit);

  // ЕДИНСТВЕННЫЙ замер эффекта contactableFirst: сколько строк со связью
  // получила база и сколько их было во всём харвесте. Пишем только когда кап
  // реально срезал (иначе порядок ни на что не влияет — множество то же) и
  // только при market='us': истории ENG-сборок нет вовсе, и без этой строки
  // проверить выигрыш после выкатки будет не по чему.
  if (market === 'us' && kept.length > merged.length) {
    const withHandle = merged.filter(hasContactHandle).length;
    stageLog(
      ctx,
      `[base_collect] кап ${limit}: из ${kept.length} строк взято ${merged.length}, ` +
        `со связью (сайт/почта) ${withHandle} — всего таких в харвесте ` +
        `${kept.filter(hasContactHandle).length}`,
    );
  }

  const stats = {
    tasks_total: tasks.length,
    tasks_done: done.length,
    tasks_failed: failed.length,
    rows_total: merged.length,
    excluded_existing_bases: excludedExisting,
    excluded_during_fetch: tasks.reduce((sum, t) => sum + (t.excluded_during_fetch ?? 0), 0),
    finished_at: new Date().toISOString(),
  };

  if (merged.length === 0) {
    // Refill-сборка ENG auto-pipeline: «новых компаний нет» — ШТАТНЫЙ исход
    // добора (сегмент под вертикаль уже выбран прошлыми сборками), а не сбой:
    // база уходит в терминальный 'analyzed' (НЕ failed), прогон журналируется
    // 'no_new', джоба завершается успешно.
    if (isRefill) {
      const refillResult = await completeHeRefillNoNew({
        ctx,
        job,
        baseId,
        verticalId: base.vertical_id,
        // Терминал долива — тоже терминальная запись базы: рабочее состояние
        // стадии снимаем ЗДЕСЬ, до передачи, чтобы не заводить второе место,
        // которое обязано об этом помнить (dropCollectWorkState).
        info: dropCollectWorkState(info),
        stats,
      });
      return {
        result: { base_id: baseId, rows: 0, refill: refillResult },
        tokensUsed: usage.tokensUsed,
        costUsd: usage.costUsd,
      };
    }
    // Сегмент исчерпан: все задачи исчерпаны/пусты (стоп по потолку
    // сканирования — НЕ исчерпание, hit_ceiling сбрасывает признак), база
    // пуста, нет упавших задач (упавшая задача важнее: показываем её разбор,
    // а не «исчерпан») и есть доказательство, что этот срез проект УЖЕ
    // отработал (sliceAlreadyHarvested ниже). Повторная сборка бессмысленна —
    // честный фейл вместо общего «не дала строк». Пустая выдача при ПЕРВОЙ
    // сборке, за которой ничего не стоит, — обычный нулевой сбор, не
    // исчерпание.
    // Оборванное чтение каталога (`partial`) исчерпанием не считается ни при
    // каких условиях: «строк нет» у него значит «не дочитали», а кабинет по
    // этой причине печатает клиенту «в источниках больше нет новых компаний».
    //
    // ЧТО ИМЕННО ДОКАЗЫВАЕТ, ЧТО СРЕЗ УЖЕ ОТРАБОТАН. Доказательства два, и
    // нужно ровно одно:
    //  1. строки пропускались на выборке как уже собранные — так видит срез
    //     реестр и так же ENG без стора закладок: оба читают с первой строки,
    //     и повторный проход обязан их встретить;
    //  2. ENG со стором: чтение стартовало с закладки (`continued`) и дошло до
    //     КОНЦА выдачи (`exhausted`). У такой ночи пропускать уже нечего —
    //     закладка стоит за всем разобранным, — и раньше ровно она получала
    //     ложную причину: «источники не дали строк, запустите сборку ещё раз».
    //     Запускать было бессмысленно: срез дочитан.
    // Доказательство 2 требует ТРЕТЬЕГО условия — у проекта есть компании в
    // других базах. Закладка сама по себе этого не доказывает: она проходит и
    // по строкам, отвергнутым условиями среза (у eng_hiring — не совпавшая
    // роль), поэтому у проекта, которому не собрали ни одной компании, она
    // тоже может уехать. Без этой проверки кабинет сказал бы такому проекту
    // «Companies collected earlier stay in the bases you already have» — а
    // собранного раньше у него нет. `existingKeys` — те самые компании чужих
    // баз, уже прочитанные выше для мёрджа, лишнего чтения здесь нет.
    //
    // Доказательство 1 оставлено дословно: снять его значит повесить
    // «Сегмент исчерпан» на обычную ПЕРВУЮ пустую сборку RU-инструмента, где
    // реестр честно ставит exhausted на пустой выдаче.
    const sliceAlreadyHarvested =
      tasks.some((t) => (t.excluded_during_fetch ?? 0) > 0) ||
      (existingKeys.nameInns.size > 0 && tasks.some((t) => t.exhausted === true && t.continued === true));
    const segmentExhausted =
      (base.row_count ?? 0) === 0 &&
      failed.length === 0 &&
      tasks.every((t) => !t.partial && (t.exhausted || (t.rows === 0 && !t.hit_ceiling))) &&
      sliceAlreadyHarvested;
    // Упавших задач нет — показываем пометки задач (например, потолок
    // сканирования), а не бессмысленное «план пуст».
    const breakdown =
      failed.map((f) => `${f.source} — ${f.error ?? '0 строк'}`).join('; ') ||
      tasks
        .map((t) => t.note)
        .filter(Boolean)
        .join('; ') ||
      'план пуст';
    const note = segmentExhausted
      ? 'Сегмент исчерпан: новых компаний нет'
      : `Авто-сборка не дала строк: ${breakdown}`;
    await ctx.supabase
      .from('he_bases')
      .update({
        status: 'failed',
        error: note.slice(0, 500),
        collect_info: { ...dropCollectWorkState(info), stats },
        updated_at: new Date().toISOString(),
      })
      .eq('id', baseId);
    throw new Error(note);
  }

  // ─── CONSTRUCT ───
  // Обогащение собранных строк конструктором баз (валидация почт ВСЕГДА,
  // поиск — для бедных баз, см. constructStepsFor). Пропуск — только когда
  // фаза завершалась ранее (construct.status='done' в collect_info). База в
  // analyzing уходит только после импорта (или решения failed/cancelled
  // BC-джобы).
  let finalRows: HeUnifiedRow[] = merged;
  let finalColumns: string[] = [...HE_AUTO_COLLECT_COLUMNS];
  // Вердикты валидации по строкам (из импорта конструктора) — refill-ветке и
  // пометке строк (_email_status) при финальной записи: null, когда
  // конструктор не запускался / вернул пусто.
  let finalEmailStatuses: Array<string | null> | null = null;
  // Кап, реально применённый к этой базе (колонка he_bases.contact_cap_applied).
  // null — конструктор не запускался или не отдал данных: капа на базе нет, и
  // ужесточать нечего.
  let contactCapApplied: number | null = null;
  // Что срезал пост-импортный кап (capImportedRows) — в воронку stats, рядом с
  // соседними исключениями: оплаченные строки не исчезают молча.
  let droppedOverContactCap = 0;
  let droppedOverCompanyCap = 0;
  // Компаний в готовой базе. Без конструктора это сами merged-строки: их ключи
  // «компания|домен» уникальны после дедупа HARVEST, то есть строка = компания.
  let companiesTotal = merged.length;
  const construct = info.construct;

  // ─── РЕЛЕВАНТ-ГЕЙТ ДО КОНСТРУКТОРА (только market='us') ───
  // Судим строки ДО конструктора и отдаём ему только те, которым письмо вообще
  // может уйти (см. judgeRowsBeforeConstruct). Вычеркнутые из
  // базы НЕ исчезают: они дописываются после импорта — клиент и воронка должны
  // видеть, что именно исключено.
  //
  // Запись collect_info.relevance_gate с ran=true = доказательство оплаты: гейт
  // считается ровно один раз на сборку, а его ключи переживают все тики ожидания
  // конструктора (фаза CONSTRUCT растянута на несколько заходов джобы).
  //
  // Запись с ran=false — не доказательство, а протокол отказа: судить второй раз
  // тут не «платить дважды», а платить впервые. Такой тик бывает (гейт записан,
  // а диспатч упал на insert'е — воркер повторяет джобу с тем же harvest), и без
  // проверки ran неудачный гейт снимал бы проверку с базы навсегда: ниже, на
  // импорте, ветка `if (gateRan)` тоже не стала бы судить.
  //
  // RU-инструмент /tools/hypothesis-engine не затронут: у него гейт по-прежнему
  // стоит после импорта и судит те же строки, что судил.
  let relevanceGate: HeRelevanceGateInfo | null = info.relevance_gate ?? null;
  if (market === 'us' && relevanceGate?.ran !== true && !construct?.bc_job_id && needsConstruct(merged)) {
    relevanceGate = await judgeRowsBeforeConstruct({
      ctx,
      rows: merged,
      vertical,
      brief: project.brief,
    });
    info.relevance_gate = relevanceGate;
    // Пишем ДО диспатча и КЛИЕНТОМ БЕЗ СИГНАЛА ДЖОБЫ (paidCheckpoint): это запись
    // чекпойнта оплаты, и она обязана долетать даже тогда, когда прогон уже
    // прерван. Иначе гарантия «второй раз не платим» держалась бы только на
    // спокойном прогоне: у гейта каждый батч из 50 строк — отдельный платёж, он
    // never-throw по батчам (judged > 0 и ran=true даже после аборта на середине),
    // а привязанная к сигналу запись после аборта отвергается — и повтор судит
    // ВСЁ заново. Подробнее про обе такие записи — paidCheckpointDb.
    await persistCollectInfo(ctx, baseId, info, { paidCheckpoint: true });
    usage.tokensUsed += relevanceGate.tokens_used;
    usage.costUsd += relevanceGate.cost_usd;
    stageLog(
      ctx,
      relevanceGate.ran
        ? `[base_collect] релевант-гейт до конструктора: судили ${relevanceGate.judged} из ${merged.length} строк, ` +
            `вне вертикали ${relevanceGate.flagged_keys.length}` +
            (relevanceGate.off_target > 0 ? ` (из них ${relevanceGate.off_target} — префильтром, без модели)` : '')
        : `[base_collect] релевант-гейт до конструктора НЕ отработал (${relevanceGate.error ?? 'без причины'}): ` +
            `${merged.length} строк уходят конструктору целиком, проверка — после импорта`,
    );
  }
  /** Гейт действительно судил строки (а не записал отказ) — см. HeRelevanceGateInfo.ran. */
  const gateRan = relevanceGate?.ran === true;
  const gateFlaggedKeys = new Set(relevanceGate?.flagged_keys ?? []);
  // Строки вне вертикали конструктору не отдаём — это и есть экономия.
  const gateHeldRows =
    gateFlaggedKeys.size > 0 ? merged.filter((r) => gateFlaggedKeys.has(heCompanyRowKey(r))) : [];
  const constructRows =
    gateFlaggedKeys.size > 0 ? merged.filter((r) => !gateFlaggedKeys.has(heCompanyRowKey(r))) : merged;
  /**
   * Гейт не оставил конструктору НИ ОДНОЙ строки: вертикаль, в которой не прошло
   * ничего. Конструктор не запускается — работы для него нет, и это правильно:
   * платить за поиск адресов компаниям, которым никто не напишет, гейт и
   * поставлен предотвращать.
   *
   * Но исход обязан быть СКАЗАН. Без этого база молча доезжала до 'analyzing' и
   * дальше до анализа — «сбор завершён, N компаний», — при том что в ней нет ни
   * одного найденного адреса и ни одного вердикта валидации. Клиент видел
   * готовую базу, из которой запуск не возьмёт ничего, и отличить её от сбоя
   * обогащения было нечем. Поэтому финальная запись ниже уводит такую базу в
   * терминальный 'failed' с причиной (формулировка классифицируется кабинетом
   * как audience_mismatch — «срез не про эту вертикаль, это осознанная
   * остановка»), а строки и воронка пишутся в неё ровно так же, как у любой
   * другой сборки: пометки _low_relevance на всех строках, low_relevance = все,
   * ok_contacts = 0.
   *
   * Условие `!construct?.bc_job_id`: джобу конструктора мы не бросаем. Если она
   * уже в работе, а гейт (посчитанный на прошлом тике, когда merged был шире)
   * покрыл весь нынешний merged, доводим фазу штатно — импортируем и помечаем.
   *
   * НОЧНОЙ ДОЛИВ идёт своим терминалом (runHeRefillAppend ниже), и это не
   * недоделка, а цена вопроса: 'failed'-база ВЫПАДАЕТ из кросс-базового
   * исключения (loadOtherBaseExclusionKeys фильтрует по `status != failed`), то
   * есть её компании снова считаются несобранными. Ручную сборку это устраивает
   * — повтор инициирует человек, которому кабинет прямо сказал взять другую
   * вертикаль. Ночному крону — нет: он обходит все вертикали с запущенной
   * кампанией КАЖДУЮ ночь и пересобирал бы ровно те же компании, каждый раз
   * заново платя за гейт. Терминал долива оставляет базу в 'analyzed', её
   * компании — исключёнными, и следующая ночь честно упирается в «новых компаний
   * нет». Причина при этом записана машинно (stats.all_off_target ниже).
   */
  const allOffTarget =
    gateHeldRows.length > 0 && constructRows.length === 0 && !construct?.bc_job_id;
  if (allOffTarget) {
    stageLog(
      ctx,
      `[base_collect] релевант-гейт вне вертикали ВСЕ ${merged.length} строк: конструктор не запускаем, ` +
        (isRefill
          ? 'обогащать нечего — долив закончится нулём, компании остаются исключёнными'
          : 'база уходит в failed с причиной — обогащать нечего'),
    );
  }

  // «Есть что отдавать конструктору» спрашиваем ТОЛЬКО у первого входа в фазу:
  // это про сетку, которую мы сейчас соберём. Уже поставленную джобу этот вопрос
  // не касается — её надо довести до импорта в любом случае. Раньше оба входа
  // висели на одном needsConstruct, и достаточно было, чтобы merged к очередному
  // тику сжался до одних помеченных строк (кросс-базовое исключение выросло:
  // соседняя сборка проекта забрала те же компании), — фаза переставала
  // опрашивать ЖИВУЮ джобу, и оплаченный результат конструктора терялся молча.
  // У RU-инструмента и у ENG-сборки без пометок условие прежнее: constructRows
  // это merged, а merged здесь непуст по построению (пустой ушёл выше).
  if ((!construct && needsConstruct(constructRows)) || construct?.status === 'dispatched') {
    if (!construct?.bc_job_id) {
      // DISPATCH-CONSTRUCT: джоба конструктора (воркер baseConstructor клеймит
      // pending), её id — в collect_info.construct; дальше WAIT с паузой 60с.
      const dispatched = await dispatchConstructJob({
        ctx,
        ownerId: project.created_by,
        baseLabel: base.filename ?? baseId,
        rows: constructRows,
        // Весь harvest — только для теста «бедная база» (см. constructStepsFor).
        harvest: merged,
        market,
        contactCap,
      });
      info.construct = dispatched.construct;
      // ДЕНЬГИ, а не работа: строка base_constructor_jobs уже поставлена, и её
      // заберёт воркер конструктора — краул find_emails и SMTP-пробы
      // validate_emails оплачиваются по ней. Потеряв эту запись, повтор стадии
      // поставит ВТОРУЮ такую строку на те же компании, а результат первой не
      // импортирует никто. Барьер по 'collecting' внутри как раз нужен: базе,
      // которую успели отменить, bc_job_id возвращать не надо.
      await persistCollectInfo(ctx, baseId, info, { paidCheckpoint: true });
      stageLog(
        ctx,
        `[base_collect] construct: создана base_constructor_jobs ${dispatched.bcJobId} ` +
          `(${constructRows.length} строк, locale ${dispatched.locale}, шаги ${dispatched.steps.join(' → ')}, ` +
          `кап ${contactCap} адресов на компанию` +
          (gateHeldRows.length > 0 ? `; ${gateHeldRows.length} строк вне вертикали не оплачиваем` : '') +
          `)`,
      );
      await requeueSelf(ctx, job, CONSTRUCT_REQUEUE_MS);
      return {
        result: { waiting: true, base_id: baseId, construct: 'dispatched' },
        tokensUsed: usage.tokensUsed,
        costUsd: usage.costUsd,
      };
    }

    // WAIT-CONSTRUCT: опрос BC-джобы до терминального статуса.
    const bc = await readConstructJobStatus(ctx, construct.bc_job_id);
    const bcStatus = bc?.status ?? 'failed';
    if (isConstructJobSettled(bcStatus)) {
      // ENG: джоба могла быть поставлена ДО того, как split_emails стал
      // обязательным (26.09.2026). Её сетку импортировать нельзя: адреса
      // компании склеены в одной ячейке, вердикт валидации там ОДИН — лучший
      // из адресов, — и импорт прикрепил бы его к ПЕРВОМУ адресу ячейки.
      // Строка уехала бы в рассылку с чужим «ok». Молча принять такой
      // результат — ровно тот отказ, который этот блок и закрывает: вместо
      // импорта один раз пересобираем базу по текущему контракту.
      // Повтор одноразовый: у новой джобы split_emails в selected_steps есть
      // по построению (constructStepsFor), поэтому сюда она вернуться не
      // может, а если всё же вернулась — платить второй раз не будем и
      // скажем причину вслух.
      if (market === 'us' && bc?.selected_steps && !bc.selected_steps.includes('split_emails')) {
        if (construct.resplit_of) {
          // Статус фазы конструктора в тексте не для красоты — ровно как у
          // того же отказа в доливе (baseCollectRefill.ts:595): `he_bases.error`
          // кабинет сворачивает в машинный код причины
          // (clientErrors.classifyHeClientError), и именно по формулировке
          // «конструктор завершился со статусом …» ENG-клиент получает
          // `enrichment` — «поиск и проверка адресов для этой базы не
          // доработали», — а не обобщённый технический сбой (`unknown`), как
          // было до 27.09.2026. Русский текст остаётся staff'у (he_jobs.error,
          // логи воркера, мастер специалиста), клиент видит только код.
          // Переформулировать — только сверившись с тем классификатором.
          const note =
            `Конструктор дважды вернул результат без разноса адресов по строкам ` +
            `(джобы ${construct.resplit_of}, ${construct.bc_job_id}; ` +
            `конструктор завершился со статусом ${bcStatus}) — импорт отклонён: ` +
            `вердикты валидации в такой сетке не принадлежат адресам построчно`;
          info.construct = { ...construct, note };
          await ctx.supabase
            .from('he_bases')
            .update({
              status: 'failed',
              error: note.slice(0, 500),
              collect_info: { ...dropCollectWorkState(info), stats },
              updated_at: new Date().toISOString(),
            })
            .eq('id', baseId);
          throw new Error(note);
        }
        const replacement = await dispatchConstructJob({
          ctx,
          ownerId: project.created_by,
          baseLabel: base.filename ?? baseId,
          rows: constructRows,
          harvest: merged,
          market,
          contactCap,
        });
        info.construct = {
          ...replacement.construct,
          resplit_of: construct.bc_job_id,
          note: `джоба ${construct.bc_job_id} без split_emails — база пересобирается по текущему контракту`,
        };
        await persistCollectInfo(ctx, baseId, info);
        stageLog(
          ctx,
          `[base_collect] construct: legacy job ${construct.bc_job_id} без split_emails → ` +
            `повтор ${replacement.bcJobId}`,
        );
        await requeueSelf(ctx, job, CONSTRUCT_REQUEUE_MS);
        return {
          result: { waiting: true, base_id: baseId, construct: 're_dispatched' },
          tokensUsed: usage.tokensUsed,
          costUsd: usage.costUsd,
        };
      }
      // IMPORT: failed/cancelled базу НЕ валит — импортируем частичный data,
      // если он есть, иначе идём в analyzing без обогащения.
      const imported = await importConstructRows(ctx, construct.bc_job_id);
      const failNote =
        bcStatus === 'completed'
          ? null
          : `конструктор завершился со статусом ${bcStatus}${bc?.error_message ? `: ${bc.error_message}` : ''}`;
      if (imported) {
        // Оба числа клиента накладываются ЗДЕСЬ, на готовую сетку: «до N
        // адресов на компанию» и лимит сборки как кап КОМПАНИЙ. Иначе число
        // клиента зависело бы от того, дошла ли джоба до шага
        // cap_emails_per_company (см. capImportedRows).
        const capped = capImportedRows({
          rows: imported.rows,
          emailStatuses: imported.emailStatuses,
          contactCap,
          companyCap: limit,
        });
        finalRows = capped.rows;
        finalEmailStatuses = capped.emailStatuses;
        droppedOverContactCap = capped.droppedOverContactCap;
        droppedOverCompanyCap = capped.droppedOverCompanyCap;
        companiesTotal = capped.companies;
        if (imported.hasDescription) finalColumns = [...HE_AUTO_COLLECT_COLUMNS, 'description'];
        // Строки, вычеркнутые гейтом ДО конструктора, он не видел, а
        // finalRows = capped.rows заменяет массив ЦЕЛИКОМ — без дописывания
        // исключённые компании исчезли бы из базы молча, и ни клиент, ни
        // воронка не узнали бы, что именно отсеяно. Вердикта валидации у них
        // нет (мы за него не платили): в finalEmailStatuses кладём им null,
        // иначе вердикты всех строк сдвинулись бы на одну.
        if (gateHeldRows.length > 0) {
          finalRows = [
            ...finalRows,
            ...gateHeldRows.map((r) => (imported.hasDescription ? { ...r, description: '' } : r)),
          ];
          finalEmailStatuses = [...capped.emailStatuses, ...gateHeldRows.map(() => null)];
          // Компании базы — оплаченные плюс отложенные: обе группы пришли из
          // merged, где строк уже не больше лимита сборки, поэтому инвариант
          // «не больше limit компаний» держится и после дописывания.
          companiesTotal += gateHeldRows.length;
        }
        // Кап засчитан применённым у ЛЮБОГО импорта: его накладывает
        // capImportedRows в этом же процессе, а не только шаг конструктора.
        // Раньше у частичного результата (failed/cancelled оборвался на
        // неизвестном шаге) штамп оставался null — честно, но база при этом и
        // правда уезжала без капа; теперь кап есть у обеих ветвей.
        contactCapApplied = contactCap;
        info.construct = {
          ...construct,
          status: bcStatus === 'completed' ? 'done' : bcStatus,
          emails_found: imported.emailsFound,
          // Валидных — по оставленным строкам (см. capImportedRows): кабинет
          // печатает это число рядом с row_count базы.
          valid_count: capped.validCount,
          ...(failNote ? { note: `${failNote} — импортирован частичный результат` } : {}),
        };
        if (droppedOverContactCap > 0 || droppedOverCompanyCap > 0) {
          stageLog(
            ctx,
            `[base_collect] кап после импорта: ${companiesTotal} компаний, ${finalRows.length} строк; ` +
              `отброшено ${droppedOverContactCap} адресов сверх ${contactCap} на компанию` +
              (droppedOverCompanyCap > 0
                ? `, ${droppedOverCompanyCap} строк компаний сверх лимита ${limit}`
                : ''),
          );
        }
      } else {
        info.construct = {
          ...construct,
          status: bcStatus === 'completed' ? 'done' : bcStatus,
          note: failNote
            ? `${failNote} — база без обогащения`
            : 'конструктор вернул пустые данные — база без обогащения',
        };
      }
      stageLog(
        ctx,
        `[base_collect] construct ${bcStatus}: ${
          imported
            ? `импортировано ${imported.rows.length} строк, почт ${imported.emailsFound}, валидных ${imported.validCount}`
            : 'данных нет — база без обогащения'
        }`,
      );
    } else {
      // Таймаут ожидания конструктора — вечно не ждём: база failed с разбором.
      if (constructWaitExpired(construct)) {
        const note = `Конструктор баз не завершился за 6ч (job ${construct.bc_job_id}, статус: ${bc?.status ?? 'не найдена'})`;
        info.construct = { ...construct, note };
        await ctx.supabase
          .from('he_bases')
          .update({
            status: 'failed',
            error: note.slice(0, 500),
            collect_info: { ...dropCollectWorkState(info), stats },
            updated_at: new Date().toISOString(),
          })
          .eq('id', baseId);
        throw new Error(note);
      }
      await requeueSelf(ctx, job, CONSTRUCT_REQUEUE_MS);
      return {
        result: { waiting: true, base_id: baseId, construct: bc?.status ?? 'missing' },
        tokensUsed: usage.tokensUsed,
        costUsd: usage.costUsd,
      };
    }
  }

  // ─── QUALITY GATE (до refill/финала: пометки нужны обоим путям) ───
  // 1) вердикты валидации почт → _email_status на строках (запуск пропускает
  //    не-'ok' — баунсы не ложатся на домен клиента);
  // 2) релевант-гейт → _low_relevance на строках вне вертикали (шум
  //    hh/карт/реестра): запуск фильтрует их в launchTemplate, refill — в
  //    selectRefillLeadRows. Пометки живут только в jsonb-строках: в columns
  //    не попадают, сетки UI и маппинг операторов их не видят.
  //    У ENG-сборки сам гейт отработал РАНЬШЕ, до конструктора, и здесь
  //    остаётся только разложить его пометки по строкам (вычеркнутые строки
  //    дописаны в конец finalRows после импорта).
  //
  // Два шага ниже НЕЗАВИСИМЫ, и это важно: пометки уже посчитанного гейта
  // раскладываются всегда (строки вырезаны из сетки по этим самым ключам —
  // не разложить их значило бы отдать в запуск то, за что мы не платили), а
  // суд ПОСЛЕ импорта идёт ровно тогда, когда суда до конструктора не было
  // (gateRan=false): RU-инструмент, ENG-база с фазой CONSTRUCT от прошлой
  // сборки и ENG-база, у которой гейт до конструктора отказал.
  type StoredRow = HeUnifiedRow & { _email_status?: string; _low_relevance?: boolean };
  let storedRows: StoredRow[] = finalRows;
  if (finalEmailStatuses) {
    storedRows = storedRows.map((r, i) => {
      const st = finalEmailStatuses[i];
      return st ? { ...r, _email_status: st } : r;
    });
  }
  // ENG: гейт отработал ДО конструктора, и платить второй раз не за что.
  // Помечаем по ключам компаний: вычеркнутые строки дописаны в конец
  // finalRows, а среди оплаченных таких ключей быть не может — конструктор
  // получил только невычеркнутые строки, и split_emails ключ компании не
  // меняет.
  if (gateFlaggedKeys.size > 0) {
    storedRows = storedRows.map((r) =>
      gateFlaggedKeys.has(heCompanyRowKey(r)) ? { ...r, _low_relevance: true } : r,
    );
    stageLog(
      ctx,
      `[base_collect] релевант-гейт (до конструктора): помечено ${gateFlaggedKeys.size} компаний вне вертикали`,
    );
  }
  if (!gateRan) {
    // Прежний путь — судим строки ПОСЛЕ импорта. Здесь три случая: RU-сборка
    // легаси-инструмента (её поведение обязано остаться прежним), ENG-база,
    // чья фаза CONSTRUCT началась ДО переноса гейта (записи relevance_gate у
    // неё нет), и ENG-база, у которой гейт до конструктора НЕ отработал
    // (ran=false) — её строки иначе не проверил бы никто.
    try {
      const { data: vrow } = await ctx.supabase
        .from('he_verticals')
        .select('name, summary')
        .eq('id', base.vertical_id)
        .maybeSingle();
      const verticalName = (vrow as { name?: string } | null)?.name ?? '';
      const gate = await findIrrelevantRows({
        rows: storedRows,
        verticalName,
        verticalSummary: (vrow as { summary?: string | null } | null)?.summary ?? '',
        language: market === 'us' ? 'en' : 'ru',
        log: (m) => stageLog(ctx, m),
      });
      usage.tokensUsed += gate.tokensUsed;
      usage.costUsd += gate.costUsd;
      if (gate.flagged.size > 0) {
        storedRows = storedRows.map((r, i) =>
          gate.flagged.has(i) ? { ...r, _low_relevance: true } : r,
        );
        stageLog(ctx, `[base_collect] релевант-гейт: помечено ${gate.flagged.size} строк вне вертикали`);
      }
    } catch (e) {
      stageLog(ctx, `[base_collect] релевант-гейт пропущен: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Считаем по САМИМ строкам, а не по размеру набора ключей: у одной компании
  // после split_emails несколько строк, и оба шага выше могли пометить одну и
  // ту же (у базы с отказавшим гейтом до конструктора — реально могут).
  const lowRelevanceCount = storedRows.reduce((n, r) => n + (r._low_relevance === true ? 1 : 0), 0);
  // Адресов, которые запуск реально возьмёт: вердикт 'ok' И строка не помечена
  // вне вертикали — те же два фильтра, что у launchTemplate. Это ОЦЕНКА СВЕРХУ:
  // запуск ещё выбросит строки без разбираемого адреса, повторные адреса (после
  // split_emails + dedup_email их быть не должно) и контакты из чёрного списка
  // клиента. Число нужно и воронке, и сравнению с потолком запуска ниже.
  const okContacts = storedRows.reduce(
    (n, r) => n + (r._email_status === 'ok' && r._low_relevance !== true ? 1 : 0),
    0,
  );
  const statsWithQuality = {
    ...stats,
    low_relevance: lowRelevanceCount,
    companies_total: companiesTotal,
    ok_contacts: okContacts,
    dropped_over_contact_cap: droppedOverContactCap,
    dropped_over_company_cap: droppedOverCompanyCap,
    // Причина «нулевой» базы машинно, а не только в тексте he_bases.error: у
    // базы, где гейт снял ВСЁ, low_relevance == rows_total и ok_contacts == 0
    // выглядят так же, как у базы, которой конструктор не нашёл ни одного
    // адреса. Пишем только когда это правда — иначе ключ был бы шумом на
    // каждой сборке.
    ...(allOffTarget ? { all_off_target: true } : {}),
  };
  // Потолок мастера считает АДРЕСА (HE_LAUNCH_MAX_LEADS лидов), а число клиента
  // — КОМПАНИИ, и после разноса адресов по строкам одна компания даёт до
  // contactCap адресов: 2000 компаний × 5 адресов — до 10 000 лидов при потолке
  // 2000. ОТКАЗА (413) у market='us' на это больше НЕТ: потолок выбирает —
  // сначала по одному сильнейшему адресу каждой компании, потом вторые
  // (selectLeadsWithinLaunchCap в launchHandoff.ts), — поэтому оплаченные
  // компании уезжают все, а сверхпотолочные адреса остаются дома. В журнал
  // соотношение всё равно пишется: staff должен видеть, что часть адресов
  // собранной базы запуск не возьмёт. RU-инструмент не предупреждаем: там строка
  // = компания, потолок по-прежнему отвечает 413, у staff-UI на этот случай свой
  // пречек, а базы на 50 000 строк штатны — предупреждение было бы шумом на
  // каждой сборке.
  if (market === 'us' && okContacts > HE_LAUNCH_MAX_LEADS) {
    stageLog(
      ctx,
      `[base_collect] адресов с вердиктом ok ${okContacts} при потолке запуска ` +
        `${HE_LAUNCH_MAX_LEADS}: запуск не откажет — возьмёт по сильнейшему адресу каждой ` +
        `компании, пока не наберёт потолок, остальные адреса не уедут. ` +
        `Компаний ${companiesTotal}, кап ${contactCap} адресов на компанию`,
    );
  }

  // ─── REFILL (ENG auto-pipeline) ───
  // Вместо финала «analyzing + base_analyze»: долив валидных строк лидами в
  // уже запущенную кампанию, база → терминальный 'analyzed', итог — в
  // collect_info.refill_result и he_auto_pipeline_runs.
  if (isRefill) {
    return await runHeRefillAppend({
      ctx,
      job,
      base: { id: baseId, project_id: job.project_id, vertical_id: base.vertical_id },
      // Как и у ветки no_new выше: долив пишет базу терминально, рабочее
      // состояние стадии до его записи не доезжает.
      info: dropCollectWorkState(info),
      stats: statsWithQuality,
      finalRows: storedRows,
      finalColumns,
      emailStatuses: finalEmailStatuses,
      usage,
    });
  }

  // Вертикаль, в которой не прошла ни одна строка (см. allOffTarget выше):
  // терминальный 'failed' с причиной вместо 'analyzing' + анализ. Строки и
  // воронка пишутся тем же апдейтом — исключённые компании клиент видит, и
  // видит, что их ровно столько же, сколько собрано. До этой точки доходит
  // только НЕ-refill: ночной долив вернулся выше своим терминалом.
  //
  // Формулировка не косметика: кабинет сворачивает he_bases.error в машинный
  // код причины (clientErrors.classifyHeClientError), и по обороту «не
  // покрывается каталогом» ENG-клиент получает audience_mismatch — «срез не про
  // эту вертикаль, это осознанная остановка; возьмите другую вертикаль», — тот
  // же код и тот же текст, что у отказа пробы среза, который останавливает
  // сборку по той же причине, только раньше. Русский текст остаётся staff'у,
  // клиент видит только код. Переформулировать — сверившись с классификатором.
  const offTargetNote = allOffTarget
    ? `Вертикаль «${vertical.name}» не покрывается каталогом: релевант-гейт снял все ` +
      `${storedRows.length} собранных компаний как не принадлежащие вертикали. ` +
      'Поиск и проверка адресов не запускались — рассылка по такому срезу навредила бы ' +
      'рабочим вертикалям.'
    : null;
  const harvestRow = {
    columns: finalColumns,
    sample_rows: storedRows.slice(0, SAMPLE_ROWS),
    data: storedRows,
    row_count: storedRows.length,
    status: offTargetNote ? 'failed' : 'analyzing',
    ...(offTargetNote ? { error: offTargetNote.slice(0, 500) } : {}),
    collect_info: { ...dropCollectWorkState(info), stats: statsWithQuality },
    // Применённый кап — только когда колонка точно существует (см.
    // contactCapColumnsPresent). Значение есть и в collect_info.construct,
    // поэтому на инсталляции без миграции ничего не теряется.
    ...(contactCapColumnsPresent && contactCapApplied !== null
      ? { contact_cap_applied: contactCapApplied }
      : {}),
    updated_at: new Date().toISOString(),
  };
  /**
   * Финальную запись при БЛИПЕ БД повторяем — повторяется ЗАПРОС, не стадия.
   *
   * Это самая дорогая точка невозврата в движке: до неё уже оплачены план,
   * коллекторы, конструктор и релевант-гейт, а сама запись адресована по id и
   * идемпотентна (одни и те же строки, статус и collect_info). Отказ здесь
   * уходил в фейл джобы, воркер поднимал стадию заново, и повтор доходил до
   * этого места СНОВА через суд релевант-гейта ПОСЛЕ импорта (единственная
   * платная работа, которая на повторе не memoized, — путь RU-инструмента,
   * gateRan=false): три попытки = до трёх оплаченных судов там, где не сохранился
   * один апдейт. 502/503 шлюза лечится тремя секундами ожидания, а не деньгами.
   *
   * Постоянный отказ (невалидный JSON, права, ограничение) не повторяем: он не
   * изменится, и прежний путь — фейл джобы с причиной — остаётся его путём.
   *
   * И по той же причине запись идёт КЛИЕНТОМ БЕЗ СИГНАЛА ДЖОБЫ (paidCheckpointDb):
   * повторы внутри запроса не помогут, если сам запрос отвергнут за то, что джобу
   * уже прервали. Статус базы эта запись МЕНЯЕТ, поэтому барьера `'collecting'` у
   * неё нет — он превратил бы отказ в тихий ноль строк, а ниже по коду стоит
   * постановка анализа. Гонка «отмена пользователем прилетела ровно между
   * start-guard'ом и этой записью → база оживает в 'analyzing'» этим не создаётся:
   * так же было и до волны 4b, когда стадия работала общим клиентом без сигнала.
   */
  let updErrorMsg: string | null = null;
  for (let attempt = 1; attempt <= HARVEST_WRITE_ATTEMPTS; attempt += 1) {
    const { error } = await paidCheckpointDb(ctx).from('he_bases').update(harvestRow).eq('id', baseId);
    if (!error) {
      updErrorMsg = null;
      break;
    }
    updErrorMsg = error.message;
    if (attempt >= HARVEST_WRITE_ATTEMPTS || !isTransientDbError(error)) break;
    stageLog(
      ctx,
      `[base_collect] финальная запись базы отвергнута (попытка ${attempt}/${HARVEST_WRITE_ATTEMPTS}), ` +
        `повторяем — блип БД: ${error.message}`,
    );
    await sleep(HARVEST_WRITE_RETRY_BASE_MS * attempt);
  }
  if (updErrorMsg) throw new Error(`he_bases harvest update: ${updErrorMsg}`);
  if (offTargetNote) {
    // Анализ не ставим — анализировать нечего, а поставленный base_analyze увёл
    // бы базу обратно в живой статус. Бросаем той же причиной, как отказ пробы
    // среза, и повтор джобы НИЧЕГО не переплачивает: база уже в терминальном
    // 'failed', а start-guard стадии требует ровно 'collecting' — повтор
    // останавливается на нём и в эту ветку не возвращается (в he_jobs.error
    // последней попытки поэтому стоит «сборка уже завершена», а не этот текст).
    // Причину читает кабинет из he_bases.error, и она доживает: базу в
    // терминальном статусе repairBaseAfterCollectFinalFail не трогает
    // (HE_BASE_TERMINAL_STATUSES → return).
    stageLog(ctx, `[base_collect] ${offTargetNote}`);
    throw new Error(offTargetNote);
  }

  // Постановка анализа — через дедуп (ensureBaseAnalyzeJob): повторный вход в
  // финал возможен (незакрытая пара выше, повтор после блипа записи), и без
  // проверки существования он платил бы за анализ этой базы второй раз.
  const analysisEnqueue = await ensureBaseAnalyzeJob(ctx, job, baseId);

  return {
    result: {
      base_id: baseId,
      rows: storedRows.length,
      analysis_enqueue: analysisEnqueue,
      low_relevance: lowRelevanceCount,
      tasks_done: done.length,
      tasks_failed: failed.length,
      failed_sources: failed.map((f) => f.source),
    },
    tokensUsed: usage.tokensUsed,
    costUsd: usage.costUsd,
  };
}
