import { markAutomatedConstructor } from '@/lib/tools/baseConstructorQueue';
import { VeLlmRateLimitError, veRateLimitDelay } from '../llmRateLimit';
/**
 * Стадия base_collect: авто-сборка базы под вертикаль (ve_bases source='auto').
 *
 * Оркестратор над существующими коллекторами — своих парсеров у стадии нет.
 * Всё состояние живёт в ve_bases.collect_info, поэтому джоба безопасно
 * перевызывается: пока дочерние парсеры работают, стадия делает self-requeue
 * (своя ve_jobs-строка → status='pending' БЕЗ инкремента attempts) и воркер
 * клеймит её после 30-секундной паузы (run_after).
 *
 * Фазы:
 *  1. PLAN — один LLM-вызов (модель collection): вертикаль + неотклонённые гипотезы
 *     + типы компаний из вокабуляра → план задач (промпт/схема — контракт
 *     prompts/sourcePlan.ts + VeSourcePlanSchema). Непустой hypothesis_ids в
 *     payload джобы (выбор гипотез в UI) сужает набор до выбранных id;
 *     пустое пересечение с неотклонёнными — фейл джобы. План и статусы задач
 *     пишутся в collect_info.
 *     При market='us' промпт — EN (prompts/sourcePlan.en.ts) с ENG-источниками
 *     (pdl / funded / eng_hiring / google_maps); схема плана общая.
 *  2. DISPATCH — каждая pending-задача уходит в свой коллектор:
 *     companies_directory — синхронно через searchRows с пагинацией страницами
 *     по 1000 (строки сразу в задаче, дочерней джобы нет; кап — limit из
 *     payload джобы, см. totalRowsCap; компании других баз проекта
 *     пропускаются ещё на выборке — см. блок про продолжение ниже);
 *     pdl / funded / eng_hiring (market='us') — тоже синхронно: прямое чтение
 *     справочных таблиц pdl_companies / funded_companies / eng_hiring_cache
 *     через ctx.supabase (keyset-пагинация по id у pdl/funded, офсетная у
 *     eng_hiring; дочерних джоб нет — исключение чужих баз для них, как для
 *     hh/карт, только на мёрдже);
 *     yandex_maps — готовый каталог через read-only RPC, фильтры справочника
 *     и курсор страниц сохраняются вместе со строками, без парсера/прокси;
 *     hh_live / google_maps — insert дочерней джобы
 *     (parser_jobs / google_maps_jobs), её id — в
 *     child_job_id. У google_maps language/region — по рынку проекта
 *     (us → en/US). collect_info персистится после каждой задачи.
 *  3. WAIT — опрос дочерних джоб по статусу. Есть незавершённые →
 *     self-requeue и выход с {waiting: true}.
 *  4. HARVEST — строки всех done-задач мёржатся в унифицированные колонки
 *     round-robin'ом (по одной строке из каждой задачи по кругу — иначе реестр,
 *     диспатчущийся первым, съедал весь кап, а строки hh/карт молча отрезались),
 *     дедуп по нормализованному ключу (компания — без юрформ и кавычек, сайт —
 *     хост без www/пути), исключение компаний из ДРУГИХ ve_bases того же
 *     проекта (иначе одна компания копилась в нескольких базах проекта через
 *     повторные сборки; для строк hh/карт это единственная точка исключения,
 *     для реестра — страховка после исключения на выборке), кап
 *     totalRowsCap(job) — limit из payload джобы
 *     (дефолт 10000). Ноль строк — база failed с разбором по задачам,
 *     джоба падает. Упавшие задачи фиксируются в collect_info, но не валят
 *     джобу, если хотя бы одна задача дала строки.
 *  5. CONSTRUCT — обогащение собранных строк конструктором баз
 *     (base_constructor_jobs: find_emails для всех строк →
 *     enrich_descriptions по одной строке компании → split_emails →
 *     dedup_email → validate_emails; locale джобы
 *     по рынку).
 *     Завершённый результат конструктора переиспользуется при продолжении.
 *     DISPATCH-CONSTRUCT создаёт BC-джобу (bc_job_id — в collect_info.construct)
 *     и уходит в self-requeue с паузой 60с; WAIT-CONSTRUCT опрашивает её до
 *     терминального статуса (таймаут 6ч → база failed); IMPORT мапит сетку
 *     обратно в унифицированные колонки по имени заголовка (email — первый
 *     адрес merged-ячейки) и добавляет колонку description В КОНЕЦ заголовков.
 *     failed/cancelled BC-джоба базу НЕ валит: импортируется частичный data,
 *     если он есть, иначе переход к analyzing без обогащения. Далее —
 *     ve_bases → status='analyzing' и ставится стадия base_analyze.
 *
 * Refill-режим (ENG auto-pipeline, payload.refill=true; постановка — крон
 * app/worker/heAutoPipelineCron.ts через enqueueVeBaseCollect): PLAN →
 * DISPATCH → WAIT → HARVEST → CONSTRUCT идут как обычно, но вместо финала
 * «analyzing + base_analyze» собранные строки доливаются лидами в уже
 * запущенную кампанию Instantly, база уходит в терминальный 'analyzed',
 * итог пишется в collect_info.refill_result и ve_auto_pipeline_runs.
 * Пустой harvest — штатный 'no_new' (база НЕ failed). Вся механика —
 * stages/baseCollectRefill.ts.
 *
 * Продолжение сбора больших сегментов (>50k — больше одного капа limit):
 * повторная сборка той же вертикали исключает компании других ve_bases
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
 * У hh/Google Maps
 * исключение остаётся только на мёрдже: продолжение для них требует
 * вариации поисковых запросов — future work.
 */

import { createHash, randomUUID } from 'node:crypto';
import { ProviderUsageWriteError } from '@/lib/providerUsage';
import { isVeProviderBillingError, isVeProviderConfigurationError, isVeTransientDirectoryError } from '../collectionErrors';
import { validVeAdaptiveCollection, newVeAdaptiveCollection, finishVeAdaptiveBatch, chooseVeAdaptiveSource, veSourceStrategyKey, veReadyContactKeys,
  readVeBatchSpend, veAdaptiveCandidateLimit, veAdaptiveLowYield, veAdaptiveYieldWindows, veAdaptiveSourceDry, veDryLiveSources,
  veDrySourcesSummary, type VeAdaptiveCollection } from '../adaptiveCollection';
import { stripUnfoundedSizeFilters, veBroadHypothesisPlan, veDirectorySizeKeep, veHypothesisSizeBasis, veSecondQueueTasks, veTaskWithoutSizeFilters,
  VE_PLAN_MAX_TASKS, VE_PLAN_WIDENING_LIMIT, VE_SIZE_FILTER_KEYS } from '../planWidening';
import { prioritizeVeCandidates, readVeCandidateHints } from '../candidatePriority';
import { isVeAcceptedEmailStatus } from '../emailPolicy';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CompaniesSearchFilters } from '@/app/api/client/companies-search/route';
import { searchRows } from '@/lib/companiesSearch/rpcSearch';
import { applyFundedFilters } from '@/lib/funded/queryFilters';
import { buildRolesRegex } from '@/lib/parsers/atsFilters';
import { domainToSiteUrl, resolveCompanyDomainViaPdl } from '@/lib/parsers/companyDomainResolver';
import { readVeYandexCatalogPage, resolveVeYandexCatalogFilters, veRuMapsUseCatalog, type VeYandexCatalogCheckpoint } from '../yandexCatalog';
import { isVeLegacyMapsTask, isVeRenewableSourceTask, reopenVeSourceTask } from '../sourceRenewal';
import { extractEmail, extractEmails } from '@/lib/tools/dfybUtils';
import { applyVeSourceContacts, normalizeVeSourceContacts, hasPendingVeSourceContacts, pendingVeSourceContacts, recoverVeSourceContacts, countVeSourceDiscoveryContacts, evaluateVeSourceDiscoveryBudget, veSourceDiscoveryLimit, VE_SOURCE_DISCOVERY_NO_GROWTH_LIMIT, type VeSourceContactCheckpoint, type VeSourceDiscoveryBudget } from '../sourceContacts';
import {
  mergeVeSourceFactText, normalizeVeCompanyInn, normalizeVeCompanyName, normalizeVeWebsiteHost,
  veCompanyWebsiteKey, veAcquisitionReceipt,
} from '../collectionIdentity';
import { buildVeSeenCompanies, veSeenCompanyCovers, type VeSeenCompanies } from '../seenCompanies';
import { getVeDirectoryPlanPopulation, veDirectoryPopulationSlice, veUnsizedSourceLabels } from '../directoryPopulation';
import { callLLMWithSchema, getVeModel } from '../llm';
import { projectMarket, type VeMarket } from '../market';
import { findIrrelevantRows, type VeRelevanceDecision } from '../relevanceGate';
import { isVePaidWebsiteSearchEnabled } from '../paidSearchPolicy';
import { isVeRelevanceTriageEnabled } from '../relevanceTriageConfig';
import { capVeContactsPerCompany, countVeTargetContacts, normalizeVeMaxEmailsPerCompany, stripVeCompanyCapMarker, veContactLimitKey, VE_COMPANY_CAP_FIELD } from '../companyContactCap';
import { relevanceHash, VeRelevanceCheckpointError, VePreviewCheckpointConflict, type VeRelevanceCheckpoint } from '../relevanceCheckpoint';
import {
  buildVeRelevanceReviewBatch, mergeVeRelevanceRows, needsVeRelevanceReview, readVeRelevanceReserve, readVeRelevanceSourceRows, summarizeVeRelevanceReserve,
  veRelevanceCompanyKey, veRelevanceRowKey, veSavedReviewSignature, type VeRelevanceReserve, type VeRelevanceReserveSummary,
} from '../relevanceReserve';
import { cleanVeCompanyNames, type VeCompanyNameCheckpoint } from '../companyNameCleanup';
import { recoverVeSavedEmails, needsVeSavedEmailReview, hasPendingVeSavedEmailRecovery, type VeSavedEmailRecoveryState } from '../savedEmailRecovery';
import { singleVeSavedEmail } from '../savedEmailReviewEligibility';
import { companyNameSource, isCompanyNameReady, VE_COMPANY_NAME_FIELD, type VeCompanyNameCleanupSummary } from '../companyNames';
import { prepareSegmentationAudience } from '../segmentationAudit';
import { isContactSupplyActive } from '../contactSupplyEligibility';
import {
  collectionRoundLimit, createCollectionTarget, estimateRemainingReady, finishCollectionRound, updateCollectionEstimate,
  veCollectionMaxRounds, veEstimatePopulation,
  withVeTargetComposition,
  VE_COLLECTION_ROUND_BUDGET,
  VE_SOURCE_POPULATION_MAX_AGE_MS,
  VE_PREVIEW_FIRST_CANDIDATES,
  VE_PREVIEW_READY_TARGET,
  type VeCollectionMode, type VeCollectionTargetProgress, type VeCollectionEstimate,
} from '../collectionTarget';
import {
  probeSliceRelevance,
  sliceProbeRejectBelow,
  sliceProbeRepairBelow,
  sliceProbeSample,
} from '../sliceProbe';
import {
  buildSourcePlanMessages,
  type VeCollectTask,
  type VeSourcePlan,
  type SourcePlanPromptInput,
} from '../prompts/sourcePlan';
import { buildCatalogRepairMessagesEn, buildSourcePlanMessagesEn } from '../prompts/sourcePlan.en';
import { VeCatalogRepairSchema, VeSourcePlanSchema } from '../schemas';
import type { VeBase, VeJob, VeProject, VeVertical } from '../types';
import {
  planVeRelevanceRetry,
  VE_RELEVANCE_MAX_CONSECUTIVE_RETRIES,
  VE_RELEVANCE_MAX_TOTAL_RETRIES,
} from '../relevanceRetry';
import {
  completeVeRefillNoNew,
  runVeRefillAppend,
  type VeRefillResult,
} from './baseCollectRefill';
import {
  VE_BASE_COLLECT_PROBE_COLUMNS,
  veBaseCollectFinished,
  veIdleRequeueMs,
  veNextIdleRounds,
  veProbeCollectionMode,
  veRoundAdvanced,
  type VeBaseCollectProbe,
} from '../baseCollectIdle';
import {
  addUsage,
  newUsage,
  payloadString,
  readProject,
  requeueVeJob as requeueSelf,
  stageLog,
  type VeStageContext,
  type VeStageResult,
  type VeUsage,
} from './shared';

/**
 * Лимит строк авто-сборки выбирает пользователь (route кладёт его в payload
 * джобы как `limit`, UI предлагает 2000 / 10000 / 50000). Кап — не бизнес-
 * правило, а практический предохранитель: строки живут в ve_bases.data jsonb,
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
/** Строк в ve_bases.sample_rows — как у ручной загрузки. */
export const SAMPLE_ROWS = 30;
/** Яндекс.Карты: max_results в воркере трактуется НА ОДИН поисковый URL, а не на задачу. */

/** Достать необязательный number-параметр из payload джобы (не задан/не число — null). */
function payloadNumber(job: VeJob, key: string): number | null {
  const value = job.payload?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Достать необязательный string[]-параметр из payload джобы: непустой массив
 * непустых строк или null. Пустой массив → null (route тоже не пишет пустой) —
 * фильтрация срабатывает только на осмысленный выбор.
 */
function payloadStringArray(job: VeJob, key: string): string[] | null {
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
export function totalRowsCap(job: VeJob): number {
  const limit = payloadNumber(job, 'limit') ?? DEFAULT_ROWS_LIMIT;
  return Math.min(MAX_ROWS_LIMIT, Math.max(MIN_ROWS_LIMIT, limit));
}

/* ─────────────────────── Унифицированная строка ─────────────────────── */

/** Колонки авто-собранной базы (порядок — контракт ve_bases.columns). */
export const VE_AUTO_COLLECT_COLUMNS = [
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

export type VeUnifiedRow = Record<(typeof VE_AUTO_COLLECT_COLUMNS)[number], string>;

function cell(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return String(value).trim();
}

/** Все непустые элементы массива как одна multi-value ячейка. */
function joinedCells(value: unknown): string {
  return Array.isArray(value) ? value.map(cell).filter(Boolean).join(', ') : cell(value);
}

function unifiedRow(partial: Partial<VeUnifiedRow>): VeUnifiedRow {
  const row = {} as VeUnifiedRow;
  for (const col of VE_AUTO_COLLECT_COLUMNS) row[col] = partial[col] ?? '';
  return row;
}

/** Строка реестра companies_directory → унифицированная строка. */
export function mapDirectoryRow(row: Record<string, unknown>): VeUnifiedRow {
  return unifiedRow({
    company: cell(row.name),
    website: cell(row.website),
    email: cell(row.email),
    // phones в реестре — text с телефонами через запятую (массив тоже схлопнется в ту же строку).
    phone: cell(row.phones).split(',')[0]?.trim() ?? '',
    address: cell(row.address),
    // Быстрая проверка и первичная классификация читают category как текст о
    // деятельности. Голый код «28.30» не говорит им ничего и даже не проходит
    // проверку «в тексте есть слова»: компании из реестра теряли и приоритет
    // в партии, и саму возможность получить вердикт — отсюда доля «без
    // решения» под 70%. Название ОКВЭД и отраслевой тип реестр отдаёт для
    // 100% строк, мы их просто выбрасывали. Отдельными строками, потому что
    // проверка цитат разбирает category построчно (см. relevanceGate).
    category: [cell(row.okved_name), cell(row.activity_type), cell(row.okved_code)]
      .map((part) => part.trim()).filter(Boolean).join('\n'),
    employees: cell(row.employees_count),
    revenue: cell(row.revenue),
    inn: cell(row.inn),
    source_detail: 'реестр',
  });
}

/** Вакансия hh → работодатель + название вакансии как крючок персонализации. */
export function mapHhRow(row: Record<string, unknown>, queryText: string): VeUnifiedRow {
  return unifiedRow({
    company: cell(row.company_name),
    website: cell(row.company_site_url),
    vacancy_title: cell(row.name),
    address: cell(row.area),
    source_detail: `hh: ${queryText}`,
  });
}

/** Организация Яндекс.Карт → унифицированная строка. */
export function mapYandexRow(row: Record<string, unknown>): VeUnifiedRow {
  return unifiedRow({
    company: cell(row.name),
    website: cell(row.website),
    email: cell(row.email),
    phone: joinedCells([row.phone, row.mobile_phone, row.all_phones]),
    address: cell(row.address),
    category: joinedCells([row.categories, row.subcategories]),
    source_detail: 'яндекс.карты',
  });
}

/** Место Google Maps → унифицированная строка. */
export function mapGoogleRow(row: Record<string, unknown>): VeUnifiedRow {
  return unifiedRow({
    company: cell(row.name),
    website: cell(row.website),
    // Google Maps может вернуть несколько адресов. Конструктор сам разнесёт
    // их по строкам, поэтому до него нельзя молча оставлять только первый.
    email: joinedCells(row.emails),
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
export function mapPdlRow(row: Record<string, unknown>): VeUnifiedRow {
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
export function mapFundedRow(row: Record<string, unknown>): VeUnifiedRow {
  return unifiedRow({
    company: cell(row.name),
    website: cell(row.website),
    address: composeAddress(row.locality, row.region, row.country),
    category: cell(row.industry),
    source_detail: `funded:${cell(row.source) || 'unknown'}`,
  });
}

/** Вакансия eng_hiring_cache → работодатель + название вакансии как крючок персонализации. */
export function mapEngHiringRow(row: Record<string, unknown>): VeUnifiedRow {
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
  return normalizeVeCompanyName(name);
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
  return normalizeVeWebsiteHost(website);
}

/**
 * ИНН — главный идентификатор. Строку без ИНН можно присоединить по паре
 * «имя + сайт», только если эта пара не принадлежит нескольким юрлицам.
 * Одиноко стоящее имя не доказывает дубль: одноимённые компании остаются
 * раздельно. Все email и дополняющие сведения подтверждённого дубля
 * сохраняются, а разные ИНН никогда не смешиваются даже на общем домене.
 */
export function dedupUnifiedRows(rows: VeUnifiedRow[]): VeUnifiedRow[] {
  const innsByWebsite = new Map<string, Set<string>>();
  for (const row of rows) {
    const inn = normalizeVeCompanyInn(row.inn), websiteKey = veCompanyWebsiteKey(row);
    if (!inn || !websiteKey) continue;
    const inns = innsByWebsite.get(websiteKey) ?? new Set<string>();
    inns.add(inn);
    innsByWebsite.set(websiteKey, inns);
  }
  const idxByIdentity = new Map<string, number>();
  const out: VeUnifiedRow[] = [];
  for (const row of rows) {
    const company = normalizeCompanyForDedup(row.company);
    if (!company) continue;
    const inn = normalizeVeCompanyInn(row.inn), websiteKey = veCompanyWebsiteKey(row);
    const matchingInns = websiteKey ? innsByWebsite.get(websiteKey) : undefined;
    const resolvedInn = inn || (matchingInns?.size === 1 ? [...matchingInns][0] : '');
    // Without a stable identity only an identical complete observation is a
    // duplicate. A richer source with the same generic name is not proof.
    const key = resolvedInn ? `inn:${resolvedInn}` : websiteKey ? `site:${websiteKey}`
      : `observation:${JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))}`;
    const idx = idxByIdentity.get(key);
    if (idx === undefined) {
      idxByIdentity.set(key, out.length);
      out.push({ ...row });
      continue;
    }
    const merged = { ...out[idx] } as VeUnifiedRow & Record<string, string>;
    for (const [field, value] of Object.entries(row)) {
      if (!cell(merged[field])) merged[field] = value;
    }
    if (!normalizeVeCompanyInn(merged.inn) && inn) merged.inn = row.inn;
    if (!normalizeVeWebsiteHost(merged.website) && normalizeVeWebsiteHost(row.website)) merged.website = row.website;
    for (const field of ['category', 'description', 'vacancy_title', 'phone', 'address', 'source_detail']) {
      merged[field] = mergeVeSourceFactText(out[idx][field as keyof VeUnifiedRow], row[field as keyof VeUnifiedRow]);
    }
    merged.email = extractEmails(`${out[idx].email}, ${row.email}`).join(', ');
    out[idx] = merged;
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
export function interleaveTaskHarvests(lists: VeUnifiedRow[][]): VeUnifiedRow[] {
  const out: VeUnifiedRow[] = [];
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

/* ─────────────────────── Билдеры запросов к коллекторам ─────────────────────── */

/** directory_filters плана → фильтры реестра (только заданные поля). */
export function mapDirectoryFilters(
  filters: VeCollectTask['directory_filters'],
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

function directoryEstimateScope(plan: VeSourcePlan): string {
  return JSON.stringify(plan.tasks.map((task) => task.source === 'companies_directory'
    ? { source: task.source, slice: veDirectoryPopulationSlice(task) } : { source: task.source }));
}

function needsDirectoryEstimateRefresh(plan: VeSourcePlan, estimate: VeCollectionEstimate | undefined): boolean {
  const age = Date.now() - Date.parse(estimate?.population_as_of ?? '');
  return !estimate || estimate.version !== 2 || estimate.population_method !== 'plan_union'
    || estimate.population_filters !== directoryEstimateScope(plan)
    || !Number.isFinite(age) || age < 0 || age > VE_SOURCE_POPULATION_MAX_AGE_MS;
}

/**
 * Размер реестровой части плана — компаний в объединении всех реестровых
 * срезов, тем же условием, что и выборка (ve_directory_plan_population):
 * компания, попавшая в два среза, считается один раз. Компании других баз
 * проекта выборка пропускает, поэтому в доступный остаток они не входят.
 * Карты и вакансии размера не сообщают: прогноз честно ограничен реестром.
 */
async function estimatePlanDirectorySegment(
  plan: VeSourcePlan,
  supabase: SupabaseClient,
  excludeInns: Iterable<string> = [],
): Promise<NonNullable<VeCollectInfo['estimate']>> {
  const slices = plan.tasks.map(veDirectoryPopulationSlice).filter((slice) => slice !== null);
  const unsized = veUnsizedSourceLabels(plan.tasks);
  const provenance = { version: 2 as const, population_method: 'plan_union' as const,
    population_as_of: new Date().toISOString(), population_filters: directoryEstimateScope(plan),
    ...(unsized.length ? { unsized_sources: unsized } : {}) };
  if (slices.length === 0) {
    return {
      ...provenance, population_matches_source: false,
      unique_companies: null,
      companies_with_email: null,
      note: `Оценки нет: у источников этой базы (${unsized.join(', ') || 'без реестра'}) нет размера рынка, объём виден только по фактическим результатам.`,
    };
  }
  const population = await getVeDirectoryPlanPopulation(supabase, slices, excludeInns);
  return {
    ...provenance, population_matches_source: !population.error,
    unique_companies: population.companies_unique_total,
    available_companies: population.companies_available,
    companies_with_email: population.companies_with_email,
    companies_with_phone: population.companies_with_phone,
    directory_rows_total: population.directory_rows_total,
    slice_companies: population.slice_companies,
    ...(population.error ? { note: `Оценка реестрового среза недоступна: ${population.error}` } : {}),
  };
}

/**
 * Пересчитать размер среза с исключением компаний других баз проекта. Свои
 * уже просмотренные компании из исключений убираем: прогноз вычитает их сам.
 */
async function refreshPlanPopulation(
  ctx: VeStageContext,
  base: Pick<VeAutoBase, 'id' | 'project_id' | 'hypothesis_id'>,
  info: VeCollectInfo,
  otherBases?: VeBaseExclusionKeys,
): Promise<void> {
  if (!info.plan) return;
  const hasDirectory = info.plan.tasks.some((task) => task.source === 'companies_directory');
  const keys = otherBases ?? (hasDirectory ? await loadOtherBaseExclusionKeys(ctx, base.project_id, base.id, base.hypothesis_id) : null);
  const own = new Set(readVeRelevanceSourceRows(info.relevance_reserve).map((row) => normalizeVeCompanyInn(cell(row.inn))).filter(Boolean));
  info.estimate = await estimatePlanDirectorySegment(info.plan, ctx.supabase,
    [...(keys?.inns ?? [])].filter((inn) => !own.has(inn)));
}

/** maps_query → inputLines Google Maps (гео доклеивается к каждому запросу). */
export function buildGoogleInputLines(query: { queries: string[]; geo?: string }): string[] {
  return query.queries.map((q) => (query.geo ? `${q} ${query.geo}` : q));
}

/* ─────────────────────── collect_info: форма состояния ─────────────────────── */

export type VeCollectSource = VeCollectTask['source'];

export type VeCollectTaskStatus = 'pending' | 'dispatched' | 'done' | 'failed';

export interface VeCollectTaskState {
  source: VeCollectSource;
  status: VeCollectTaskStatus;
  /** id дочерней джобы парсера; null у синхронного реестра. */
  child_job_id: string | null;
  /** Direct catalog progress; saved together with harvest, never a live parser. */
  catalog?: VeYandexCatalogCheckpoint;
  /** Exhaustion in the existing-stock phase covers only site/email lanes. */
  existing_contacts_only?: true;
  /** Terminal legacy parser retained for diagnostics after explicit continuation. */
  legacy_child_job_id?: string;
  /** Собрано строк (после завершения задачи). */
  rows: number;
  /** Снапшот задачи из плана (фильтры/запросы) — нужен на harvest. */
  task: VeCollectTask;
  /** Унифицированные строки задачи (реестр — сразу на dispatch). */
  harvest?: VeUnifiedRow[];
  /** Когда задача ушла в дочерний парсер (ISO), fallback для старых running без started_at. */
  dispatched_at?: string;
  error?: string;
  /** Реестр: строк пропущено на выборке как уже собранные в других базах проекта. */
  excluded_during_fetch?: number;
  /** Реестр и каталог: строк пропущено на выборке — эта база их уже просматривала. */
  already_seen_during_fetch?: number;
  /** hh_live: длинный запрос не нашёл вакансий, задача повторена по этому короткому (один раз). */
  hh_short_query?: string;
  /**
   * Реестр: закладка выдачи — сколько строк уже просканировано, отдельно для
   * каждого набора фильтров (фаза existing/paid × лейн «есть почта»/«есть
   * сайт»). Без неё каждый добор начинал с нуля, перелистывал уже собранное и
   * упирался в потолок MAX_DIRECTORY_PAGES, после чего сегмент становился
   * недостижимым: повторный запуск снова начинал с первой страницы.
   */
  directory_cursors?: Record<string, number>;
  /** Реестр: выдача под фильтры кончилась раньше limit — сегмент собран целиком. */
  exhausted?: boolean;
  /**
   * Реестр: стоп по потолку MAX_DIRECTORY_PAGES (200k просканированных строк)
   * раньше limit — НЕ исчерпание: выдача ещё есть, повторная сборка продолжит.
   */
  hit_ceiling?: boolean;
  /** Пометка задачи для UI (например, «реестр исчерпан»). */
  note?: string;
}

/** Состояние фазы CONSTRUCT в collect_info (обогащение конструктором баз). */
export interface VeConstructInfo {
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
  /** Пометка для UI (частичный импорт / без обогащения / таймаут). */
  note?: string;
  /** Read-only снимок BC: не заменяет status, управляющий импортом результата. */
  progress?: {
    status: string;
    current_step: number | null;
    total_steps: number | null;
    current_step_key: string | null;
    current_step_progress: number | null;
  };
}

/** Провенанс починки плана: почему её запускали и чем кончилось. */
export interface VePlanRepair {
  reason: 'no_catalog_source';
  outcome: 'repaired' | 'failed';
  /** Срез, которым добрали каталог (outcome='repaired'). */
  pdl_filters?: VeCollectTask['pdl_filters'];
  /** Причина провала починки (outcome='failed'). */
  error?: string;
}

/**
 * Итог пробы каталожного среза (ensureSliceMatchesVertical). outcome='rejected'
 * означает, что база НЕ строилась осознанно: срез не про эту вертикаль, а
 * автопилоту честнее пропустить вертикаль, чем разослать по мусору.
 */
export interface VeSliceProbe {
  outcome: 'passed' | 'repaired' | 'repair_failed' | 'rejected';
  /** Доля строк выборки, признанных принадлежащими вертикали (0..1). */
  hit_rate: number;
  sampled: number;
  /** Доля до перепланирования (у repaired/rejected) — видно, помогло ли. */
  first_hit_rate?: number;
  /** Компании выборки, не признанные подходящими, — объяснение решения. */
  off_target_examples?: string[];
  /** Срез, которым перепланировали (repaired/rejected). */
  pdl_filters?: VeCollectTask['pdl_filters'];
  /** Сколько каталожных задач плана заменено одним срезом (repaired). */
  replaced_tasks?: number;
  /** Причина, по которой перепланирование не состоялось (repair_failed). */
  error?: string;
}

export interface VeCollectInfo {
  adaptive_collection?: VeAdaptiveCollection;
  /** Display/audit snapshot of the last applied "addresses per company" limit; the source of truth is ve_bases.max_emails_per_company. */
  company_contact_cap?: { limit: number; over_cap_rows: number; companies: number; applied_at: string };
  /** Existing contacts/sites first; a cache miss may buy search only in paid.
   * Deferred source rows are worker state, never ready recipients. */
  search_policy?: { version: 1; phase: 'existing' | 'paid'; deferred_rows: VeUnifiedRow[]; construct_rows?: VeUnifiedRow[] };
  /** Durable official-site discovery; never a substitute for email/relevance validation. */
  source_contact_recovery?: VeSourceContactCheckpoint;
  source_contact_budget?: VeSourceDiscoveryBudget;
  source_contact_discovery?: { checked: number; remaining: number; contacts?: number };
  /** Opt-in for NEW previews only. Inputs/IDs are reserved before child insertion. */
  preview_pipeline?: {
    version: 1;
    revision: number;
    batches: Array<{ id: string; rows: VeUnifiedRow[]; dispatched_at: string; inserted?: boolean }>;
    active_batch_id?: string;
    completed_batches?: number;
    /** Compact lineage for timing/cost attribution after batches are consumed. */
    job_ids?: string[];
    started_at?: string;
    first_ready_at?: string;
    target_reached_at?: string;
    error?: string;
  };
  /** Лимит строк, выбранный при запуске сборки (route пишет при создании базы). */
  limit?: number;
  /** Более ранняя авто-сборка проекта: эта база ещё не начала работу. */
  waiting_for_base_id?: string;
  collection_mode?: VeCollectionMode;
  ready_target?: number;
  supply_batch_id?: string;
  supply_hold?: boolean;
  supply_hold_since?: string;
  target_progress?: VeCollectionTargetProgress;
  /** Explicit manual recovery: recheck persisted constructor output, not sources. */
  validation_retry?: boolean;
  /** Latest constructor validation snapshot; per-batch writes live in ve_jobs.result. */
  relevance_checkpoint?: VeRelevanceCheckpoint;
  /** Worker-only complete non-ready candidates; never use directly for sending. */
  relevance_reserve?: VeRelevanceReserve;
  /** Public counts. Pending review is retained stock, not a confirmed recipient. */
  relevance_summary?: VeRelevanceReserveSummary;
  /** Finish bounded evidence passes on saved candidates before purchasing a new round. */
  relevance_review_requested?: boolean;
  /** Selection fingerprint of the last automatic saved-review pass; an identical
   * selection after a pass proves the loop cannot progress. */
  relevance_review_progress?: { signature: string; passes: number };
  /** Подряд идущие раунды, не сдвинувшие ни один счётчик прогресса. Растит
   * паузу перед следующим пробуждением; любое продвижение обнуляет. */
  idle_rounds?: number;
  /** Worker-only checkpoint for validation of saved, unfinished email rows. */
  saved_email_recovery?: import('../savedEmailRecovery').VeSavedEmailRecoveryState;
  company_name_checkpoint?: VeCompanyNameCheckpoint;
  company_name_cleanup?: VeCompanyNameCleanupSummary;
  /** Durable post-validation phase: resume names without re-running paid collection. */
  company_name_recovery?: {
    has_buffered_candidates: boolean;
    validation_error: string | null;
    round_low_relevance: number;
    round_relevance_unchecked: number;
  };
  /** Worker-only: discarded candidates must not be paid for again next round. */
  target_checkpoint?: {
    completed_round: number;
    seen_rows: Array<Pick<VeUnifiedRow, 'company' | 'inn' | 'email'> & Partial<Pick<VeUnifiedRow, 'website' | 'address' | 'source_detail'>>>;
    processed_rows?: number;
    low_relevance?: number;
    relevance_unchecked?: number;
    /** Baselines before this round, retained when its validation is replaced. */
    prior_low_relevance?: number;
    prior_relevance_unchecked?: number;
  };
  /**
   * Refill-режим ENG auto-pipeline (payload.refill джобы): после CONSTRUCT —
   * долив лидов в запущенную кампанию вместо analyzing/base_analyze.
   */
  refill?: boolean;
  /** Кампания Instantly для долива (снапшот launch_info на момент постановки). */
  campaign_id?: string;
  /** Итог refill-ветки (stages/baseCollectRefill.ts). */
  refill_result?: VeRefillResult;
  plan?: VeSourcePlan;
  /**
   * Починка плана без каталожного источника (ensureCatalogSource, market='us').
   * Ключа нет — план пришёл от планировщика как есть. outcome='failed' объясняет
   * тонкую базу: каталога не было и добавить его не вышло.
   */
  plan_repair?: VePlanRepair;
  /**
   * Проба каталожного среза на принадлежность вертикали
   * (ensureSliceMatchesVertical, market='us'). Ключа нет — пробы не было
   * (RU-план, план без каталога или проба не состоялась).
   */
  slice_probe?: VeSliceProbe;
  /** Гипотезы, по которым реально строился план (accepted-дефолт или выбор специалиста). */
  hypotheses?: Array<{ id: string; title: string; status: string | null }>;
  /**
   * Оценка единственного реестрового среза плана. Несколько срезов нельзя
   * складывать: их компании могут пересекаться, поэтому в таком случае числа
   * остаются null, а причина записывается в note.
   */
  estimate?: VeCollectionEstimate;
  tasks?: VeCollectTaskState[];
  /** Фаза CONSTRUCT: состояние передачи базы конструктору (появляется после HARVEST). */
  construct?: VeConstructInfo;
  stats?: {
    tasks_total: number;
    tasks_done: number;
    tasks_failed: number;
    rows_total: number;
    /** Строк отсеяно как уже существующие в других базах проекта. */
    excluded_existing_bases: number;
    /** Строк отсеяно перед конструктором, на обычном harvest. */
    excluded_existing_bases_before_construct?: number;
    /** Строк отсеяно свежей проверкой после конструктора. */
    excluded_existing_bases_after_construct?: number;
    /** Строк не отправлено снова: эта база их уже просматривала (свои прошлые раунды, не другие базы). */
    excluded_already_seen?: number;
    /** Реестр: строк пропущено ещё на выборке (уже собраны в других базах проекта). */
    excluded_during_fetch: number;
    /** Реестр и каталог: строк пропущено на выборке, потому что эта база их уже просматривала. */
    already_seen_during_fetch?: number;
    /** Строк после конструктора и relevance-gate (до launch-фильтра). */
    processed_rows?: number;
    /**
     * Получателей после канонических launch-гейтов email/relevance/dedup.
     * Поля нет, если конструктор не завершил полную построчную validation.
     */
    launchable_rows?: number;
    /** Строк помечено нерелевантными закреплённой гипотезе/вертикали. */
    low_relevance?: number;
    /** Строки, исключённые fail-closed: их company-группа не получила verdict. */
    relevance_unchecked?: number;
    relevance_needs_review?: number;
    relevance_errors?: number;
    /** Покрытие relevance-gate по уникальным company-группам. */
    relevance_checked_companies?: number;
    relevance_total_companies?: number;
    relevance_coverage_complete?: boolean;
    /** Coverage above concerns the remaining saved rows during manual recovery. */
    relevance_recovery?: boolean;
    /** Отсутствует у промежуточного снимка кандидатов до окончания проверок. */
    finished_at?: string;
  };
}

function hasExistingSourceContact(row: VeUnifiedRow): boolean {
  const normalized = normalizeVeSourceContacts(row);
  return Boolean(normalized.website || normalized.email);
}

/** Расширенный срез (вторая очередь, новый срез при исчерпании плана) берёт
 *  только компании с готовой почтой или сайтом — из любого источника, а не
 *  только из реестра. Платный добор сайтов для него не запускается. */
function keepWidenedSourceRow(task: VeCollectTask, row: VeUnifiedRow): boolean {
  return !task.widened || hasExistingSourceContact(row);
}

function retainDeferredSourceRows(info: VeCollectInfo): void {
  if (info.search_policy?.phase !== 'existing') return;
  info.search_policy.deferred_rows = dedupUnifiedRows([
    ...info.search_policy.deferred_rows,
    ...(info.tasks ?? []).flatMap((task) => (task.harvest ?? []).filter((row) => !hasExistingSourceContact(row))),
  ]);
}

/** ve_bases-строка авто-сборки: колонки source/collect_info моложе VeBase. */
type VeAutoBase = VeBase & {
  source?: string;
  collect_info?: VeCollectInfo | null;
  error?: string | null;
};

/** Таблица дочерней джобы по источнику (у реестра и ENG-источников pdl/funded/eng_hiring дочерней джобы нет). */
const CHILD_JOB_TABLE: Record<'hh_live' | 'yandex_maps' | 'google_maps', string> = {
  hh_live: 'parser_jobs',
  yandex_maps: 'yandex_maps_jobs',
  google_maps: 'google_maps_jobs',
};

/** Дочерняя джоба завершилась неудачно? google_maps имеет свой набор статусов. */
function isChildFailed(source: VeCollectSource, status: string): boolean {
  return source === 'google_maps'
    ? status === 'failed' || status === 'stopped'
    : status === 'failed';
}

async function persistCollectInfo(
  ctx: VeStageContext,
  baseId: string,
  info: VeCollectInfo,
  patch: Record<string, unknown> = {},
): Promise<void> {
  ctx.signal?.throwIfAborted();
  if (info.preview_pipeline) {
    const revision = info.preview_pipeline.revision;
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid preview checkpoint revision');
    const next = { ...info, preview_pipeline: { ...info.preview_pipeline, revision: revision + 1 } };
    const { data, error } = await ctx.supabase.from('ve_bases')
      .update({ ...patch, collect_info: next, updated_at: new Date().toISOString() })
      .eq('id', baseId).eq('status', 'collecting')
      .eq('collect_info->preview_pipeline->>revision', String(revision)).select('id').maybeSingle();
    if (error) throw new VeRelevanceCheckpointError(`Preview checkpoint save: ${error.message}`);
    if (!data) throw new VePreviewCheckpointConflict('Preview checkpoint changed; stale writer stopped');
    info.preview_pipeline.revision = revision + 1;
    ctx.onCheckpoint?.();
    return;
  }
  const { error } = await ctx.supabase
    .from('ve_bases')
    .update({ ...patch, collect_info: info, updated_at: new Date().toISOString() })
    .eq('id', baseId);
  if (error) throw new Error(`ve_bases collect_info update: ${error.message}`);
  ctx.onCheckpoint?.();
}

/* ─────────────────────────── Фаза PLAN ─────────────────────────── */

async function buildPlan(
  job: VeJob,
  ctx: VeStageContext,
  vertical: VeVertical,
  usage: VeUsage,
  market: VeMarket,
  hypothesisId: string | null,
  strategyFeedback?: string,
): Promise<{
  plan: VeSourcePlan;
  planRepair?: VePlanRepair;
  sliceProbe?: VeSliceProbe;
  usedHypotheses: Array<{ id: string; title: string; status: string | null }>;
}> {
  // Гипотезы вертикали для плана. Семантика разметки: если специалист что-то
  // ПРИНЯЛ (accepted) — план строим только по принятым; предложенные (proposed)
  // идут в работу, только когда принятых нет (как в пересчёте % вертикали).
  const { data: hypRows, error: hError } = await ctx.supabase
    .from('ve_hypotheses')
    .select('id, title, description, tier, status')
    .eq('project_id', job.project_id)
    .eq('vertical_id', vertical.id)
    .neq('status', 'rejected')
    .order('potential_pct', { ascending: false });
  if (hError) throw new Error(`ve_hypotheses read: ${hError.message}`);
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

  // Base-per-hypothesis: если джоба несёт payload.hypothesis_id — план строим
  // по ЭТОЙ одной гипотезе (не по пересечению выбранных; на каждую гипотезу
  // своя база/джоба). Фолбэк без hypothesis_id (легаси/ENG-refill) — прежняя
  // семантика: hypothesis_ids из payload, иначе принятые, иначе все.
  if (hypothesisId) {
    hypotheses = hypotheses.filter((h) => h.id === hypothesisId);
    if (hypotheses.length === 0) {
      throw new Error('Гипотеза для сборки не найдена или отклонена');
    }
  } else {
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
  }

  // Типы компаний из последнего вокабуляра; вокабуляра может не быть — идём без него.
  let companyTypes: string[] = [];
  const { data: vocabRow, error: vocabError } = await ctx.supabase
    .from('ve_vocab')
    .select('company_types')
    .eq('vertical_id', vertical.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (vocabError) {
    stageLog(ctx, `[base_collect] ve_vocab read: ${vocabError.message} — продолжаем без типов компаний`);
  } else if (Array.isArray(vocabRow?.company_types)) {
    companyTypes = (vocabRow.company_types as Array<{ term?: unknown }>)
      .map((t) => (typeof t?.term === 'string' ? t.term : ''))
      .filter(Boolean);
  }

  // Широкая гипотеза (сектор для ежедневного добора) — только в плане своей базы.
  const broad = hypothesisId ? await readVeHypothesisBroad(ctx, hypothesisId) : false;
  const promptInput = {
    verticalName: vertical.name,
    verticalSummary: vertical.summary,
    synonyms: Array.isArray(vertical.synonyms) ? vertical.synonyms : [],
    hypotheses: broad ? hypotheses.map((h) => ({ ...h, broad: true })) : hypotheses,
    companyTypes,
  };

  const llm = await callLLMWithSchema(
    // Рынок 'us' — EN-промпт с ENG-источниками (pdl/funded/eng_hiring/google_maps).
    [...(market === 'us' ? buildSourcePlanMessagesEn : buildSourcePlanMessages)(promptInput),
      ...(strategyFeedback ? [{ role: 'user' as const, content: strategyFeedback }] : [])],
    VeSourcePlanSchema,
    { model: getVeModel('collection') },
  );
  addUsage(usage, llm);

  // Рынок РФ: живой Google Maps заменяется готовым каталогом Яндекс Карт.
  const ruMaps = market === 'us' ? null : veRuMapsUseCatalog(llm.data);
  if (ruMaps?.replaced) stageLog(ctx, `[base_collect] план: ${ruMaps.replaced} задач Google Maps переведены на готовый каталог Яндекс Карт`);
  const withCatalog = await ensureCatalogSource(ctx, ruMaps?.plan ?? llm.data, promptInput, usage, market);
  // Проба идёт ПОСЛЕ починки «каталога нет вовсе»: чинить нечего, пока задачи
  // не существует, а добавленный срез проверяется на общих основаниях.
  const { plan: probed, sliceProbe } = await ensureSliceMatchesVertical(
    ctx,
    withCatalog.plan,
    vertical,
    promptInput,
    usage,
    market,
  );
  // Запрет из промпта закреплён в коде: порог размера без основания в тексте
  // гипотезы в план не попадает (новый план и перепланирование).
  const { plan: sized, stripped } = stripUnfoundedSizeFilters(probed,
    hypotheses.map((h) => `${h.title} ${h.description ?? ''}`).join('\n'));
  if (stripped) stageLog(ctx, `[base_collect] план: сняты пороги выручки/штата без основания в гипотезе (${stripped} задач)`);
  const { plan, changed: broadened } = broad ? veBroadHypothesisPlan(sized) : { plan: sized, changed: 0 };
  if (broadened) stageLog(ctx, `[base_collect] план широкой гипотезы: классы ОКВЭД, без порогов размера и сигнала найма (${broadened} задач)`);
  return {
    plan,
    planRepair: withCatalog.planRepair,
    sliceProbe,
    // Провенанс плана: по каким гипотезам реально строили (для collect_info и UI —
    // иначе на вопрос «точно все верно?» ответа нет ни в БД, ни на экране).
    usedHypotheses: hypotheses.map((h) => ({ id: h.id, title: h.title, status: h.status })),
  };
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
  ctx: VeStageContext,
  plan: VeSourcePlan,
  promptInput: SourcePlanPromptInput,
  usage: VeUsage,
  market: VeMarket,
): Promise<{ plan: VeSourcePlan; planRepair?: VePlanRepair }> {
  if (market !== 'us') return { plan };
  if (plan.tasks.some((t) => t.source === 'pdl' || t.source === 'funded')) return { plan };

  let repair;
  try {
    repair = await callLLMWithSchema(buildCatalogRepairMessagesEn(promptInput), VeCatalogRepairSchema, {
      model: getVeModel('collection'),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    stageLog(ctx, `[base_collect] починка плана (нет каталога) не удалась: ${message}`);
    return { plan, planRepair: { reason: 'no_catalog_source', outcome: 'failed', error: message } };
  }
  addUsage(usage, repair);

  const task: VeCollectTask = {
    source: 'pdl',
    rationale: repair.data.rationale,
    pdl_filters: repair.data.pdl_filters,
  };
  // Потолок плана — 4 задачи (VeSourcePlanSchema). Если модель уже выбрала
  // четыре, каталожный срез вытесняет последнюю: без каталога база всё равно
  // не наберёт объём, а порядок задач у планировщика — от важного к частному.
  const tasks = plan.tasks.length >= 4 ? plan.tasks.slice(0, 3) : plan.tasks.slice();
  tasks.push(task);
  stageLog(
    ctx,
    `[base_collect] в плане не было каталога — добавлен pdl-срез: ${JSON.stringify(repair.data.pdl_filters)}`,
  );
  return {
    plan: { tasks },
    planRepair: { reason: 'no_catalog_source', outcome: 'repaired', pdl_filters: repair.data.pdl_filters },
  };
}

/**
 * ВСЕ каталожные задачи плана. Именно все: боевой план 12.08 нёс ТРИ pdl-среза
 * с разными наборами индустрий, и проба только первого пропустила бы две трети
 * мусора — заменённый срез дал бы ~1300 целевых строк, а два оставшихся широких
 * добили бы кап 2000 нецелевыми.
 */
function findCatalogTasks(plan: VeSourcePlan): number[] {
  return plan.tasks
    .map((t, i) => (t.source === 'pdl' || t.source === 'funded' ? i : -1))
    .filter((i) => i >= 0);
}

/** Выборка из среза одной задачи: те же коллекторы, только с крошечным лимитом. */
async function sampleCatalogSlice(
  ctx: VeStageContext,
  task: VeCollectTask,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  if (task.source === 'funded') {
    const rows = await fetchFundedRows(ctx, task.funded_filters, limit);
    return rows.map((r) => mapFundedRow(r) as unknown as Record<string, unknown>);
  }
  const rows = await fetchPdlRows(ctx, task.pdl_filters, limit);
  return rows.map((r) => mapPdlRow(r) as unknown as Record<string, unknown>);
}

/**
 * Общая выборка каталожной части плана: поровну из каждого среза (проба меряет
 * «каталожную часть» целиком — решение принимается по ней одной, см. ниже).
 */
async function sampleCatalogTasks(
  ctx: VeStageContext,
  tasks: VeCollectTask[],
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
  ctx: VeStageContext,
  plan: VeSourcePlan,
  vertical: VeVertical,
  promptInput: SourcePlanPromptInput,
  usage: VeUsage,
  market: VeMarket,
): Promise<{ plan: VeSourcePlan; sliceProbe?: VeSliceProbe }> {
  if (market !== 'us') return { plan };
  const catalogIdx = findCatalogTasks(plan);
  if (catalogIdx.length === 0) return { plan };

  const probe = async (tasks: VeCollectTask[]) => {
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
    repair = await callLLMWithSchema(buildCatalogRepairMessagesEn(promptInput), VeCatalogRepairSchema, {
      model: getVeModel('collection'),
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

  const retried: VeCollectTask = {
    source: 'pdl',
    rationale: repair.data.rationale,
    pdl_filters: repair.data.pdl_filters,
  };
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
        pdl_filters: repair.data.pdl_filters,
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
    `[base_collect] каталожная часть плана (${catalogIdx.length} задач) заменена одним срезом (${pct(first)} → ${pct(second)}): ${JSON.stringify(repair.data.pdl_filters)}`,
  );
  return {
    plan: { tasks },
    sliceProbe: {
      outcome: 'repaired',
      hit_rate: second.hitRate,
      sampled: second.sampled,
      first_hit_rate: first.hitRate,
      pdl_filters: repair.data.pdl_filters,
      replaced_tasks: catalogIdx.length,
    },
  };
}

/* ─────────────────────────── Фаза DISPATCH ─────────────────────────── */

/** Сколько ждём дочернюю джобу парсера, прежде чем считать её зависшей. */
const CHILD_TIMEOUT_MS = 3 * 60 * 60 * 1000;

async function insertChildJob(
  ctx: VeStageContext,
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
 * проекта (формат loadOtherBaseExclusionKeys: email, имя с ИНН-уточнением
 * или точный ИНН, см. baseRowMatchesExclusion — как и на финальном мёрдже). Известные строки
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
export async function fetchDirectoryRows(
  ctx: VeStageContext,
  filters: CompaniesSearchFilters,
  limit: number,
  excludedKeys: VeBaseExclusionKeys,
  startOffset = 0,
  keep?: (row: Record<string, unknown>) => boolean,
): Promise<{
  rows: Record<string, unknown>[];
  excludedDuringFetch: number;
  /** Пропущено, потому что эта база уже просматривала строку (не другие базы). */
  alreadySeenDuringFetch: number;
  exhausted: boolean;
  hitCeiling: boolean;
  /** Сколько строк выдачи просканировано суммарно — закладка следующего захода. */
  nextOffset: number;
  error?: string;
}> {
  const rows: Record<string, unknown>[] = [];
  let excludedDuringFetch = 0;
  let alreadySeenDuringFetch = 0;
  let offset = Number.isSafeInteger(startOffset) && startOffset > 0 ? startOffset : 0;
  let page = 0;
  for (; page < MAX_DIRECTORY_PAGES && rows.length < limit; page += 1) {
    // A deep scan logs nothing until it ends: each page is progress for the
    // inactivity watchdog, and a cancel must not wait for the last page.
    ctx.signal?.throwIfAborted();
    const res = await searchRows(filters, DIRECTORY_PAGE_SIZE, offset);
    ctx.onActivity?.();
    if (res.error) {
      // Страницы до сбоя разобраны полностью, и offset двигался только по ним.
      // Отдаём префикс вместе с его закладкой: строки уже оплачены сканом, а
      // выбросить их — значит на следующем заходе листать тот же кусок заново.
      return { rows, excludedDuringFetch, alreadySeenDuringFetch, exhausted: false, hitCeiling: false, nextOffset: offset, error: res.error };
    }
    // Смещение двигаем по ПРОСМОТРЕННЫМ строкам, а не по всей странице:
    // закладка не имеет права перешагнуть строки, которые мы не разобрали —
    // иначе следующий заход их больше никогда не увидит.
    let scanned = 0;
    for (const r of res.rows) {
      if (rows.length >= limit) break;
      scanned += 1;
      // Вторая очередь: ослабленный порог размера проверяется здесь, потому что
      // реестр не умеет «порог или пустое поле».
      if (keep && !keep(r)) continue;
      // Дубль другой базы: по email, имени (с ИНН-уточнением) или точно по ИНН.
      const mapped = mapDirectoryRow(r);
      const pruned = pruneBaseRowAgainstExclusion(excludedKeys, mapped);
      if (!pruned) {
        if (excludedByOtherBases(excludedKeys, mapped)) excludedDuringFetch += 1;
        else alreadySeenDuringFetch += 1;
        continue;
      }
      rows.push(pruned.email === cell(r.email) ? r : { ...r, email: pruned.email });
    }
    offset += scanned;
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
  if (alreadySeenDuringFetch > 0) {
    stageLog(ctx, `[base_collect] реестр: ${alreadySeenDuringFetch} строк пропущено на выборке — эта база их уже просматривала`);
  }
  return { rows, excludedDuringFetch, alreadySeenDuringFetch, exhausted, hitCeiling, nextOffset: offset };
}

/**
 * Закладка выдачи реестра хранится по ключу фильтров: у каждого набора своя
 * нумерация строк, и продолжать чужую нельзя. RPC отдаёт строго `order by
 * c.id`, новые компании получают больший id и попадают в конец выдачи —
 * поэтому смещение остаётся верным между заходами.
 */
const DIRECTORY_CURSOR_LIMIT = 8;
function directoryCursorKey(filters: CompaniesSearchFilters): string {
  const stable = Object.entries(filters).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}
function readDirectoryCursor(state: VeCollectTaskState, filters: CompaniesSearchFilters): number {
  const saved = state.directory_cursors?.[directoryCursorKey(filters)];
  return typeof saved === 'number' && Number.isSafeInteger(saved) && saved > 0 ? saved : 0;
}
function writeDirectoryCursor(state: VeCollectTaskState, filters: CompaniesSearchFilters, offset: number): void {
  if (!Number.isSafeInteger(offset) || offset <= 0) return;
  const key = directoryCursorKey(filters);
  const cursors = { ...(state.directory_cursors ?? {}) };
  // Ключей у задачи единицы: фаза × лейн. Их перебор — признак смены плана, и
  // продолжать по старым закладкам всё равно нельзя.
  if (!(key in cursors) && Object.keys(cursors).length >= DIRECTORY_CURSOR_LIMIT) {
    state.directory_cursors = { [key]: offset };
    return;
  }
  cursors[key] = offset;
  state.directory_cursors = cursors;
}

/* ─────────────────────── ENG-источники: прямое чтение справочников ─────────────────────── */

/** Страница keyset-пагинации справочников pdl/funded (id — text PK). */
const ENG_CATALOG_PAGE_SIZE = 1000;
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
 * (ilike, как в /api/company-base). Исключения чужих баз на выборке нет
 * (как у hh/карт) — только на мёрдже.
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
 * Переопределяется `VE_PDL_READ_RETRY_DELAYS_MS` (мс через запятую) — читается
 * на каждом вызове, чтобы тесты не ждали реальные минуты.
 */
const PDL_READ_RETRY_DELAYS_DEFAULT = '3000,20000,60000';

function pdlReadRetryDelays(): number[] {
  return (process.env.VE_PDL_READ_RETRY_DELAYS_MS || PDL_READ_RETRY_DELAYS_DEFAULT)
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

async function fetchPdlRows(
  ctx: VeStageContext,
  filters: VeCollectTask['pdl_filters'],
  limit: number,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let lastId = '';
  for (;;) {
    ctx.signal?.throwIfAborted(); ctx.onActivity?.();
    const params = {
      p_industries: filters?.industries?.length ? lowerList(filters.industries) : null,
      p_sizes: filters?.sizes?.length ? lowerList(filters.sizes) : null,
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
    if (error) throw new Error(cleanPdlReadError(error.message));
    const page = (data ?? []) as Record<string, unknown>[];
    for (const r of page) {
      if (rows.length < limit) rows.push(r);
    }
    if (rows.length >= limit || page.length < ENG_CATALOG_PAGE_SIZE) return rows;
    lastId = cell(page[page.length - 1]?.id);
    // Строка без id — курсора нет, дальше не листнуть (защита от зацикливания).
    if (!lastId) return rows;
  }
}

/**
 * funded_companies (стартапы и раунды) keyset-пагинацией по id до limit строк.
 * Фильтры — applyFundedFilters из /api/funded: единая семантика с вкладкой
 * Crunchbase (min funding: last ИЛИ total; funded_since: last_funding_date >=).
 */
async function fetchFundedRows(
  ctx: VeStageContext,
  filters: VeCollectTask['funded_filters'],
  limit: number,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let lastId = '';
  for (;;) {
    ctx.signal?.throwIfAborted(); ctx.onActivity?.();
    let query = ctx.supabase
      .from('funded_companies')
      .select(
        'id, name, website, industry, country, region, locality, total_funding_usd, last_funding_usd, last_funding_type, last_funding_date, batch, source',
      )
      .gt('id', lastId)
      .order('id')
      .limit(ENG_CATALOG_PAGE_SIZE);
    query = applyFundedFilters(query, {
      industry: filters?.industries?.length ? lowerList(filters.industries) : undefined,
      country: filters?.countries?.length ? lowerList(filters.countries) : undefined,
      minFunding: filters?.min_funding_usd ?? null,
      fundedSince: filters?.funded_since ?? null,
    });
    const { data, error } = await query;
    if (error) throw new Error(`funded_companies read: ${error.message}`);
    const page = (data ?? []) as Record<string, unknown>[];
    for (const r of page) {
      if (rows.length < limit) rows.push(r);
    }
    if (rows.length >= limit || page.length < ENG_CATALOG_PAGE_SIZE) return rows;
    lastId = cell(page[page.length - 1]?.id);
    if (!lastId) return rows;
  }
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
  ctx: VeStageContext,
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
 * Пагинация офсетная (order по published_at с keyset несовместим), с потолком
 * ENG_HIRING_MAX_PAGES.
 */
async function fetchEngHiringRows(
  ctx: VeStageContext,
  query: VeCollectTask['eng_hiring_query'],
  limit: number,
): Promise<Record<string, unknown>[]> {
  const roles = query?.roles ?? [];
  const rolesRegex = buildRolesRegex(roles.join(', '));
  const rolesFilter = buildRolesIlikeFilter(roles);
  const days = query?.posted_within_days ?? 0;
  const cutoff = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : null;
  const countries = query?.countries?.length ? lowerList(query.countries) : null;

  const matched: Record<string, unknown>[] = [];
  let offset = 0;
  for (let page = 0; page < ENG_HIRING_MAX_PAGES && matched.length < limit; page += 1) {
    ctx.signal?.throwIfAborted(); ctx.onActivity?.();
    let q = ctx.supabase
      .from('eng_hiring_cache')
      .select('company_name, company_site_url, vacancy_title, location, country, country_code, source, published_at');
    if (countries) q = q.in('country_code', countries);
    if (cutoff) q = q.gte('published_at', cutoff);
    if (rolesFilter) q = q.or(rolesFilter);
    const { data, error } = await q
      .order('published_at', { ascending: false })
      .range(offset, offset + ENG_HIRING_PAGE_SIZE - 1);
    if (error) throw new Error(`eng_hiring_cache read: ${error.message}`);
    const rows = (data ?? []) as Record<string, unknown>[];
    for (const r of rows) {
      if (rolesRegex.test(cell(r.vacancy_title))) matched.push(r);
    }
    if (rows.length < ENG_HIRING_PAGE_SIZE) break;
    offset += rows.length;
  }

  // Keep the latest vacancy per confirmed name + site identity. Generic names
  // without sites cannot identify an employer: retain distinct observations.
  matched.sort((a, b) => publishedTime(b.published_at) - publishedTime(a.published_at));
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const r of matched) {
    if (!normalizeCompanyForDedup(cell(r.company_name))) continue;
    const companyKey = veCompanyWebsiteKey({ company: r.company_name, website: r.company_site_url });
    const key = companyKey ? `site:${companyKey}`
      : `observation:${JSON.stringify(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)))}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (out.length < limit) out.push(r);
  }

  // Досбор сайтов — ПОСЛЕ дедупа: резолвим только те строки, что реально уйдут
  // в базу, а не каждую просканированную вакансию.
  const missing = out.filter((r) => !cell(r.company_site_url)).length;
  if (missing > 0) {
    const filled = await fillMissingCompanySites(ctx, out);
    stageLog(ctx, `[base_collect] eng_hiring: сайт дособран у ${filled} из ${missing} строк без него`);
  }
  return out;
}

async function dispatchTask(
  ctx: VeStageContext,
  state: VeCollectTaskState,
  project: VeProject,
  limit: number,
  getExcludedKeys: () => Promise<VeBaseExclusionKeys>,
  usage: VeUsage,
  save: () => Promise<void>,
  existingContactsOnly = false,
): Promise<void> {
  const { task } = state;

  if (task.source === 'yandex_maps') {
    if (limit < 1) { state.status = 'done'; return; }
    if (!task.maps_query?.queries?.length) throw new Error('yandex_maps: в задаче нет maps_query.queries');
    if (!state.catalog) {
      const filters = await resolveVeYandexCatalogFilters({ db: ctx.supabase, query: task.maps_query,
        context: task.rationale, signal: ctx.signal, onUsage: (used) => addUsage(usage, used) });
      state.catalog = { version: 1, filters };
      await save(); // Reuse the resolved filter after a read failure/redeploy.
    }
    const excluded = await getExcludedKeys();
    state.harvest ??= [];
    state.child_job_id = null;
    // Bound each worker tick; a heavily consumed catalog continues from the
    // saved key, without re-reading the first pages or starting a parser.
    for (let page = 0; page < 4 && state.harvest.length < limit && !state.exhausted; page++) {
      const rows = await readVeYandexCatalogPage(ctx.supabase, state.catalog,
        Math.min(500, limit - state.harvest.length), ctx.signal);
      if (!rows.length) state.exhausted = true;
      for (const row of rows) {
        if (!row.yandex_id || row.yandex_id === state.catalog.after) throw new Error('yandex_maps: каталог не продвинул курсор');
        const source = mapYandexRow(row);
        const mapped = pruneBaseRowAgainstExclusion(excluded, source);
        if (!mapped && !excludedByOtherBases(excluded, source)) state.already_seen_during_fetch = (state.already_seen_during_fetch ?? 0) + 1;
        else if (!mapped || !normalizeCompanyForDedup(mapped.company)) state.excluded_during_fetch = (state.excluded_during_fetch ?? 0) + 1;
        else if (keepWidenedSourceRow(task, mapped)) state.harvest.push(mapped);
        state.catalog.after = row.yandex_id;
      }
      state.harvest = dedupUnifiedRows(state.harvest);
      state.rows = state.harvest.length;
      state.status = state.exhausted || state.rows >= limit ? 'done' : 'pending';
      state.note = state.exhausted ? 'готовый каталог Яндекс Карт исчерпан' : 'выборка из готового каталога Яндекс Карт';
      await save(); // Cursor and rows commit atomically, including an empty page.
    }
    if (state.exhausted || state.harvest.length >= limit) state.status = 'done';
    return;
  }

  // Реестр — синхронно, без дочерней джобы: строки сразу ложатся в задачу.
  // Компании других баз проекта исключаются ещё на выборке (fetchDirectoryRows),
  // иначе повторная сборка сегмента заново скачивала уже собранные страницы.
  if (task.source === 'companies_directory') {
    const filters = mapDirectoryFilters(task.directory_filters);
    const keep = veDirectorySizeKeep(task.directory_filters?.sizeOrUnknown);
    const excluded = await getExcludedKeys();
    // Компания с готовым адресом — это контакт, за который не нужно платить ни
    // обходом сайта, ни очередью SMTP-проверки. Такие берём ПЕРВЫМИ, и только
    // потом добираем тех, у кого есть лишь сайт. Раньше порядок был обратный,
    // а лейн с почтой запускался лишь при полном исчерпании первого — то есть
    // практически никогда, потому что лейн «с сайтом» упирался в потолок
    // сканирования раньше, чем исчерпывался.
    const firstFilters = existingContactsOnly ? { ...filters, hasEmail: true } : filters;
    const first = await fetchDirectoryRows(ctx, firstFilters, limit, excluded, readDirectoryCursor(state, firstFilters), keep);
    // Второй лейн запускаем и после потолка сканирования, а не только после
    // исчерпания: иначе недобор первого лейна навсегда оставляет партию пустой.
    const secondFilters = { ...filters, hasWebsite: true };
    const second = existingContactsOnly && !first.error && (first.exhausted || first.hitCeiling) && first.rows.length < limit
      ? await fetchDirectoryRows(ctx, secondFilters, limit - first.rows.length,
        addRowsToExclusionKeys(copyExclusionKeys(excluded), first.rows.map(mapDirectoryRow)),
        readDirectoryCursor(state, secondFilters), keep) : null;
    const rows = [...first.rows, ...(second?.rows ?? [])];
    const excludedDuringFetch = first.excludedDuringFetch + (second?.excludedDuringFetch ?? 0);
    const alreadySeenDuringFetch = first.alreadySeenDuringFetch + (second?.alreadySeenDuringFetch ?? 0);
    const exhausted = first.exhausted && (!existingContactsOnly || second?.exhausted === true);
    const hitCeiling = first.hitCeiling || second?.hitCeiling === true;
    const error = first.error ?? second?.error;
    // Обрыв выдачи посреди лейна — не повод выбросить разобранный префикс.
    // Падаем только когда фиксировать нечего: иначе таймаут шлюза на
    // очередной странице уносил и собранные строки, и задачу, и всю базу
    // (прод 21.09, база 3cd77243: 400 компаний и 10 590 просмотренных строк).
    // Закладка и строки фиксируются одной записью: смещение двигается ровно по
    // тем строкам, которые ушли в harvest, поэтому перешагнуть неразобранное
    // оно не может — ни при успехе лейна, ни при обрыве.
    writeDirectoryCursor(state, firstFilters, first.nextOffset);
    if (second) writeDirectoryCursor(state, secondFilters, second.nextOffset);
    if (error && rows.length === 0) {
      // Even an empty prefix can have skipped many already checked companies.
      // Keep that progress and any old harvest before the worker retries with
      // its bounded backoff; the failed page itself has not been advanced.
      await save();
      throw new Error(`companies_directory: ${error}`);
    }
    if (existingContactsOnly) state.existing_contacts_only = true;
    else delete state.existing_contacts_only;
    // Лейны «есть почта / есть сайт» уже дают контакт; фильтр страхует строки,
    // чей адрес в реестре оказался невалидным.
    state.harvest = rows.map(mapDirectoryRow).filter((row) => keepWidenedSourceRow(task, row));
    state.status = 'done';
    state.rows = state.harvest.length;
    state.child_job_id = null;
    if (excludedDuringFetch > 0) state.excluded_during_fetch = excludedDuringFetch;
    if (alreadySeenDuringFetch > 0) state.already_seen_during_fetch = alreadySeenDuringFetch;
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
    } else if (error) {
      // Партия частичная: источник жив, лейн оборвался на странице. Ни
      // exhausted, ни hit_ceiling не ставим — продолжение пойдёт с закладки.
      state.note = `частичная партия: выдача реестра оборвалась (${error})`;
    }
    if (error) stageLog(ctx, `[base_collect] реестр: партия собрана частично, взято ${rows.length} строк, выдача оборвалась: ${error}`);
    return;
  }

  // ENG-источники (market='us') — тоже синхронно, без дочерних джоб: справочные
  // таблицы читаются напрямую, строки сразу ложатся в задачу (как реестр, но
  // без исключения чужих баз на выборке — оно на мёрдже, как у hh/карт).
  if (task.source === 'pdl' || task.source === 'funded' || task.source === 'eng_hiring') {
    const rows =
      task.source === 'pdl'
        ? await fetchPdlRows(ctx, task.pdl_filters, limit)
        : task.source === 'funded'
          ? await fetchFundedRows(ctx, task.funded_filters, limit)
          : await fetchEngHiringRows(ctx, task.eng_hiring_query, limit);
    state.harvest = rows.map(
      task.source === 'pdl' ? mapPdlRow : task.source === 'funded' ? mapFundedRow : mapEngHiringRow,
    ).filter((row) => keepWidenedSourceRow(task, row));
    state.status = 'done';
    state.rows = state.harvest.length;
    state.child_job_id = null;
    return;
  }

  // Дочерним джобам парсеров обязателен владелец (user_id NOT NULL).
  if (!project.created_by) {
    throw new Error('ve_projects.created_by пуст — дочерней джобе парсера некому принадлежать');
  }
  const userId = project.created_by;

  if (task.source === 'hh_live') {
    const q = task.hh_query;
    if (!q?.text) throw new Error('hh_live: в задаче нет hh_query.text');
    // Россия по умолчанию: LLM может не указать area, а план — только рынок РФ/СНГ.
    const config: Record<string, unknown> = { text: state.hh_short_query ?? q.text, per_page: 100, area: q.area ?? '113' };
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
  ctx: VeStageContext,
  state: VeCollectTaskState,
  limit: number,
): Promise<VeUnifiedRow[]> {
  const jobId = state.child_job_id;
  if (!jobId) return [];

  if (state.source === 'hh_live') {
    const { data, error } = await ctx.supabase
      .from('hh_vacancies')
      .select('name, company_name, company_site_url, area')
      .eq('job_id', jobId)
      .limit(limit);
    if (error) throw new Error(`hh_vacancies read: ${error.message}`);
    const queryText = state.hh_short_query ?? state.task.hh_query?.text ?? '';
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

/**
 * hh.ru находит вакансии, где есть ВСЕ слова запроса: «инженер технолог
 * производство завод рабочий качество HSE» у b5934955 не нашёл ни одной.
 * Короткий запрос — первые три слова; запрос на языке поиска hh (OR, AND,
 * NOT, кавычки, скобки, поля) составлен намеренно и не меняется.
 */
export function veShortHhQuery(text: string): string | null {
  const query = text.trim();
  if (/\b(?:OR|AND|NOT)\b|["()!*]|\b[A-Z_]+:/.test(query)) return null;
  const words = query.split(/\s+/).filter(Boolean);
  return words.length > 3 ? words.slice(0, 3).join(' ') : null;
}

/** Опросить дочернюю джобу задачи: completed → harvest, failed/stopped → failed. */
async function pollTask(ctx: VeStageContext, state: VeCollectTaskState, limit: number): Promise<void> {
  // До poll доходят только источники с дочерними джобами (остальные done на dispatch).
  const table = CHILD_JOB_TABLE[state.source as keyof typeof CHILD_JOB_TABLE];
  if (!table || !state.child_job_id) return;

  const { data, error } = await ctx.supabase
    .from(table)
    .select('status, error_message, started_at')
    .eq('id', state.child_job_id)
    .maybeSingle();
  if (error) throw new Error(`${table} read: ${error.message}`);
  if (!data) {
    state.status = 'failed';
    state.error = `дочерняя джоба ${state.child_job_id} не найдена`;
    return;
  }

  const row = data as { status?: unknown; error_message?: unknown; started_at?: unknown };
  const status = String(row.status ?? '');
  if (status === 'completed') {
    state.harvest = await readChildRows(ctx, state, limit);
    const shorter = state.source === 'hh_live' && state.harvest.length === 0 && !state.hh_short_query
      ? veShortHhQuery(state.task.hh_query?.text ?? '') : null;
    if (shorter) {
      // Пустая выдача по длинному запросу — не исчерпание рынка: задача
      // повторяется один раз по короткому запросу (hh.ru бесплатен, вакансии
      // той же роли просто перестают требовать все семь слов разом).
      state.hh_short_query = shorter;
      state.status = 'pending';
      state.child_job_id = null;
      state.rows = 0;
      state.note = `hh.ru не нашёл вакансий по длинному запросу — повтор по короткому «${shorter}»`;
      stageLog(ctx, `[base_collect] hh_live: 0 вакансий по «${state.task.hh_query?.text ?? ''}», повтор по «${shorter}»`);
      return;
    }
    state.status = 'done';
    state.rows = state.harvest.length;
  } else if (isChildFailed(state.source, status)) {
    state.status = 'failed';
    state.error =
      (typeof row.error_message === 'string' && row.error_message) || `дочерняя джоба: ${status}`;
  } else if (status === 'running' || status === 'processing') {
    // Queue wait (including a redeploy recovery) is not parser execution.
    // Read terminal status first so a completed old child is still harvested.
    const startedAt = typeof row.started_at === 'string' ? row.started_at : state.dispatched_at;
    if (startedAt && Date.now() - Date.parse(startedAt) > CHILD_TIMEOUT_MS) {
      state.status = 'failed';
      state.error = 'timeout: дочерний сбор выполняется дольше 3 часов';
      stageLog(ctx, `[base_collect] ${state.source}: ${state.error} (${state.child_job_id})`);
    }
  }
  // queued/running/pending — задача остаётся dispatched, ждём следующий тик.
}

/* ─────────────────────────── Исключение чужих баз проекта ─────────────────────────── */

/**
 * Занятые юрлица подтверждаются ИНН или парой «имя + сайт». Одного имени
 * недостаточно: «Клиника» без ИНН не должна закрывать другие клиники.
 * Email остаётся независимым ключом защиты от повторной отправки.
 */
export interface VeBaseExclusionKeys {
  /** Exact observations consumed by THIS base only, including rows without IDs. */
  receipts?: Set<string>;
  /** Компании, уже отправленные ЭТОЙ базой, с их адресами и сайтами (seenCompanies.ts). */
  seen?: VeSeenCompanies;
  /** Пара «имя + сайт» → ИНН'ы; пустая строка означает неизвестный ИНН. */
  websiteInns: Map<string, Set<string>>;
  /** Все ИНН других баз (матч «то же юрлицо, другое написание»). */
  inns: Set<string>;
  /** Все email других баз: один и тот же контакт не должен попасть в разные запуски. */
  emails: Set<string>;
  /**
   * Те же ключи без строк самой базы. Нужны только счётчикам: у 6b475d8c
   * «компании уже есть в других базах» — 1 100 строк, и почти все они были
   * собственными уже просмотренными строками базы.
   */
  otherBases?: VeBaseExclusionKeys;
}

/** Независимая копия: добавление ключей в неё не меняет исходные. */
function copyExclusionKeys(keys: VeBaseExclusionKeys): VeBaseExclusionKeys {
  return { inns: new Set(keys.inns), emails: new Set(keys.emails), receipts: new Set(keys.receipts),
    websiteInns: new Map([...keys.websiteInns].map(([key, values]) => [key, new Set(values)])),
    ...(keys.seen ? { seen: keys.seen } : {}), ...(keys.otherBases ? { otherBases: keys.otherBases } : {}) };
}

/** Исключённую строку занимает другая база проекта, а не прошлый раунд этой же базы. */
function excludedByOtherBases(keys: VeBaseExclusionKeys, row: VeUnifiedRow): boolean {
  return !keys.otherBases || pruneBaseRowAgainstExclusion(keys.otherBases, row) === null;
}

/** Совпадение юрлица исключает строку целиком, независимо от её контактов. */
function baseRowMatchesCompanyExclusion(
  keys: VeBaseExclusionKeys,
  row: Pick<VeUnifiedRow, 'company' | 'inn' | 'email'> & Partial<Pick<VeUnifiedRow, 'website'>>,
): boolean {
  const innKey = normalizeVeCompanyInn(row.inn);
  if (innKey && keys.inns.has(innKey)) return true;
  const websiteKey = veCompanyWebsiteKey(row);
  const knownInns = websiteKey ? keys.websiteInns.get(websiteKey) : undefined;
  if (!knownInns) return false;
  // A known conflicting legal entity overrides a shared name/domain. If the
  // domain is ambiguous and this row has no INN, retain it for actual checking.
  const identifiedInns = [...knownInns].filter(Boolean);
  if (innKey) return identifiedInns.length === 0;
  return identifiedInns.length <= 1;
}

/**
 * Удалить из multi-email строки уже занятые контакты. Подтверждённое совпадение
 * юрлица исключает всю строку; совпадение одного email — только этот email.
 * null означает, что после безопасного исключения строка целиком занята.
 */
export function pruneBaseRowAgainstExclusion(
  keys: VeBaseExclusionKeys,
  row: VeUnifiedRow,
): VeUnifiedRow | null {
  if (keys.receipts?.has(veAcquisitionReceipt(row))) return null;
  if (baseRowMatchesCompanyExclusion(keys, row)) return null;
  const emails = extractEmails(row.email);
  const freshEmails = emails.filter((email) => !keys.emails.has(email));
  if (emails.length > 0 && freshEmails.length === 0) return null;
  // Эта база уже отправляла компанию, а после вычёркивания занятых адресов
  // строка не несёт ни нового адреса, ни нового сайта.
  if (keys.seen && veSeenCompanyCovers(keys.seen, row, freshEmails)) return null;
  if (freshEmails.length === emails.length) return row;
  const pruned = { ...row, email: freshEmails.join(', ') };
  // Отметка прошлого раунда записана на уже урезанную строку.
  return keys.receipts?.has(veAcquisitionReceipt(pruned)) ? null : pruned;
}

/** Строка исключена целиком: занято юрлицо или все найденные email. */
export function baseRowMatchesExclusion(
  keys: VeBaseExclusionKeys,
  row: Pick<VeUnifiedRow, 'company' | 'inn' | 'email'> & Partial<Pick<VeUnifiedRow, 'website'>>,
): boolean {
  if (keys.receipts?.has(veAcquisitionReceipt(row))) return true;
  if (baseRowMatchesCompanyExclusion(keys, row)) return true;
  const emails = extractEmails(row.email);
  const freshEmails = emails.filter((email) => !keys.emails.has(email));
  if (emails.length > 0 && freshEmails.length === 0) return true;
  if (keys.seen && veSeenCompanyCovers(keys.seen, row, freshEmails)) return true;
  return freshEmails.length < emails.length && !!keys.receipts?.has(veAcquisitionReceipt({ ...row, email: freshEmails.join(', ') }));
}

function normalizedUploadColumn(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[_.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isEmailUploadColumn(column: string): boolean {
  return /^(?:e ?mail|mail|почта|электронная почта|эл почта|емейл)(?: адрес)?(?: \d+)?$/.test(
    normalizedUploadColumn(column),
  );
}

function uploadField(
  row: Record<string, unknown>,
  aliases: ReadonlySet<string>,
): unknown {
  let fallback: unknown;
  for (const [column, value] of Object.entries(row)) {
    if (!aliases.has(normalizedUploadColumn(column))) continue;
    if (fallback === undefined) fallback = value;
    if (cell(value) !== '') return value;
  }
  return fallback;
}

const COMPANY_UPLOAD_COLUMNS = new Set([
  'company',
  'company name',
  'компания',
  'название компании',
  'наименование',
  'организация',
]);
const INN_UPLOAD_COLUMNS = new Set(['inn', 'инн', 'tin', 'tax id']);
const WEBSITE_UPLOAD_COLUMNS = new Set(['website', 'website url', 'site', 'site url', 'url', 'domain', 'сайт', 'сайт компании', 'домен']);

function addRowsToExclusionKeys(keys: VeBaseExclusionKeys, rows: unknown[]): VeBaseExclusionKeys {
  for (const item of rows) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const emailValues = Object.entries(rec)
      .filter(([column]) => isEmailUploadColumn(column))
      .map(([, value]) => String(value ?? ''));
    for (const email of extractEmails(emailValues.join(', '))) {
      keys.emails.add(email);
    }
    const innValue = uploadField(rec, INN_UPLOAD_COLUMNS);
    const innKey = normalizeVeCompanyInn(innValue);
    if (innKey) keys.inns.add(innKey);
    const company = uploadField(rec, COMPANY_UPLOAD_COLUMNS);
    const website = uploadField(rec, WEBSITE_UPLOAD_COLUMNS);
    const websiteKey = veCompanyWebsiteKey({ company, website });
    if (!websiteKey) continue;
    let bucket = keys.websiteInns.get(websiteKey);
    if (!bucket) {
      bucket = new Set<string>();
      keys.websiteInns.set(websiteKey, bucket);
    }
    bucket.add(innKey);
  }
  return keys;
}

export function buildBaseExclusionKeysFromRows(rows: unknown[]): VeBaseExclusionKeys {
  return addRowsToExclusionKeys(
    { websiteInns: new Map<string, Set<string>>(), inns: new Set<string>(), emails: new Set<string>() },
    rows,
  );
}

/** seen_rows только заменяется целиком, поэтому индекс одного checkpoint'а строится
 * один раз за тик, а не на каждую сверку (17,8 тыс. отметок у b5934955). */
const seenCompaniesByCheckpoint = new WeakMap<object, VeSeenCompanies>();

function addAcquisitionReceipts(keys: VeBaseExclusionKeys, rows: Array<Partial<VeUnifiedRow>>, source: VeUnifiedRow[] = []): VeBaseExclusionKeys {
  keys.receipts = new Set(rows.map(veAcquisitionReceipt));
  let seen = seenCompaniesByCheckpoint.get(rows);
  if (!seen) seenCompaniesByCheckpoint.set(rows, seen = buildVeSeenCompanies(rows));
  keys.seen = seen;
  const legacyMatches = new Map<string, VeUnifiedRow[]>();
  for (const row of source) {
    const legacy = veAcquisitionReceipt({ company: row.company, website: row.website, inn: row.inn, email: row.email });
    legacyMatches.set(legacy, [...(legacyMatches.get(legacy) ?? []), row]);
  }
  for (const row of rows) {
    // Old checkpoints omitted geography. Only bridge an unambiguous source
    // observation; same-name businesses in different cities stay distinct.
    const matching = legacyMatches.get(veAcquisitionReceipt(row));
    if (matching?.length === 1) {
      keys.receipts.add(veAcquisitionReceipt(matching[0]));
      const normalized = applyVeSourceContacts(matching)[0];
      if (normalized.email === matching[0].email) keys.receipts.add(veAcquisitionReceipt(normalized));
    }
  }
  return keys;
}

/**
 * Ключи компаний из ДРУГИХ ve_bases того же проекта (любой
 * source, любой статус кроме failed; текущая база исключена). Без этого одна
 * и та же компания копилась в нескольких базах проекта через повторные
 * сборки. Компания — из колонки 'company', ИНН — из 'inn'. data jsonb чужой базы и так читается целиком (одно поле
 * строки), поэтому slice до MAX_ROWS_LIMIT — лишь JS-предохранитель; он
 * обязан быть не меньше максимального размера базы: кап 10k при лимите
 * сборки до 50k отрезал хвост чужой базы из исключений, и вторая сборка
 * собирала компании 10001–50000 первой заново как «новые».
 */
async function loadOtherBaseExclusionKeys(
  ctx: VeStageContext,
  projectId: string,
  baseId: string,
  checkpointHypothesisId?: string | null,
): Promise<VeBaseExclusionKeys> {
  const { data, error } = await ctx.supabase
    .from('ve_bases')
    .select(checkpointHypothesisId
      ? 'data, columns, source, hypothesis_id, target_checkpoint:collect_info->target_checkpoint'
      : 'data')
    .eq('project_id', projectId)
    .neq('status', 'failed')
    .neq('id', baseId);
  if (error) throw new Error(`ve_bases exclusion read: ${error.message}`);

  const keys: VeBaseExclusionKeys = {
    websiteInns: new Map<string, Set<string>>(),
    inns: new Set<string>(),
    emails: new Set<string>(),
  };
  for (const row of (data ?? []) as Array<{
    data?: unknown; columns?: string[]; source?: string; hypothesis_id?: string; target_checkpoint?: VeCollectInfo['target_checkpoint'];
    collect_info?: VeCollectInfo;
  }>) {
    const storedRows = Array.isArray(row.data) ? row.data : [];
    // Legacy auto bases kept raw/rejected candidates in data. Those candidates
    // must not reserve a company against another, potentially correct hypothesis.
    const reservedRows = checkpointHypothesisId && row.source === 'auto'
      ? prepareSegmentationAudience({ rows: storedRows, columns: row.columns ?? [], source: 'auto' }).rows
      : storedRows;
    addRowsToExclusionKeys(keys, reservedRows);
    if (checkpointHypothesisId && row.hypothesis_id === checkpointHypothesisId) {
      const checkpoint = row.target_checkpoint ?? row.collect_info?.target_checkpoint;
      addRowsToExclusionKeys(keys, Array.isArray(checkpoint?.seen_rows) ? checkpoint.seen_rows : []);
    }
  }
  return keys;
}

function baseCreatedAtMs(base: Pick<VeAutoBase, 'created_at'>): number {
  const ms = new Date(base.created_at).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function isOlderCollectingBase(current: Pick<VeAutoBase, 'id' | 'created_at'>, candidate: Pick<VeAutoBase, 'id' | 'created_at'>): boolean {
  const currentMs = baseCreatedAtMs(current);
  const candidateMs = baseCreatedAtMs(candidate);
  if (candidateMs !== currentMs) return candidateMs < currentMs;
  return candidate.id < current.id;
}

/** Короткое окно между INSERT базы и INSERT её worker-job. */
const COLLECTING_JOB_GRACE_MS = 5 * 60 * 1000;

async function findOlderCollectingBase(
  ctx: VeStageContext,
  projectId: string,
  base: Pick<VeAutoBase, 'id' | 'created_at' | 'hypothesis_id'>,
  resumingHeldSupply = false,
): Promise<string | null> {
  const { data, error } = await ctx.supabase
    .from('ve_bases')
    .select('id, created_at, hypothesis_id, supply_hold:collect_info->supply_hold')
    .eq('project_id', projectId)
    .eq('source', 'auto')
    .eq('status', 'collecting')
    .neq('id', base.id);
  if (error) throw new Error(`ve_bases collecting read: ${error.message}`);
  const older = ((data ?? []) as Array<Pick<VeAutoBase, 'id' | 'created_at'> & {
    supply_hold?: boolean; collect_info?: VeCollectInfo; hypothesis_id?: string | null;
  }>)
    .filter((candidate) => candidate.supply_hold !== true && candidate.collect_info?.supply_hold !== true)
    // Distinct hypotheses may acquire/validate in parallel. The single project
    // owner still serializes publication and rechecks cross-base exclusions.
    // Unknown legacy scope and same-hypothesis continuation remain serialized.
    .filter((candidate) => !base.hypothesis_id || !candidate.hypothesis_id || candidate.hypothesis_id === base.hypothesis_id)
    .filter((candidate) => resumingHeldSupply || isOlderCollectingBase(base, candidate))
    .sort((a, b) => baseCreatedAtMs(a) - baseCreatedAtMs(b) || a.id.localeCompare(b.id));
  if (older.length === 0) return null;

  const { data: activeJobs, error: jobsError } = await ctx.supabase
    .from('ve_jobs')
    .select('payload')
    .eq('project_id', projectId)
    .eq('stage', 'base_collect')
    .in('status', ['pending', 'running']);
  if (jobsError) throw new Error(`ve_jobs collecting read: ${jobsError.message}`);
  const activeBaseIds = new Set(
    (activeJobs ?? [])
      .map((job) => (job as { payload?: { base_id?: unknown } }).payload?.base_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  const now = Date.now();
  const blocking = older.find((candidate) => {
    if (activeBaseIds.has(candidate.id)) return true;
    const createdAt = baseCreatedAtMs(candidate);
    return createdAt > 0 && now - createdAt < COLLECTING_JOB_GRACE_MS;
  });
  return blocking?.id ?? null;
}

/* ─────────────────────────── Фаза CONSTRUCT ─────────────────────────── */

/**
 * Шаги конструктора для авто-базы VE2: поиск на сайтах каждой компании
 * → описания по одной строке компании → разнос адресов по строкам → дедуп
 * почт → ВАЛИДАЦИЯ. Все найденные адреса сохраняются, без лимита на компанию. AI-шагов
 * (ta_scoring/personalization) нет — генерация и скоринг остаются в Движке.
 *
 * validate_emails — ВСЕГДА: раньше конструктор запускался только при бедных
 * почтах, и базы реестра/карт (email уже есть, но это протухшие info@ из
 * ЕГРЮЛ-источников) уходили в рассылку без валидации — баунсы ложились на
 * домен клиента. Исходные адреса — запасной вариант, если сайт не дал адресов.
 */
const CONSTRUCT_STEPS_AFTER_SPLIT = [
  'split_emails',
  'dedup_email',
  'validate_emails',
];

/** Свыше этого размера enrich_descriptions (per-site фетчи) не укладывается в
 *  6-часовой таймаут конструктора — для больших баз шаг пропускаем. */
const CONSTRUCT_ENRICH_MAX_ROWS = 5000;

function constructStepsFor(merged: VeUnifiedRow[]): string[] {
  const enrich = merged.length <= CONSTRUCT_ENRICH_MAX_ROWS ? ['enrich_descriptions'] : [];
  // enrich_descriptions зависит только от компании/сайта. Выполняем его до
  // split_emails: иначе несколько адресов одной компании породят несколько
  // одинаковых HTTP-запросов и способны выбить 6-часовой таймаут.
  return ['find_emails', ...enrich, ...CONSTRUCT_STEPS_AFTER_SPLIT];
}
/** Канонические заголовки сетки конструктора (порядок — как VE_AUTO_COLLECT_COLUMNS). */
const CONSTRUCT_HEADERS_RU = ['Компания', 'Сайт', 'Email', 'Телефон', 'Вакансия', 'Адрес', 'Категория', 'Сотрудники', 'Выручка', 'ИНН', 'Источник'];
const CONSTRUCT_HEADERS_EN = ['Company', 'Site', 'Email', 'Phone', 'Vacancy', 'Address', 'Category', 'Employees', 'Revenue', 'INN', 'Source'];
/** Сколько ждём BC-джобу, прежде чем считать её зависшей (база → failed). */
const CONSTRUCT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/** Пауза между тиками ожидания BC-джобы (run_after). */
const CONSTRUCT_REQUEUE_MS = 60_000;
/** Дефолт requeueVeJob, выписанный явно: паузу раунда теперь считает helper. */
const VE_ROUND_REQUEUE_MS = 30_000;

/** Заголовок сетки конструктора (lowercase) → унифицированная колонка / description. */
const CONSTRUCT_HEADER_MAP: Record<string, keyof VeUnifiedRow | 'description'> = {
  company: 'company',
  'компания': 'company',
  site: 'website',
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
 * Конструктор нужен всегда (см. constructStepsFor): валидация почт обязательна
 * для любых источников; поиск почт — только для бедных баз.
 */
function needsConstruct(merged: VeUnifiedRow[]): boolean {
  return merged.length > 0;
}

/** merged-строки → сетка string[][] конструктора (заголовок по локали рынка). */
function buildConstructGrid(rows: VeUnifiedRow[], market: VeMarket): string[][] {
  const headers = market === 'us' ? CONSTRUCT_HEADERS_EN : CONSTRUCT_HEADERS_RU;
  const descriptions = rows.map((row) => cell((row as Record<string, unknown>).description));
  const hasDescription = descriptions.some(Boolean);
  return [
    [...headers, ...(hasDescription ? [market === 'us' ? 'Description' : 'Описание'] : [])],
    ...rows.map((r, index) => [
      r.company, r.website, r.email, r.phone, r.vacancy_title, r.address,
      r.category, r.employees, r.revenue, r.inn, r.source_detail,
      ...(hasDescription ? [descriptions[index]] : []),
    ]),
  ];
}

/** Неизвестные/некорректные числа прогресса не превращаем в ложный ноль. */
function constructProgressNumber(value: unknown, min: number, max = Infinity): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

/** Плоские числовые снимки: порядок jsonb-ключей не означает изменение. */
function sameCollectSnapshot(previous: object | undefined, next: object): boolean {
  if (!previous) return false;
  const values = previous as Record<string, unknown>;
  const entries = Object.entries(next);
  return Object.keys(previous).length === entries.length
    && entries.every(([key, value]) => values[key] === value);
}

/** Статус BC-джобы (null — строка потерялась: трактуем как failed без данных). */
async function readConstructJobStatus(
  ctx: VeStageContext,
  bcJobId: string,
): Promise<{
  status: string;
  error_message: string | null;
  selected_steps: string[] | null;
  progress: NonNullable<VeConstructInfo['progress']>;
} | null> {
  const { data, error } = await ctx.supabase
    .from('base_constructor_jobs')
    .select('status, error_message, selected_steps, current_step, total_steps, current_step_key, current_step_progress, workload_origin')
    .eq('id', bcJobId)
    .maybeSingle();
  if (error) throw new Error(`base_constructor_jobs read: ${error.message}`);
  if (!data) return null;
  if (data.workload_origin !== 'automation') await markAutomatedConstructor(ctx.supabase, bcJobId);
  const row = data as Record<string, unknown>;
  const totalSteps = constructProgressNumber(row.total_steps, 1);
  return {
    status: String(row.status ?? ''),
    error_message: typeof row.error_message === 'string' ? row.error_message : null,
    selected_steps: Array.isArray(row.selected_steps)
      ? row.selected_steps.filter((step): step is string => typeof step === 'string')
      : null,
    progress: {
      status: String(row.status ?? ''),
      current_step: constructProgressNumber(row.current_step, 1, totalSteps ?? Infinity),
      total_steps: totalSteps,
      current_step_key: typeof row.current_step_key === 'string' && row.current_step_key.trim()
        ? row.current_step_key.trim()
        : null,
      current_step_progress: constructProgressNumber(row.current_step_progress, 0, 100),
    },
  };
}

async function dispatchConstructJob(input: {
  ctx: VeStageContext;
  ownerId: string | null | undefined;
  projectName: string;
  baseLabel: string;
  rows: VeUnifiedRow[];
  market: VeMarket;
  reservedId?: string;
}): Promise<{ bcJobId: string; locale: 'ru' | 'en'; construct: VeConstructInfo }> {
  const { ctx, ownerId, projectName, baseLabel, rows, market, reservedId } = input;
  if (!ownerId) {
    throw new Error('ve_projects.created_by пуст — джобе конструктора некому принадлежать');
  }
  const locale = market === 'us' ? 'en' : 'ru';
  const steps = constructStepsFor(rows);
  const record = {
    ...(reservedId ? { id: reservedId } : {}),
    user_id: ownerId,
    workload_origin: 'automation',
    // Общий список конструктора: сначала клиентский проект, затем сегмент.
    file_name: ['VE2', projectName?.trim(), baseLabel.replace(/^auto:\s*/, '')].filter(Boolean).join(' · '),
    status: 'pending',
    locale,
    selected_steps: steps,
    step_config: {
      ...(reservedId ? { queue_class: 'interactive_preview' } : {}),
      find_emails_target: 'separate',
      // Краул сайта — главный расход времени на компанию (см. комментарий у
      // stopAtFirstUsableEmail в processingSteps.ts). Раньше здесь стояло
      // «все адреса с 12 страниц»: каждый найденный адрес потом проходил
      // SMTP-проверку, а лимит адресов на компанию выбрасывал лишние уже
      // после неё — у одной компании доходило до 167 проверенных адресов.
      // Берём небольшой запас сверх лимита: его хватает, чтобы отбор
      // предпочёл подтверждённый адрес catch-all, и не больше.
      find_emails: {
        stop_at_first: false, max_per_site: 6, max_pages: 4, site_timeout_ms: 30_000, merge_mode: 'prefer_found_validated',
        // Описание берём из главной страницы, которую find_emails и так уже
        // скачал. Без этого enrich_descriptions идёт на тот же сайт второй
        // раз — и втрое меньшей параллельностью, чем поиск почт. Замер: у 75%
        // строк с сайтом описание набирается прямо с главной, то есть три из
        // четырёх повторных закачек лишние. Флаг включаем только когда шаг
        // enrich_descriptions реально стоит в списке: у баз свыше 5000 строк
        // его нет, и колонка описания там появляться не должна.
        ...(reservedId || steps.includes('enrich_descriptions') ? { reuse_website_description: true } : {}),
      },
    },
    data: buildConstructGrid(rows, market),
    initial_row_count: rows.length,
    total_steps: steps.length,
  };
  let bcJobId: string;
  if (reservedId) {
    // A timeout after INSERT is ambiguous. Repeating this exact ID must never
    // reset a claimed/completed job or buy the same website scans again.
    const { error } = await ctx.supabase.from('base_constructor_jobs')
      .upsert(record, { onConflict: 'id', ignoreDuplicates: true });
    if (error) throw new Error(`preview constructor insert: ${error.message}`);
    bcJobId = reservedId;
  } else {
    bcJobId = await insertChildJob(ctx, 'base_constructor_jobs', record);
  }
  return {
    bcJobId,
    locale,
    construct: {
      bc_job_id: bcJobId,
      status: 'dispatched',
      dispatched_at: new Date().toISOString(),
      progress: {
        status: 'pending', current_step: null, total_steps: steps.length,
        current_step_key: null, current_step_progress: null,
      },
    },
  };
}

function taggedHarvest(task: VeCollectTaskState): VeUnifiedRow[] {
  return (task.harvest ?? []).map((row) => ({ ...row, _ve_source_strategy: veSourceStrategyKey(task.task) }));
}
const candidateSourceKey = (row: VeUnifiedRow) => (row as VeUnifiedRow & { _ve_source_strategy?: string })._ve_source_strategy;

async function prepareAdaptiveCandidates(ctx: VeStageContext, base: VeAutoBase, info: VeCollectInfo, available: VeUnifiedRow[]): Promise<VeUnifiedRow[]> {
  if (!available.length || info.adaptive_collection?.pending) return info.adaptive_collection?.pending ? [] : available;
  let candidates = available;
  const policy = info.adaptive_collection;
  if (policy) {
    const keys = [...new Set(available.map(candidateSourceKey).filter((key): key is string => !!key))];
    const selected = chooseVeAdaptiveSource(policy, keys);
    if (selected) {
      if (policy.active_source && policy.active_source !== selected) {
        policy.switches += 1;
        policy.note = 'Для следующей партии выбран другой источник. Прежние кандидаты сохранены.';
      }
      policy.active_source = selected;
      candidates = available.filter((row) => candidateSourceKey(row) === selected);
    } else if (keys.length) {
      // Все источники этих строк сухие: партию из них не берём, раунд выйдет
      // пустым, и правило сухих источников завершит базу с причиной.
      return [];
    }
  }
  const hints = await readVeCandidateHints(candidates, ctx.supabase, ctx.signal);
  const focus = info.hypotheses?.map((hypothesis) => hypothesis.title).join(' ') ?? '';
  return prioritizeVeCandidates(candidates, hints, focus);
}
export function beginAdaptiveBatch(base: VeAutoBase, info: VeCollectInfo, id: string, rows: VeUnifiedRow[]): void {
  const policy = info.adaptive_collection;
  if (!policy || policy.pending || !rows.length) return;
  const sourceKey = candidateSourceKey(rows[0]) ?? policy.active_source ?? 'saved';
  const source = info.tasks?.find((task) => veSourceStrategyKey(task.task) === sourceKey)?.source ?? 'saved';
  // The batch is measured before the per-company limit, so the baseline must be
  // too: addresses already held back in the reserve are not new. Without them
  // every batch "found" all old over-limit addresses again (6b475d8c: 16 of 16,
  // f1bb9ccf: 5 of 5) and a dry source never looked poor.
  const overCap = readVeRelevanceReserve(info.relevance_reserve).filter((row) => Boolean(row[VE_COMPANY_CAP_FIELD]));
  policy.pending = { id, source_key: sourceKey, source, candidates: rows.length,
    ready_before: veReadyContactKeys([...prepareSegmentationAudience({ rows: Array.isArray(base.data) ? base.data : [],
      columns: base.columns ?? [], source: 'auto' }).rows, ...overCap]),
    started_at: policy.last_completed_at ?? policy.started_at };
}

/** Пороги размера компании ставит только планировщик-LLM: в интерфейсе движка
 *  их задать нельзя. Поэтому ограничением специалиста они не являются и не
 *  должны ни блокировать переход на другой источник, ни переживать смену
 *  запроса. Замер по нефтехимии: «выручка от 100 млн + штат от 50» оставил 199
 *  компаний из 2 863 по тому же ОКВЭД, задача встала с пометкой «реестр
 *  исчерпан», а 27 тысяч организаций той же отрасли в Яндекс.Картах остались
 *  недоступны — именно эти пороги считались ограничением, запрещающим карты. */
const SIZE_FILTER_KEYS = [...VE_SIZE_FILTER_KEYS, 'sizeOrUnknown'] as const;

/** Keep user/plan restrictions when trying a different query. Cross-source
 * fallback is allowed only when the original source has no numeric/geo scope
 * which the new source cannot enforce. Final hypothesis checks stay unchanged. */
export function safeAlternativeTask(candidate: VeCollectTask, original: VeCollectTask): VeCollectTask | null {
  if (!['companies_directory', 'yandex_maps', 'pdl', 'funded', 'eng_hiring'].includes(candidate.source)) return null;
  if (candidate.source !== original.source) {
    const restricted = original.directory_filters && Object.entries(original.directory_filters)
      // includeIp тоже ставит планировщик, а не специалист: отсутствие ключа и
      // includeIp:false — один и тот же срез реестра (см. нормализацию в
      // mapDirectoryFilters и veSourceStrategyKey). Он ничего не сужает, зато
      // стоял у 326 задач из 331 и в одиночку запрещал уход на карты.
      .some(([key, value]) => !['okvedCodes', 'hasEmail', 'includeIp', ...SIZE_FILTER_KEYS].includes(key) && value !== undefined)
      || original.maps_query?.geo || original.pdl_filters?.countries?.length || original.pdl_filters?.sizes?.length
      || original.funded_filters || original.eng_hiring_query
      // Запрос вакансий — сигнал найма, а не граница рынка: по всей России
      // (area 113 или пусто) он ничего не сужает. 9f82e79d стояла на 5
      // контактах, потому что любая замена hh_live считалась нарушением.
      || (original.hh_query?.area && !['113', ''].includes(original.hh_query.area.trim()));
    if (restricted) return null;
  }
  if (candidate.source === 'companies_directory' && original.source === candidate.source) return {
    ...candidate, directory_filters: { ...candidate.directory_filters, ...original.directory_filters,
      okvedCodes: candidate.directory_filters?.okvedCodes ?? original.directory_filters?.okvedCodes,
      // Пороги размера берём у КАНДИДАТА, а не у исходной задачи: иначе
      // самовыдуманный планировщиком порог невозможно ослабить ни одной
      // альтернативой — перетирался бы обратно на каждой попытке.
      ...Object.fromEntries(SIZE_FILTER_KEYS.map((key) => [key, candidate.directory_filters?.[key]])),
    },
  };
  if (candidate.source === 'yandex_maps' && original.maps_query && candidate.maps_query) return {
    ...candidate, maps_query: { ...candidate.maps_query, geo: original.maps_query.geo },
  };
  if (candidate.source === 'pdl' && original.pdl_filters) return { ...candidate, pdl_filters: {
    ...candidate.pdl_filters, countries: original.pdl_filters.countries, sizes: original.pdl_filters.sizes,
  } };
  if (candidate.source === 'funded' && original.funded_filters) return { ...candidate, funded_filters: {
    ...candidate.funded_filters, countries: original.funded_filters.countries,
    min_funding_usd: original.funded_filters.min_funding_usd, funded_since: original.funded_filters.funded_since,
  } };
  if (candidate.source === 'eng_hiring' && original.eng_hiring_query) return { ...candidate, eng_hiring_query: original.eng_hiring_query };
  return candidate;
}

async function adaptCollectionSources(ctx: VeStageContext, job: VeJob, base: VeAutoBase, info: VeCollectInfo,
  vertical: VeVertical, market: VeMarket, usage: VeUsage): Promise<void> {
  const policy = info.adaptive_collection;
  const target = info.target_progress;
  if (!policy || policy.pending || info.preview_pipeline?.batches.length || !target || target.ready_rows >= target.ready_target) return;
  const tasks = info.tasks ?? [];
  const consumed = buildBaseExclusionKeysFromRows(info.target_checkpoint?.seen_rows ?? []);
  const available = tasks.filter((task) => task.status !== 'failed' && (task.status !== 'done'
    || isVeRenewableSourceTask(task)
    || (task.harvest ?? []).some((row) => (info.search_policy?.phase !== 'existing' || hasExistingSourceContact(row))
      && !baseRowMatchesExclusion(consumed, row))));
  const alternatives = available.filter((task) => veSourceStrategyKey(task.task) !== policy.active_source
    && !veAdaptiveLowYield(policy.completed, veSourceStrategyKey(task.task))
    && !veAdaptiveSourceDry(policy.completed, veSourceStrategyKey(task.task)));
  const planExhausted = policy.replan_reason === 'plan_exhausted';
  if (policy.replan_needed && !planExhausted && alternatives.length) {
    policy.active_source = chooseVeAdaptiveSource(policy, alternatives.map((task) => veSourceStrategyKey(task.task)));
    policy.replan_needed = false; delete policy.replan_reason; policy.switches += 1;
    policy.note = 'Низкий выход: автоматически переключились на другой источник из плана.';
    await persistCollectInfo(ctx, base.id, info);
    return;
  }
  if (policy.replan_needed && policy.replan_attempts < 2 && tasks.length < VE_PLAN_MAX_TASKS) {
    const original = tasks.find((task) => veSourceStrategyKey(task.task) === policy.active_source) ?? tasks[0];
    if (!original) return;
    policy.replan_attempts += 1;
    // Save before paying: a retry/redeploy cannot reset the replan allowance.
    await persistCollectInfo(ctx, base.id, info);
    try {
      // Прежний план показываем без порогов размера: иначе модель повторяет
      // их как «ограничение гипотезы», хотя их придумал планировщик.
      const previous = JSON.stringify(tasks.map((task) => veTaskWithoutSizeFilters(task.task)));
      const rules = 'Не меняй целевую аудиторию, обязательные признаки и географию гипотезы. Пороги выручки и штата ставь, только если размер компании прямо назван в тексте гипотезы. Не повторяй прежние задачи. Живые парсеры не добавляй.';
      const feedback = planExhausted
        ? `Источники плана исчерпаны, а цель базы не набрана. Предложи ДРУГОЙ срез того же рынка: соседние или более общие коды ОКВЭД, готовый каталог Яндекс Карт или другой запрос. ${rules} Предыдущий план (без порогов размера): ${previous}`
        : `Предыдущие партии дали низкий выход. Предложи ДРУГОЙ источник из готовых каталогов или другой запрос/срез. ${rules} Предыдущий план (без порогов размера): ${previous}. Результаты последних партий (расходы оценочные): ${JSON.stringify(policy.completed.slice(-6))}`;
      const replacement = await buildPlan(job, ctx, vertical, usage, market, base.hypothesis_id ?? null, feedback);
      if (replacement.sliceProbe?.outcome === 'rejected') throw new Error('alternative_slice_rejected');
      const known = new Set(tasks.map((task) => veSourceStrategyKey(task.task)));
      const next = replacement.plan.tasks.map((task) => safeAlternativeTask(task, original.task))
        .find((task): task is VeCollectTask => !!task && !known.has(veSourceStrategyKey(task)));
      if (next) {
        const task: VeCollectTask = planExhausted ? { ...next, widened: 'replan' } : next;
        tasks.push({ source: task.source, task, status: 'pending', child_job_id: null, rows: 0 });
        info.tasks = tasks;
        info.plan = { tasks: tasks.map((task) => task.task) };
        policy.active_source = veSourceStrategyKey(next); policy.switches += 1; policy.replan_needed = false;
        delete policy.replan_reason;
        policy.note = planExhausted
          ? 'План исчерпан раньше цели: подобран новый срез с сохранением условий гипотезы. Проверяем пробную партию.'
          : 'Подобран новый поисковый срез с сохранением условий гипотезы. Проверяем пробную партию.';
        delete policy.replan_error;
        // A changed population is not the original estimate's denominator.
        if (info.estimate) info.estimate = { ...info.estimate, remaining_ready_estimate: null,
          estimate_reason: 'После смены источника объём будет уточнён по новым проверенным партиям.' };
      } else {
        policy.replan_needed = false; delete policy.replan_reason;
        policy.replan_error = 'Подходящий новый срез не найден; сохранён прежний план.';
      }
    } catch (error) {
      ctx.signal?.throwIfAborted();
      if (error instanceof VeRelevanceCheckpointError || error instanceof ProviderUsageWriteError
        || error instanceof VeLlmRateLimitError
        || isVeProviderBillingError(error) || isVeProviderConfigurationError(error)
        || (error instanceof Error && error.name === 'VeWorkerShutdownError')) throw error;
      policy.replan_needed = false; delete policy.replan_reason;
      policy.replan_error = 'Не удалось подготовить альтернативный срез; оплаченные результаты сохранены.';
    }
    await persistCollectInfo(ctx, base.id, info);
    if (!policy.replan_error) return;
  }
  const activeDry = !!policy.active_source && !!veAdaptiveSourceDry(policy.completed, policy.active_source);
  if (!policy.active_source || activeDry || !available.some((task) => veSourceStrategyKey(task.task) === policy.active_source)) {
    const chosen = chooseVeAdaptiveSource(policy, available.map((task) => veSourceStrategyKey(task.task)));
    // Сухие все: прежний источник остаётся активным, чтобы не открыть разом
    // все задачи плана. Партии из него не будет (prepareAdaptiveCandidates).
    if (activeDry && !chosen) return;
    if (activeDry) {
      policy.switches += 1;
      policy.note = 'Источник перестал давать контакты: следующая партия — из другого источника плана.';
    }
    policy.active_source = chosen;
    await persistCollectInfo(ctx, base.id, info);
  }
}

/**
 * Ниже этого числа контактов базу не имеет смысла продолжать.
 *
 * Порог АБСОЛЮТНЫЙ, а не доля цели. Раньше стояло 0,6 от цели, то есть 300 при
 * цели 500 — и правило срезало бы базы, которые студия считает нормальными:
 * узкая гипотеза на 200-300 контактов это маленькая, но полезная база, а не
 * брак. При доле порог ещё и ехал бы за целью: подняли бы цель до 1000 — и
 * правило начало бы останавливать базы на 500.
 *
 * Сто выбрано по распределению 71 завершённой базы (замер 22.09.2026):
 *
 *   500 и выше   11 баз   6 030 контактов
 *   300-499      12 баз   5 003
 *   200-299      13 баз   3 267
 *   100-199      10 баз   1 414
 *   50-99         5 баз     402
 *   10-49         8 баз     250
 *   меньше 10    12 баз      36
 *
 * Нижние три полосы — треть парка и 4,2% результата: 25 баз дали 688 контактов
 * из 16 402, а двенадцать самых нижних — по три контакта каждая. Всё, что от
 * ста и выше, правило не трогает.
 */
const VE_NARROW_MARKET_MIN_PROJECTED = 100;
/** Меньше этого числа проверенных компаний наблюдаемый выход ещё не показателен. */
const VE_NARROW_MARKET_MIN_COMPANIES = 300;
const PREVIEW_BATCH_SIZE = 200;
const PREVIEW_IN_FLIGHT = 2;
const PREVIEW_MAX_BATCHES = VE_COLLECTION_ROUND_BUDGET;

/** One parent writer, at most two independently resumable constructor jobs. */
async function preparePreviewBatches(args: {
  ctx: VeStageContext; base: VeAutoBase; info: VeCollectInfo; project: VeProject;
  target: VeCollectionTargetProgress; available: VeUnifiedRow[]; market: VeMarket;
  /** Keep the current validation/review phase in charge of round accounting. */
  reserveOnly?: boolean;
}): Promise<VeUnifiedRow[]> {
  const { ctx, base, info, project, target, available, market } = args;
  const pipeline = info.preview_pipeline!;
  if (pipeline.version !== 1 || !Array.isArray(pipeline.batches) || pipeline.batches.length > PREVIEW_IN_FLIGHT
    || new Set(pipeline.batches.map((batch) => batch.id)).size !== pipeline.batches.length
    || pipeline.batches.some((batch) => !batch.id || !Array.isArray(batch.rows) || batch.rows.length > PREVIEW_BATCH_SIZE)) {
    throw new Error('Invalid preview batch checkpoint');
  }
  const reserved = buildBaseExclusionKeysFromRows(pipeline.batches.flatMap((batch) => batch.rows));
  const unreserved = available.filter((row) => !baseRowMatchesExclusion(reserved, row));
  const candidates = await prepareAdaptiveCandidates(ctx, base, info, unreserved);
  let allocated = pipeline.batches.reduce((sum, batch) => sum + batch.rows.length, 0);
  // Stop acquisition immediately at the ready goal/error, but drain already
  // purchased batches through the same gates and retain their checked results.
  if (!pipeline.error && target.ready_rows < target.ready_target && !info.tasks?.some((task) => task.status === 'failed')) {
    // Адаптивный сбор держит ровно одну партию в полёте намеренно: решение
    // «источник плохой, переключаемся» принимается по итогу каждой партии, и
    // вторая в полёте стартовала бы из среза, который первая только что
    // признала бесполезным. Скорость добираем размером партии, а не их числом.
    while (pipeline.batches.length < Math.min(info.adaptive_collection ? 1 : PREVIEW_IN_FLIGHT, target.max_rounds - target.round + 1) && candidates.length > 0) {
      const batchSize = info.adaptive_collection ? veAdaptiveCandidateLimit(target, allocated)
        : target.candidates_processed === 0 && allocated === 0 ? VE_PREVIEW_FIRST_CANDIDATES : PREVIEW_BATCH_SIZE;
      const size = info.adaptive_collection ? batchSize
        : Math.min(batchSize, collectionRoundLimit(target), target.max_candidates - target.candidates_processed - allocated);
      if (size <= 0) break;
      const rows = candidates.splice(0, size);
      const id = randomUUID();
      beginAdaptiveBatch(base, info, id, rows);
      pipeline.batches.push({ id, rows, dispatched_at: new Date().toISOString() });
      allocated += rows.length;
    }
  }
  pipeline.job_ids = [...new Set([...(pipeline.job_ids ?? []), ...pipeline.batches.map((batch) => batch.id)])];
  if (!pipeline.started_at) pipeline.started_at = new Date().toISOString();
  // Write the complete reservation before any child can be claimed.
  await persistCollectInfo(ctx, base.id, info);
  for (const batch of pipeline.batches) {
    if (batch.inserted) continue;
    ctx.signal?.throwIfAborted();
    await dispatchConstructJob({ ctx, ownerId: project.created_by, projectName: project.name,
      baseLabel: base.filename ?? base.id, rows: batch.rows, market, reservedId: batch.id });
    batch.inserted = true;
    await persistCollectInfo(ctx, base.id, info);
  }
  if (args.reserveOnly) return [];
  let active = pipeline.batches.find((batch) => batch.id === pipeline.active_batch_id);
  if (!active) {
    // A slow website in one batch must not hold up a completed neighbour.
    for (const batch of pipeline.batches) {
      const status = await readConstructJobStatus(ctx, batch.id);
      if (!status || ['completed', 'failed', 'cancelled'].includes(status.status)) { active = batch; break; }
    }
    // Keep a pending head only as UI progress, without pinning the import order.
    const display = active ?? pipeline.batches[0];
    if (display) info.construct = { bc_job_id: display.id, status: 'dispatched', dispatched_at: display.dispatched_at };
    if (active) pipeline.active_batch_id = active.id;
    await persistCollectInfo(ctx, base.id, info);
    return display?.rows ?? [];
  }
  info.construct = { bc_job_id: active.id, status: 'dispatched', dispatched_at: active.dispatched_at };
  return active.rows;
}

/** A saved-reserve pass can span many worker wakes. Keep its free constructor
 * slots busy with already fetched, usable source rows, without starting search
 * or changing which batch owns the current round. Manual review stays saved-only.
 */
async function prefetchBufferedPreviewBatches(args: {
  ctx: VeStageContext; base: VeAutoBase; info: VeCollectInfo; project: VeProject;
  target: VeCollectionTargetProgress; market: VeMarket;
}): Promise<void> {
  const { ctx, base, info, target } = args;
  const pipeline = info.preview_pipeline;
  if (!pipeline || pipeline.error || info.validation_retry || info.adaptive_collection?.pending || target.ready_rows >= target.ready_target
    || target.round >= target.max_rounds
    || (pipeline.batches.length >= PREVIEW_IN_FLIGHT && pipeline.batches.every((batch) => batch.inserted))
    || info.tasks?.some((task) => task.status === 'failed')) return;
  const buffered = dedupUnifiedRows(interleaveTaskHarvests((info.tasks ?? [])
    .filter((task) => task.status === 'done')
    .map((task) => taggedHarvest(task).filter((row) => normalizeCompanyForDedup(row.company) !== ''))));
  const excluded = await loadOtherBaseExclusionKeys(ctx, base.project_id, base.id, base.hypothesis_id);
  // Use the same immutable acquisition receipts as the ordinary harvest path.
  addAcquisitionReceipts(excluded, info.target_checkpoint?.seen_rows ?? [], buffered);
  addRowsToExclusionKeys(excluded, Array.isArray(base.data) ? base.data : []);
  const available = applyVeSourceContacts(buffered.filter((row) => !baseRowMatchesExclusion(excluded, row)), info.source_contact_recovery)
    .filter(hasExistingSourceContact)
    .map((row) => pruneBaseRowAgainstExclusion(excluded, row))
    .filter((row): row is VeUnifiedRow => row !== null);
  if (!available.length && pipeline.batches.every((batch) => batch.inserted)) return;
  // The reserve belongs to an already accounted round; reserve only the
  // remaining future rounds, without advancing the persisted review cursor.
  await preparePreviewBatches({ ...args, target: { ...target, round: target.round + 1 }, available, reserveOnly: true });
}

export interface VeConstructImport {
  rows: Array<VeUnifiedRow & { description: string }>;
  /**
   * Вердикт валидации (колонка «Email Статус») по каждой строке rows,
   * lowercase; null — колонки статуса в сетке не было / у строки пусто.
   * Нужен доливу VE2: допускаются 'ok' и 'catch_all'.
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
 * merged-ячейки (контракт ve_bases — один email на строку). Строки без
 * компании отбрасываются. null — данных нет/пусто (импортировать нечего).
 */
async function importConstructRows(ctx: VeStageContext, bcJobId: string): Promise<VeConstructImport | null> {
  const { data, error } = await ctx.supabase
    .from('base_constructor_jobs')
    .select('data, result_stats')
    .eq('id', bcJobId)
    .maybeSingle();
  if (error) throw new Error(`base_constructor_jobs data read: ${error.message}`);
  const grid = (data as { data?: unknown } | null)?.data;
  if (!Array.isArray(grid) || grid.length < 1 || !Array.isArray(grid[0])) return null;

  const header = (grid[0] as unknown[]).map((h) => String(h ?? '').trim().toLowerCase());
  const idxByKey = new Map<string, number>();
  header.forEach((h, i) => {
    const key = CONSTRUCT_HEADER_MAP[h];
    if (key && !idxByKey.has(key)) idxByKey.set(key, i);
  });
  const statusIdx = header.indexOf('email статус');
  // Completed validation can correctly reject every input. Preserve the empty
  // validated result instead of falling back to raw, unvalidated candidates.
  if (grid.length === 1 && statusIdx >= 0 && idxByKey.has('company') && idxByKey.has('email')) return {
    rows: [], emailStatuses: [], emailsFound: 0, validCount: 0, hasDescription: idxByKey.has('description'),
  };

  const rows: Array<VeUnifiedRow & { description: string }> = [];
  const emailStatuses: Array<string | null> = [];
  let validCount = 0;
  for (const bodyRow of grid.slice(1) as unknown[][]) {
    const get = (key: keyof VeUnifiedRow | 'description'): string => {
      const idx = idxByKey.get(key);
      return idx === undefined ? '' : String(bodyRow[idx] ?? '').trim();
    };
    const company = get('company');
    // Мусорные строки (пустая/схлопнутая компания) — как на HARVEST: выбросить.
    if (!normalizeCompanyForDedup(company)) continue;
    const emailStatus = statusIdx >= 0 ? String(bodyRow[statusIdx] ?? '').trim().toLowerCase() : '';
    if (isVeAcceptedEmailStatus(emailStatus)) validCount += 1;
    emailStatuses.push(emailStatus || null);
    rows.push({
      ...unifiedRow({
        company,
        website: get('website'),
        // Конструктор разносит адреса до проверки: статус принадлежит этой строке.
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

/**
 * Запись конструктора пережила свой раунд: раунд закрыт (completed_round ===
 * round), а construct всё ещё dispatched. У 3cfcfbbd задача d0abb3ea
 * завершилась 16.09 за полминуты, но раунд закрылся без её результата, и
 * запись висела неделю: адаптивный режим не включался, а каждое продолжение
 * снова ждало давно готовую задачу. Сверяем запись с base_constructor_jobs:
 * готовые строки переносим в резерв непроверенными (их разберёт обычная
 * проверка резерва — без нового обхода сайтов), запись снимаем. Идущую задачу
 * не трогаем.
 */
async function settleStaleConstruct(ctx: VeStageContext, base: VeAutoBase, info: VeCollectInfo,
  target: VeCollectionTargetProgress | null): Promise<void> {
  const construct = info.construct;
  if (!target || info.preview_pipeline || construct?.status !== 'dispatched' || !construct.bc_job_id
    || info.target_checkpoint?.completed_round !== target.round) return;
  const bc = await readConstructJobStatus(ctx, construct.bc_job_id);
  if (bc && !['completed', 'failed', 'cancelled'].includes(bc.status)) return;
  // Задача без split_emails отдаёт статус первого адреса склеенной ячейки: такой
  // результат не переносим (основной путь пересобирает его по той же причине).
  const imported = bc && (bc.selected_steps?.includes('split_emails') ?? true)
    ? await importConstructRows(ctx, construct.bc_job_id) : null;
  const reserve = readVeRelevanceReserve(info.relevance_reserve);
  const known = new Set([...reserve, ...(Array.isArray(base.data) ? base.data as Array<Record<string, unknown>> : [])]
    .map(veRelevanceRowKey));
  const moved = (imported?.rows ?? []).flatMap((row, index) => {
    const status = imported!.emailStatuses[index];
    const saved: Record<string, unknown> = { ...row, ...(status ? { _email_status: status } : {}), _relevance_unchecked: true };
    if (!cell(row.description)) delete saved.description;
    return known.has(veRelevanceRowKey(saved)) ? [] : [saved];
  });
  if (moved.length) {
    info.relevance_reserve = { ...(info.relevance_reserve ?? { version: 1 }), version: 1, rows: mergeVeRelevanceRows(reserve, moved) };
  }
  delete info.construct;
  if (info.search_policy) delete info.search_policy.construct_rows;
  await persistCollectInfo(ctx, base.id, info);
  stageLog(ctx, `[base_collect] конструктор ${construct.bc_job_id} (${bc?.status ?? 'не найден'}) остался от закрытого раунда: `
    + (moved.length ? `${moved.length} строк перенесено в резерв на проверку` : 'переносить нечего') + ', запись снята');
}

/** Голый код ОКВЭД в поле деятельности — так строки реестра сохранялись до 21.09. */
const BARE_OKVED_CODE = /^\d{2}(?:\.\d{1,2}){0,2}$/;
/** Справочник ОКВЭД не меняется между тиками: код → название (null — кода нет в справочнике). */
const okvedNameCache = new Map<string, string | null>();

/**
 * Название ОКВЭД в сохранённые строки реестра. 82db5cf21 кладёт название
 * только в новые выборки, а у 1a69cda6 в запасе реестра остались 200 строк с
 * одним «35.1»: быстрой проверке и классификатору такой код ничего не
 * говорит. Название берём из okved_reference — бесплатно. Меняем только
 * строки, которые ещё не ушли в проверку (запас задач и отложенные строки):
 * category входит в ключ сохранённого вердикта, и в резерве оплаченный
 * вердикт пропал бы. Отметки выборки (company/сайт/ИНН/почта) не меняются.
 */
async function nameBareOkvedCodes(ctx: VeStageContext, info: VeCollectInfo): Promise<number> {
  const groups = [...(info.tasks ?? []).map((task) => task.harvest ?? []), info.search_policy?.deferred_rows ?? []];
  // Только строки реестра: число в category другого источника — не код ОКВЭД.
  const bare = (row: VeUnifiedRow) => {
    const code = cell(row.category);
    return BARE_OKVED_CODE.test(code) && cell(row.source_detail).split('\n')[0] === 'реестр' ? code : null;
  };
  const missing = new Set(groups.flatMap((rows) => rows.map(bare)).filter((code): code is string => !!code && !okvedNameCache.has(code)));
  if (missing.size) {
    const { data, error } = await ctx.supabase.from('okved_reference').select('code, name').in('code', [...missing]);
    // Без справочника строки остаются как были: это подсказка, а не условие сбора.
    if (error) { stageLog(ctx, `[base_collect] справочник ОКВЭД недоступен: ${error.message}`); return 0; }
    for (const code of missing) okvedNameCache.set(code, null);
    for (const row of (data ?? []) as Array<{ code?: unknown; name?: unknown }>) {
      if (typeof row.code === 'string' && cell(row.name)) okvedNameCache.set(row.code, cell(row.name));
    }
  }
  let named = 0;
  for (const rows of groups) rows.forEach((row, index) => {
    const code = bare(row);
    const name = code ? okvedNameCache.get(code) : null;
    if (!code || !name) return;
    rows[index] = { ...row, category: `${name}\n${code}` };
    named += 1;
  });
  return named;
}

/* ─────────────────────────── Стадия ─────────────────────────── */

async function holdInactiveSupply(ctx: VeStageContext, job: VeJob, base: VeAutoBase, info: VeCollectInfo): Promise<boolean> {
  const batchId = info.supply_batch_id ?? job.payload?.supply_batch_id;
  if (info.collection_mode !== 'supply' || typeof batchId !== 'string') return false;
  const { data: batch, error: batchError } = await ctx.supabase.from('ve_contact_supply_batches')
    .select('plan_id').eq('id', batchId).eq('base_id', base.id).maybeSingle();
  if (batchError || !batch?.plan_id) throw new Error(`supply batch unavailable: ${batchError?.message ?? batchId}`);
  if (await isContactSupplyActive(ctx.supabase, batch.plan_id)) return false;
  if (!info.supply_hold) {
    info.supply_hold = true;
    info.supply_hold_since = new Date().toISOString();
    delete info.waiting_for_base_id;
    await persistCollectInfo(ctx, base.id, info);
  }
  await requeueSelf(ctx, job, 5 * 60_000);
  return true;
}

function resumeHeldSupplyTimers(info: VeCollectInfo): void {
  const heldAt = Date.parse(info.supply_hold_since ?? '');
  const pausedMs = Number.isFinite(heldAt) ? Math.max(0, Date.now() - heldAt) : 0;
  const adjusted = (value: string | undefined) => {
    const time = Date.parse(value ?? '');
    return Number.isFinite(time) ? new Date(time + pausedMs).toISOString() : value;
  };
  if (info.construct?.dispatched_at) info.construct.dispatched_at = adjusted(info.construct.dispatched_at);
  for (const task of info.tasks ?? []) if (task.dispatched_at) task.dispatched_at = adjusted(task.dispatched_at);
  delete info.supply_hold;
  delete info.supply_hold_since;
}

async function ensureTargetBaseAnalysis(ctx: VeStageContext, job: VeJob, baseId: string): Promise<void> {
  const { data, error } = await ctx.supabase.from('ve_jobs').select('id, payload')
    .eq('project_id', job.project_id).eq('stage', 'base_analyze').in('status', ['pending', 'running']);
  if (error) throw new Error(`ve_jobs analysis recovery read: ${error.message}`);
  if ((data ?? []).some((candidate) => (candidate.payload as { base_id?: string } | null)?.base_id === baseId)) return;
  const { error: insertError } = await ctx.supabase.from('ve_jobs').insert({
    project_id: job.project_id, stage: 'base_analyze', status: 'pending', payload: { base_id: baseId },
  });
  if (insertError) throw new Error(`ve_jobs base_analyze enqueue: ${insertError.message}`);
}

/** Yield through the normal worker accounting path after a durable bounded retry. */
class VeRelevanceRetryScheduled extends Error {
  constructor(readonly baseId: string, readonly usage: VeUsage) {
    super('Automatic relevance retry scheduled');
    this.name = 'VeRelevanceRetryScheduled';
  }
}

async function checkCollectedRelevance(args: {
  ctx: VeStageContext; job: VeJob; base: VeAutoBase; info: VeCollectInfo;
  finalRows: VeUnifiedRow[]; finalEmailStatuses: Array<string | null> | null;
  market: string; usage: VeUsage;
  previousRelevanceCheckpoint?: unknown;
  /** Company facts only: these rows must never become output recipients. */
  evidenceRows?: Array<Record<string, unknown>>;
}) {
  const { ctx, job, base, info, finalRows, finalEmailStatuses, market, usage } = args;
  // ─── QUALITY GATE (до refill/финала: пометки нужны обоим путям) ───
  // 1) вердикты валидации почт → _email_status на строках (запуск пропускает
  //    не-'ok' — баунсы не ложатся на домен клиента);
  // 2) релевант-гейт LLM → _low_relevance для явного несовпадения и
  //    _relevance_unchecked для хвоста/сбойного батча. Оба fail-closed
  //    фильтруются из launchTemplate/refill. Пометки живут только в jsonb-
  //    строках: в columns не попадают, сетки UI их не видят.
  type StoredRow = VeUnifiedRow & {
    _email_status?: string;
    _low_relevance?: boolean;
    _relevance_unchecked?: boolean;
    _ve_relevance?: VeRelevanceDecision;
    _ve_email_pending_relevance?: boolean;
  };
  let storedRows: StoredRow[] = finalRows.map((row) => {
    const clean: StoredRow = { ...row };
    delete clean._low_relevance;
    delete clean._relevance_unchecked;
    delete clean._ve_email_pending_relevance;
    // The gate never trusts an old verdict, but retains evidence-attempt counts
    // so bounded follow-up work rotates through the whole saved reserve.
    return clean;
  });
  if (finalEmailStatuses) {
    storedRows = storedRows.map((r, i) => {
      const st = finalEmailStatuses[i];
      return st ? { ...r, _email_status: st } : r;
    });
  }
  let lowRelevanceCount = 0;
  let relevanceUncheckedCount = 0;
  let relevanceNeedsReviewCount = 0;
  let relevanceErrorCount = 0;
  let relevanceCheckedCompanies: number | null = null;
  let relevanceTotalCompanies: number | null = null;
  let relevanceCoverageComplete = false;
  let relevanceError: string | null = null;
  // Pay for fit only once the company has a deliverable address. Keep ALL
  // observations of eligible companies: an invalid sibling email can still
  // carry useful business facts. Other companies remain in the durable reserve
  // and receive the unchanged fit gate when email recovery makes them usable.
  const eligibleCompanies = new Set(storedRows.filter((row) =>
    isVeAcceptedEmailStatus(row._email_status) && singleVeSavedEmail(row) !== null).map(veRelevanceCompanyKey));
  const eligibleIndices: number[] = [];
  const combinedRows = storedRows.map((row, index): StoredRow => {
    if (eligibleCompanies.has(veRelevanceCompanyKey(row))) { eligibleIndices.push(index); return row; }
    return { ...row, _ve_email_pending_relevance: true, _relevance_unchecked: true,
      _ve_relevance: { version: 2, status: 'needs_review',
        reason: 'Проверка соответствия будет выполнена после получения пригодного email.', evidence: [],
        context_hash: relevanceHash([job.project_id, base.id, 'awaiting-valid-email']), review_attempts: 0 } };
  });
  storedRows = eligibleIndices.map((index) => combinedRows[index]);
  const deferredCount = combinedRows.length - storedRows.length;
  if (deferredCount) stageLog(ctx, `[base_collect] ${deferredCount} строк без пригодного email сохранены; платная проверка соответствия отложена`);
  if (!storedRows.length) return { storedRows: combinedRows, lowRelevanceCount, relevanceUncheckedCount,
    relevanceNeedsReviewCount, relevanceErrorCount, relevanceCheckedCompanies: 0, relevanceTotalCompanies: 0,
    relevanceCoverageComplete: true, relevanceError };
  try {
    const { data: vrow } = await ctx.supabase
      .from('ve_verticals')
      .select('name, summary')
      .eq('id', base.vertical_id)
      .maybeSingle();
    const verticalName = (vrow as { name?: string } | null)?.name ?? '';
    let hypothesisTitle = '';
    let hypothesisDescription = '';
    if (base.hypothesis_id) {
      const { data: hypothesisRow, error: hypothesisError } = await ctx.supabase
        .from('ve_hypotheses')
        .select('title, description')
        .eq('id', base.hypothesis_id)
        .eq('project_id', job.project_id)
        .eq('vertical_id', base.vertical_id)
        .maybeSingle();
      if (hypothesisError) {
        throw new Error(`гипотеза relevance-gate недоступна: ${hypothesisError.message}`);
      } else {
        hypothesisTitle = (hypothesisRow as { title?: string } | null)?.title ?? '';
        hypothesisDescription =
          (hypothesisRow as { description?: string | null } | null)?.description ?? '';
        if (!hypothesisTitle.trim()) {
          throw new Error(
            `гипотеза relevance-gate ${base.hypothesis_id} не найдена или не имеет title`,
          );
        }
      }
    }
    const gate = await findIrrelevantRows({
      rows: storedRows,
      evidenceRows: args.evidenceRows,
      verticalName,
      verticalSummary: (vrow as { summary?: string | null } | null)?.summary ?? '',
      hypothesisTitle,
      hypothesisDescription,
      language: market === 'us' ? 'en' : 'ru',
      log: (m) => stageLog(ctx, m),
      signal: ctx.signal,
      onActivity: ctx.onActivity,
      checkpointScope: JSON.stringify([
        job.project_id, base.id, base.vertical_id, base.hypothesis_id ?? null,
      ]),
      reviewAttempt: job.payload?.review_relevance === true ? job.id : undefined,
      // Рубильник VE_PAID_WEBSITE_SEARCH=off отключает самую дорогую статью
      // сбора, не теряя компаний: они получают штатный «поиск отложен» и
      // вернутся к проверке, когда рубильник включат обратно.
      allowPaidSearch: isVePaidWebsiteSearchEnabled()
        && info.search_policy?.phase !== 'existing'
        && (!info.target_progress || info.target_progress.ready_rows < info.target_progress.ready_target),
      websiteLimit: info.target_progress ? Math.max(0, info.target_progress.ready_target - info.target_progress.ready_rows) : undefined,
      triage: isVeRelevanceTriageEnabled(job.project_id),
      checkpoint: [job.result?.relevance_checkpoint, args.previousRelevanceCheckpoint, info.relevance_checkpoint],
      onCheckpoint: async (checkpoint, options) => {
        ctx.signal?.throwIfAborted();
        const result = { ...job.result, relevance_checkpoint: checkpoint };
        // Keep the per-batch write small: collect_info includes source harvests.
        // A retry of this job resumes these verdicts; terminal base save below
        // carries them into a later manually enqueued recovery job as well.
        const { data: saved, error } = await ctx.supabase.from('ve_jobs')
          .update({ result, updated_at: new Date().toISOString() })
          .eq('id', job.id).eq('status', 'running').select('id').maybeSingle();
        if (error || !saved) throw new VeRelevanceCheckpointError(
          error ? `Relevance checkpoint save: ${error.message}` : 'Relevance checkpoint lost job ownership',
        );
        job.result = result;
        if (options?.canYield !== false) ctx.onCheckpoint?.();
        ctx.signal?.throwIfAborted();
      },
    });
    if (gate.checkpoint) info.relevance_checkpoint = gate.checkpoint;
    usage.tokensUsed += gate.tokensUsed;
    usage.costUsd += gate.costUsd;
    // Keep the completed constructor and per-company verdicts. Re-entering the
    // same stage reads these checkpoints; it does not buy another source round.
    // The budget is durable for this job/context, including across worker exits.
    if (gate.checkpoint) {
      const capacity = job.result?.relevance_capacity as { context_hash?: unknown; verdicts?: unknown } | undefined;
      const previousVerdicts = capacity?.context_hash === gate.checkpoint.context_hash
        && Number.isSafeInteger(capacity.verdicts) && Number(capacity.verdicts) >= 0 ? Number(capacity.verdicts) : 0;
      const verdicts = Object.keys(gate.checkpoint.verdicts).length;
      // A per-call company cap is a continuation only while durable decisions
      // increase. It must never spend the transient retry budget or loop.
      const continueCapacity = Boolean(gate.error) && gate.continueFromCheckpoint === true && verdicts > previousVerdicts;
      const retry = planVeRelevanceRetry(job.result?.relevance_retry, gate.checkpoint,
        Boolean(gate.error) && gate.retryable === true && !continueCapacity, gate.rateLimit);
      const waiting = continueCapacity || retry.retry;
      const result = { ...job.result, relevance_retry: retry.state, ...(continueCapacity ? { relevance_capacity: {
        context_hash: gate.checkpoint.context_hash, verdicts,
      } } : {}) };
      const retryError = retry.retry ? gate.error!.slice(0, 500) : null;
      const now = Date.now();
      ctx.signal?.throwIfAborted();
      // Commit budget, waiting reason and next wake atomically. A cancellation
      // must win without an old runner restoring pending or clearing its error.
      const { data: saved, error } = await ctx.supabase.from('ve_jobs')
        .update({ result, error: retryError, updated_at: new Date(now).toISOString(),
          ...(waiting ? { status: 'pending', started_at: null,
            run_after: new Date(now + (continueCapacity ? 30_000 : retry.delayMs)).toISOString() } : {}),
        })
        .eq('id', job.id).eq('status', 'running').select('id').maybeSingle();
      if (error || !saved) throw new VeRelevanceCheckpointError(
        error ? `Relevance retry checkpoint save: ${error.message}` : 'Relevance retry lost job ownership',
      );
      job.result = result;
      job.error = retryError;
      if (waiting) {
        stageLog(ctx, continueCapacity ? '[base_collect] пакет проверен; автоматически продолжаем оставшиеся компании'
          : `[base_collect] временный сбой автопроверки; повтор ${retry.state.consecutive_attempts}/${VE_RELEVANCE_MAX_CONSECUTIVE_RETRIES} без продвижения, `
            + `${retry.state.attempts}/${VE_RELEVANCE_MAX_TOTAL_RETRIES} всего, через ${retry.delayMs / 1000} с по сохранённым результатам`);
        throw new VeRelevanceRetryScheduled(base.id, { ...usage });
      }
    }
    lowRelevanceCount = gate.flagged.size;
    relevanceUncheckedCount = gate.unchecked.size;
    relevanceNeedsReviewCount = gate.review.size;
    relevanceErrorCount = gate.errored.size;
    relevanceCheckedCompanies = gate.coverage.checkedCompanies;
    relevanceTotalCompanies = gate.coverage.totalCompanies;
    relevanceCoverageComplete = gate.coverage.complete;
    relevanceError = gate.error ?? null;
    storedRows = storedRows.map((row, index) => {
      const decision = gate.decisions.get(index);
      if (!decision) throw new Error('Relevance gate did not return a decision for every row');
      return { ...row, _ve_relevance: decision,
        ...(decision.status === 'irrelevant' ? { _low_relevance: true } : {}),
        ...(['needs_review', 'error'].includes(decision.status) ? { _relevance_unchecked: true } : {}),
      };
    });
    stageLog(
      ctx,
      `[base_collect] релевант-гейт: проверено ${gate.coverage.checkedCompanies}/` +
        `${gate.coverage.totalCompanies} компаний; нерелевантных строк ${lowRelevanceCount}; ` +
        `без verdict ${relevanceUncheckedCount}`,
    );
  } catch (e) {
    ctx.signal?.throwIfAborted();
    if (e instanceof VeRelevanceCheckpointError || e instanceof VeRelevanceRetryScheduled
      || (e instanceof Error && e.name === 'AbortError')) throw e;
    relevanceError = e instanceof Error ? e.message : String(e);
    // Неожиданный сбой вне never-throw контракта gate тоже fail-closed: ни одна
    // строка без verdict не должна попасть в проверенный итог или refill.
    relevanceUncheckedCount = storedRows.length;
    lowRelevanceCount = 0;
    relevanceNeedsReviewCount = 0;
    relevanceErrorCount = storedRows.length;
    relevanceCoverageComplete = false;
    storedRows = storedRows.map((row) => ({ ...row, _relevance_unchecked: true,
      _ve_relevance: { version: 2, status: 'error', reason: 'Не удалось завершить проверку; контакт сохранён для повторной попытки',
        evidence: [], context_hash: relevanceHash([job.project_id, base.vertical_id, base.hypothesis_id]),
        review_attempts: row._ve_relevance?.review_attempts ?? 0 },
    }));
    stageLog(
      ctx,
      `[base_collect] релевант-гейт недоступен, все ${storedRows.length} строк исключены: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }
  storedRows.forEach((row, index) => { combinedRows[eligibleIndices[index]] = row; });
  return { storedRows: combinedRows, lowRelevanceCount, relevanceUncheckedCount, relevanceNeedsReviewCount, relevanceErrorCount,
    relevanceCheckedCompanies, relevanceTotalCompanies, relevanceCoverageComplete, relevanceError };
}


/** Recheck the durable constructor result, without paying for sources/BC again. */
async function resumeSavedPreviewValidation(
  ctx: VeStageContext, job: VeJob, base: VeAutoBase, info: VeCollectInfo,
  target: VeCollectionTargetProgress, market: VeMarket, usage: VeUsage,
): Promise<VeStageResult> {
  // New previews retain every round's pending candidates, not just the last BC
  // output. Reuse that durable reserve before considering legacy BC recovery.
  if (readVeRelevanceReserve(info.relevance_reserve).some(needsVeRelevanceReview)) {
    info.relevance_review_requested = true;
    return reviewSavedRelevance(ctx, job, base, info, target, market, usage);
  }
  const bcId = info.construct?.bc_job_id;
  if (!bcId || info.construct?.status !== 'done') throw new Error('Saved constructor result is unavailable');
  // A terminal write/cancellation failure may have left successful batches
  // only in the old job, before the final base snapshot. A new manual job
  // must not repay that work. The gate validates constructor/round/model/
  // hypothesis context before accepting any of these candidate checkpoints.
  const { data: previous, error: checkpointError } = await ctx.supabase.from('ve_jobs')
    .select('result').eq('project_id', job.project_id).eq('stage', 'base_collect')
    .eq('payload->>base_id', base.id).neq('id', job.id)
    .not('result->relevance_checkpoint', 'is', null)
    .order('updated_at', { ascending: false }).limit(1).maybeSingle();
  if (checkpointError) throw new VeRelevanceCheckpointError(`Saved relevance read: ${checkpointError.message}`);
  const { data: bc, error } = await ctx.supabase.from('base_constructor_jobs')
    .select('status, selected_steps').eq('id', bcId).maybeSingle();
  if (error) throw new Error(`Saved constructor read: ${error.message}`);
  if (bc?.status !== 'completed' || !Array.isArray(bc.selected_steps)
    || !bc.selected_steps.includes('split_emails') || !bc.selected_steps.includes('validate_emails')) {
    throw new Error('Saved constructor has not completed per-address validation');
  }
  const imported = await importConstructRows(ctx, bcId);
  if (!imported || imported.emailStatuses.some((status) => status === null)) {
    throw new Error('Saved constructor email verdicts are incomplete');
  }
  // Legacy partial previews retained their verified recipients, but not the
  // rejected/unchecked verdicts. Keep those recipients; recheck the remaining BC
  // output for this same immutable hypothesis, including legacy rejected rows.
  const priorReady = (Array.isArray(base.data) ? base.data : []) as Array<VeUnifiedRow & { _email_status?: string }>;
  if (priorReady.some((row) => !isVeAcceptedEmailStatus(row._email_status))) throw new Error('Saved preview email verdicts are incomplete');
  const identity = (row: VeUnifiedRow) => JSON.stringify([row.company, row.email.toLowerCase()]);
  // Addresses held back only by the per-company limit already carry a final
  // verdict in the reserve: the constructor re-import must not send them through
  // the relevance check again.
  const overCapReserve = readVeRelevanceReserve(info.relevance_reserve).filter((row) => Boolean(row[VE_COMPANY_CAP_FIELD])) as VeUnifiedRow[];
  const priorKeys = new Set([...priorReady, ...overCapReserve].map(identity));
  const combined = new Map<string, { row: VeUnifiedRow; status: string | null }>();
  const add = (row: VeUnifiedRow, status: string | null) => {
    const clean = { ...row } as VeUnifiedRow & { _low_relevance?: boolean; _relevance_unchecked?: boolean };
    delete clean._low_relevance;
    delete clean._relevance_unchecked;
    if (!priorKeys.has(identity(row))) combined.set(identity(row), { row: clean, status });
  };
  imported.rows.forEach((row, index) => add(row, imported.emailStatuses[index]));
  const keys = await loadOtherBaseExclusionKeys(ctx, job.project_id, base.id, base.hypothesis_id);
  const finalRows: VeUnifiedRow[] = [];
  const finalEmailStatuses: Array<string | null> = [];
  for (const { row, status } of combined.values()) {
    const pruned = pruneBaseRowAgainstExclusion(keys, row);
    if (pruned) { finalRows.push(pruned); finalEmailStatuses.push(status); }
  }
  if (finalEmailStatuses.some((status) => status === null)) throw new Error('Saved preview email verdicts are incomplete');
  stageLog(ctx, `[base_collect] продолжаем проверку сохранённых ${finalRows.length} строк; источники и конструктор не перезапускаются`);
  const gate = await checkCollectedRelevance({ ctx, job, base, info, finalRows, finalEmailStatuses, market, usage,
    previousRelevanceCheckpoint: previous?.result?.relevance_checkpoint });
  const seenKeys = addAcquisitionReceipts(buildBaseExclusionKeysFromRows(info.target_checkpoint?.seen_rows ?? []), info.target_checkpoint?.seen_rows ?? [], info.tasks?.flatMap((task) => task.harvest ?? []) ?? []);
  const hasBufferedCandidates = (info.tasks ?? []).some((task) => task.status === 'done'
    && (task.harvest ?? []).some((row) => {
      const fresh = pruneBaseRowAgainstExclusion(keys, row);
      return fresh !== null && pruneBaseRowAgainstExclusion(seenKeys, fresh) !== null;
    }));
  const stats: NonNullable<VeCollectInfo['stats']> = {
    tasks_total: info.tasks?.length ?? 0, tasks_done: info.tasks?.filter((t) => t.status === 'done').length ?? 0,
    tasks_failed: info.tasks?.filter((t) => t.status === 'failed').length ?? 0,
    rows_total: target.candidates_processed, excluded_existing_bases: 0, excluded_during_fetch: 0,
    ...info.stats,
    low_relevance: gate.lowRelevanceCount, relevance_unchecked: gate.relevanceUncheckedCount,
    relevance_checked_companies: gate.relevanceCheckedCompanies ?? undefined,
    relevance_total_companies: gate.relevanceTotalCompanies ?? undefined,
    relevance_coverage_complete: gate.relevanceCoverageComplete,
    relevance_recovery: true,
  };
  return completeTargetRound({
    ctx, job, base, info, progress: target, candidates: [], rows: [...priorReady, ...gate.storedRows],
    columns: [...new Set([...(base.columns ?? []), ...VE_AUTO_COLLECT_COLUMNS, ...(imported.hasDescription ? ['description'] : [])])],
    stats, hasBufferedCandidates,
    validationError: gate.relevanceCoverageComplete ? null : gate.relevanceError ?? 'Проверка релевантности завершилась не полностью', usage,
  });
}

/** Improve saved candidates before refill; explicit manual runs still acquire no new sources. */
async function reviewSavedRelevance(
  ctx: VeStageContext, job: VeJob, base: VeAutoBase, info: VeCollectInfo,
  target: VeCollectionTargetProgress, market: VeMarket, usage: VeUsage,
): Promise<VeStageResult> {
  const automatic = info.relevance_review_requested === true && job.payload?.review_relevance !== true;
  let savedReserve = readVeRelevanceReserve(info.relevance_reserve);
  let emailRecoveryError: string | null = null;
  let emailRecoveryWaiting = false;
  if (automatic || job.payload?.review_relevance === true) {
    const recovered = await recoverVeSavedEmails({
      ctx, job, baseId: base.id, rows: savedReserve, state: info.saved_email_recovery, automatic,
      save: async (state: VeSavedEmailRecoveryState, rows: Array<Record<string, unknown>>) => {
        info.saved_email_recovery = state;
        info.relevance_reserve = { ...info.relevance_reserve, version: 1, rows };
        info.relevance_summary = summarizeVeRelevanceReserve(rows);
        await persistCollectInfo(ctx, base.id, info);
      },
    });
    savedReserve = recovered.rows;
    info.saved_email_recovery = recovered.state;
    emailRecoveryWaiting = recovered.waiting;
    emailRecoveryError = recovered.error ?? null;
  }
  const { rows, evidenceRows, companies } = buildVeRelevanceReviewBatch({
    reserve: savedReserve,
    ready: Array.isArray(base.data) ? base.data : [],
    source: readVeRelevanceSourceRows(info.relevance_reserve), automatic,
    allowPaidSearch: info.search_policy?.phase !== 'existing',
    triage: isVeRelevanceTriageEnabled(job.project_id),
  });
  // A queued SMTP child must not hold already validated recipients behind
  // unrelated constructor jobs. Review those companies now; unknown email
  // recipients still cannot enter the ready projection. Drain the same child
  // before finalizing, including when this pass already reaches the target.
  //
  // Но «сейчас» — это один раз. Если предыдущий проход вернул ровно тот же
  // отбор (relevance_review_progress.passes > 0), гейт отдаст те же
  // сохранённые вердикты и в этот раз: провайдера он не спросит, а база
  // заплатит полным чтением и перезаписью резерва (19-62 МБ) за нулевой
  // результат. Пока дочерняя валидация почт не ответила, ждём дёшево;
  // её вердикты меняют отбор, и следующий проход снова будет осмысленным.
  const savedReviewStalled = (info.relevance_review_progress?.passes ?? 0) > 0;
  if (emailRecoveryWaiting && (savedReviewStalled
    || !rows.some((row) => isVeAcceptedEmailStatus(row._email_status))
    || (target.ready_rows ?? 0) >= target.ready_target)) {
    // Опрос оставлен минутным намеренно. Каждый заход сюда перечитывает строку
    // ve_bases целиком (select('*') на входе стадии), а это 12-80 МБ на базу с
    // тяжёлым резервом и всё через main-rest. Учащение до 15 с дало бы вчетверо
    // больше таких чтений ради ~5% ожидания при медиане ожидания 399 с — тот же
    // паттерн, что выбивал main-rest. Ускорять надо не опрос, а вход в стадию.
    await requeueSelf(ctx, job, 60_000);
    return { result: { base_id: base.id, waiting: true, saved_email_review: true }, ...usage };
  }
  // An email-only pass can finish with no classifiable rows (for example all
  // addresses remain unknown). It must reach the bounded refill decision.
  stageLog(ctx, `[base_collect] уточняем ${rows.length} сохранённых контактов ${companies} компаний; факты всех адресов объединены, новый сбор не запускается`);
  const gate = rows.length > 0 && !emailRecoveryError ? await checkCollectedRelevance({ ctx, job, base, info,
    finalRows: rows as VeUnifiedRow[], finalEmailStatuses: rows.map((row) => typeof row._email_status === 'string' ? row._email_status : null),
    market, usage, evidenceRows,
  }) : null;
  info.validation_retry = true;
  const stats: NonNullable<VeCollectInfo['stats']> = {
    tasks_total: info.tasks?.length ?? 0, tasks_done: info.tasks?.filter((task) => task.status === 'done').length ?? 0,
    tasks_failed: info.tasks?.filter((task) => task.status === 'failed').length ?? 0,
    rows_total: target.candidates_processed, excluded_existing_bases: 0, excluded_during_fetch: 0,
    ...info.stats,
    ...(gate ? { low_relevance: gate.lowRelevanceCount, relevance_unchecked: gate.relevanceUncheckedCount,
      relevance_needs_review: gate.relevanceNeedsReviewCount, relevance_errors: gate.relevanceErrorCount,
      relevance_checked_companies: gate.relevanceCheckedCompanies ?? undefined,
      relevance_total_companies: gate.relevanceTotalCompanies ?? undefined,
      relevance_coverage_complete: gate.relevanceCoverageComplete } : {}),
    relevance_recovery: true,
  };
  const seenKeys = addAcquisitionReceipts(buildBaseExclusionKeysFromRows(info.target_checkpoint?.seen_rows ?? []), info.target_checkpoint?.seen_rows ?? [], info.tasks?.flatMap((task) => task.harvest ?? []) ?? []);
  const hasBufferedCandidates = automatic && (info.tasks ?? []).some((task) => task.status === 'done'
    && (task.harvest ?? []).some((row) => pruneBaseRowAgainstExclusion(seenKeys, row) !== null));
  return completeTargetRound({ ctx, job, base, info, progress: target, candidates: [], rows: mergeVeRelevanceRows(savedReserve, gate?.storedRows ?? []),
    columns: base.columns ?? [...VE_AUTO_COLLECT_COLUMNS], stats, hasBufferedCandidates,
    validationError: emailRecoveryError ?? (gate && !gate.relevanceCoverageComplete
      ? gate.relevanceError ?? 'Проверка релевантности завершилась не полностью' : null), usage,
  });
}

async function cleanCollectedCompanyNames(
  ctx: VeStageContext, job: VeJob, info: VeCollectInfo, rows: Array<Record<string, unknown>>, usage: VeUsage,
) {
  const { data: previous, error } = await ctx.supabase.from('ve_jobs')
    .select('result').eq('project_id', job.project_id).eq('stage', 'base_collect')
    .eq('payload->>base_id', payloadString(job, 'base_id')).neq('id', job.id)
    .not('result->company_name_checkpoint', 'is', null)
    .order('updated_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new VeRelevanceCheckpointError(`Saved company name checkpoint read: ${error.message}`);
  const cleaned = await cleanVeCompanyNames({
    rows, scope: payloadString(job, 'base_id'), language: ctx.market === 'us' ? 'en' : 'ru', signal: ctx.signal,
    checkpoint: [job.result?.company_name_checkpoint, previous?.result?.company_name_checkpoint, info.company_name_checkpoint],
    log: (message) => stageLog(ctx, message),
    onCheckpoint: async (checkpoint, progress) => {
      ctx.signal?.throwIfAborted();
      const result = { ...job.result, company_name_checkpoint: checkpoint };
      const now = new Date().toISOString();
      const { data: saved, error: writeError } = await ctx.supabase.from('ve_jobs').update({
        result, progress: { ...progress, label: 'Очищаем названия компаний', updated_at: now, substep_started_at: now },
        updated_at: now,
      }).eq('id', job.id).eq('status', 'running').select('id').maybeSingle();
      if (writeError || !saved) throw new VeRelevanceCheckpointError(writeError
        ? `Company name checkpoint save: ${writeError.message}` : 'Company name checkpoint lost job ownership');
      job.result = result;
      ctx.onCheckpoint?.();
      ctx.signal?.throwIfAborted();
    },
  });
  info.company_name_checkpoint = cleaned.checkpoint;
  info.company_name_cleanup = cleaned.summary;
  usage.tokensUsed += cleaned.tokensUsed;
  usage.costUsd += cleaned.costUsd;
  return cleaned;
}

/**
 * Apply a TIGHTENED "addresses per company" limit to an already finished preview.
 *
 * Deliberately not a collection round: it reads the saved ready rows, keeps at
 * most N per company and moves the rest into the reserve. No sources, no
 * constructor, no SMTP, no search, no relevance or name calls, and no base
 * analysis — the composition of a base that only lost addresses of companies it
 * already contains does not change. The base stays `analyzed` the whole time, so
 * a failure here can never make a finished preview look like an interrupted
 * collection. Raising or removing the limit is NOT done here: returning
 * addresses would need a paid company-name check, so that stays behind the
 * specialist's explicit «Продолжить подготовку».
 */
/** Начало заметки о лимите адресов в причине остановки. По нему же заметку
 *  срезают при повторном применении лимита, поэтому текст должен совпадать. */
const VE_CAP_REASON_MARK = 'Применён лимит';

async function applyVeContactCapToFinishedBase(
  ctx: VeStageContext, job: VeJob, base: VeAutoBase,
): Promise<VeStageResult> {
  const info: VeCollectInfo = base.collect_info && typeof base.collect_info === 'object' ? base.collect_info : {};
  const target = info.target_progress;
  const limit = normalizeVeMaxEmailsPerCompany((base as unknown as { max_emails_per_company?: unknown }).max_emails_per_company);
  const applied = normalizeVeMaxEmailsPerCompany((base as unknown as { contact_cap_applied?: unknown }).contact_cap_applied);
  const rows = (Array.isArray(base.data) ? base.data : []) as VeUnifiedRow[];
  if (info.collection_mode !== 'preview' || !target || base.status !== 'analyzed') {
    return { result: { base_id: base.id, skipped: 'not_a_finished_preview' } };
  }
  if (limit === null || (applied !== null && limit >= applied)) {
    // Loosening is the specialist's explicit action; record what is applied now.
    await ctx.supabase.from('ve_bases').update({ contact_cap_applied: applied }).eq('id', base.id).eq('status', 'analyzed');
    return { result: { base_id: base.id, skipped: 'needs_manual_continue' } };
  }
  const capped = capVeContactsPerCompany(rows, { limit, incumbentKeys: new Set(rows.map(veRelevanceRowKey)) });
  if (!capped.overCap.length) {
    await ctx.supabase.from('ve_bases').update({ contact_cap_applied: limit }).eq('id', base.id).eq('status', 'analyzed');
    return { result: { base_id: base.id, rows: rows.length, unchanged: true } };
  }
  const columns = base.columns ?? [...VE_AUTO_COLLECT_COLUMNS];
  const kept = capped.kept.map(stripVeCompanyCapMarker) as VeUnifiedRow[];
  const overCapKeys = new Set(capped.overCap.map(veRelevanceRowKey));
  const reserveRows = mergeVeRelevanceRows(readVeRelevanceReserve(info.relevance_reserve),
    capped.overCap as Array<Record<string, unknown>>).map((row) =>
    // A row an earlier, looser limit already held back is over this tighter one too.
    overCapKeys.has(veRelevanceRowKey(row)) || row[VE_COMPANY_CAP_FIELD]
      ? { ...row, [VE_COMPANY_CAP_FIELD]: { limit } } : row);
  const readyRows = prepareSegmentationAudience({ rows: kept, columns, source: 'auto' }).rows;
  const belowTarget = readyRows.length < target.ready_target;
  // С лимитом засчитывается каждая готовая строка; прежние поля состава
  // (адресов больше, чем засчитано) после капа устарели.
  const next = withVeTargetComposition({ ...target, ready_rows: readyRows.length,
    status: belowTarget ? 'limited' : 'target_reached' }, countVeTargetContacts(readyRows, { limit, mode: 'preview' }), readyRows.length);
  if (belowTarget) {
    // Кап — это то, что случилось с базой ПОСЛЕДНИМ, а не причина, по которой
    // сбор остановился. Раньше эта строка затирала причину целиком, и карточка
    // сообщала специалисту, будто базу остановил лимит адресов, хотя у неё
    // кончился реестр, упёрся предел раундов или перестал окупаться добор.
    // После прогона капа по проекту так «переобъяснились» 44 базы из 54.
    const capNote = `${VE_CAP_REASON_MARK} ${limit} адресов на компанию: в готовой базе ${readyRows.length} `
      + `из ${target.ready_target} контактов, остальные проверенные адреса сохранены в резерве.`;
    // Свою же заметку срезаем перед пересборкой: кап применяют повторно (сначала
    // 3, потом 5), и иначе текст рос бы с каждым прогоном.
    const priorCause = (target.reason ?? '').split(VE_CAP_REASON_MARK)[0].trim();
    next.reason = [priorCause, capNote,
      'Новый сбор сам не запускается — при необходимости нажмите «Продолжить подготовку».',
    ].filter(Boolean).join(' ');
  } else delete next.reason;
  const saved: VeCollectInfo = {
    ...info,
    target_progress: next,
    relevance_reserve: { ...info.relevance_reserve, version: 1, rows: reserveRows },
    company_contact_cap: { limit, over_cap_rows: capped.overCap.length,
      companies: new Set(kept.map(veContactLimitKey)).size, applied_at: new Date().toISOString() },
    stats: { ...(info.stats ?? { tasks_total: 0, tasks_done: 0, tasks_failed: 0, rows_total: 0,
      excluded_existing_bases: 0, excluded_during_fetch: 0 }), launchable_rows: readyRows.length },
  };
  saved.relevance_summary = summarizeVeRelevanceReserve(reserveRows);
  ctx.signal?.throwIfAborted();
  // One atomic write, guarded on the status the decision was made from: a
  // parallel collection or launch must never be overwritten by this projection.
  const { data: written, error } = await ctx.supabase.from('ve_bases')
    .update({ collect_info: saved, data: kept, columns, row_count: kept.length,
      sample_rows: readyRows.slice(0, SAMPLE_ROWS), contact_cap_applied: limit, updated_at: new Date().toISOString() })
    .eq('id', base.id).eq('status', 'analyzed').select('id').maybeSingle();
  if (error) throw new VeRelevanceCheckpointError(`Contact cap save: ${error.message}`);
  if (!written) throw new VePreviewCheckpointConflict('Base changed while the contact limit was applied');
  stageLog(ctx, `[base_collect] лимит ${limit} адресов на компанию применён к сохранённой базе: готовых ${readyRows.length}, в резерв переведено ${capped.overCap.length}`);
  void job;
  return { result: { base_id: base.id, rows: readyRows.length, over_company_cap: capped.overCap.length } };
}

async function resumeSavedCompanyNames(
  ctx: VeStageContext, job: VeJob, base: VeAutoBase, info: VeCollectInfo,
  target: VeCollectionTargetProgress, usage: VeUsage,
): Promise<VeStageResult> {
  const recovery = info.company_name_recovery!;
  const rows = Array.isArray(base.data) ? base.data : [];
  if (rows.some((row) => !isVeAcceptedEmailStatus(row._email_status) || row._low_relevance === true
    || row._relevance_unchecked === true || !(VE_COMPANY_NAME_FIELD in row))) {
    throw new Error('Saved company name phase has incomplete contact validation');
  }
  stageLog(ctx, '[company_names] продолжаем очистку сохранённых контактов без повторного сбора и валидации');
  return completeTargetRound({ ctx, job, base, info, progress: target, candidates: [], rows,
    columns: base.columns ?? [...VE_AUTO_COLLECT_COLUMNS],
    stats: { tasks_total: 0, tasks_done: 0, tasks_failed: 0, rows_total: target.candidates_processed,
      excluded_existing_bases: 0, excluded_during_fetch: 0,
      ...info.stats, low_relevance: recovery.round_low_relevance,
      relevance_unchecked: recovery.round_relevance_unchecked },
    hasBufferedCandidates: recovery.has_buffered_candidates, validationError: recovery.validation_error, usage,
    continueManualReview: job.payload?.review_relevance === true,
  });
}

/**
 * The specialist's "addresses per company" limit for this base. Read fresh: it
 * may change while a long job runs, and the worker-owned collect_info must not
 * be its source (persistCollectInfo overwrites that document wholesale). A
 * missing column or a failed read means "no limit", never a failed round.
 */
async function readVeContactLimit(ctx: VeStageContext, job: VeJob, base: VeAutoBase, info: VeCollectInfo): Promise<number | null> {
  let own = normalizeVeMaxEmailsPerCompany((base as unknown as { max_emails_per_company?: unknown }).max_emails_per_company);
  try {
    const { data, error } = await ctx.supabase.from('ve_bases').select('max_emails_per_company').eq('id', base.id).maybeSingle();
    if (!error && data) own = normalizeVeMaxEmailsPerCompany((data as { max_emails_per_company?: unknown }).max_emails_per_company);
  } catch { /* keep the value loaded with the base */ }
  ctx.signal?.throwIfAborted();
  if (own !== null || (info.collection_mode ?? job.payload?.collection_mode) !== 'supply') return own;
  // Daily supply bases are created in SQL from the plan and carry no value of
  // their own: a new collection follows the project's current setting.
  try {
    const { data, error } = await ctx.supabase.from('ve_outreach_setups').select('max_emails_per_company')
      .eq('project_id', job.project_id).maybeSingle();
    return error || !data ? null : normalizeVeMaxEmailsPerCompany((data as { max_emails_per_company?: unknown }).max_emails_per_company);
  } catch { return null; }
}

/** Источник ещё может дать кандидатов без нового плана. */
function veTaskCanSupply(task: VeCollectTaskState): boolean {
  return task.status === 'pending' || task.status === 'dispatched' || isVeRenewableSourceTask(task);
}

/**
 * Широкая ли гипотеза базы. Сбой чтения или колонки ещё нет (воркер обновился
 * раньше миграции 20260923_0001) — обычная гипотеза, как до этой правки.
 */
async function readVeHypothesisBroad(ctx: VeStageContext, hypothesisId: string): Promise<boolean> {
  try {
    const { data, error } = await ctx.supabase.from('ve_hypotheses').select('broad').eq('id', hypothesisId).maybeSingle();
    return !error && (data as { broad?: unknown } | null)?.broad === true;
  } catch {
    return false;
  }
}

/** Сбой чтения не снимает порог: тогда он ослабляется, как обоснованный. */
async function readVeHypothesisSizeBasis(ctx: VeStageContext, hypothesisId: string | null | undefined): Promise<boolean> {
  if (!hypothesisId) return true;
  try {
    const { data, error } = await ctx.supabase.from('ve_hypotheses').select('title, description').eq('id', hypothesisId).maybeSingle();
    if (error || !data) return true;
    const row = data as { title?: unknown; description?: unknown };
    return veHypothesisSizeBasis(`${typeof row.title === 'string' ? row.title : ''}\n${typeof row.description === 'string' ? row.description : ''}`);
  } catch {
    return true;
  }
}

/**
 * Открыть расширенный срез для исчерпанного плана. Вторая очередь — без LLM и
 * без платных вызовов; если её нет, следующий заход один раз просит у
 * планировщика новый срез (adaptCollectionSources). Состояние меняется только
 * в памяти и сохраняется вместе с раундом.
 */
async function widenExhaustedPlan(
  ctx: VeStageContext, base: VeAutoBase, info: VeCollectInfo, tasks: VeCollectTaskState[],
  /** narrow_market: план жив, но по прогнозу срез мал для базы; dry_sources: все живые источники сухие. */
  cause: 'plan_exhausted' | 'narrow_market' | 'dry_sources' = 'plan_exhausted',
): Promise<boolean> {
  const policy = info.adaptive_collection ?? newVeAdaptiveCollection();
  const widenings = policy.widenings ?? 0;
  if (widenings >= VE_PLAN_WIDENING_LIMIT) return false;
  const lead = cause === 'narrow_market' ? 'Текущий срез мал для базы по прогнозу'
    : cause === 'dry_sources' ? 'Источники перестали давать контакты' : 'План исчерпан раньше цели';
  const sizeBasis = await readVeHypothesisSizeBasis(ctx, base.hypothesis_id);
  const added = veSecondQueueTasks(tasks.map((task) => task.task), sizeBasis);
  if (added.length) {
    for (const task of added) tasks.push({ source: task.source, task, status: 'pending', child_job_id: null, rows: 0 });
    policy.active_source = veSourceStrategyKey(added[0]);
    policy.switches += 1;
    policy.note = `${lead}: открыта вторая очередь — ` + (sizeBasis
      ? 'пороги размера ослаблены, компании без данных о штате и выручке тоже берём.'
      : 'тот же ОКВЭД без порогов размера, которых нет в гипотезе.');
  } else if (policy.replan_attempts < 2 && tasks.length < VE_PLAN_MAX_TASKS) {
    policy.replan_needed = true;
    policy.replan_reason = 'plan_exhausted';
    policy.note = `${lead}: подбираем новый срез того же рынка.`;
  } else return false;
  policy.widenings = widenings + 1;
  delete policy.replan_error;
  info.adaptive_collection = policy;
  info.tasks = tasks;
  info.plan = { tasks: tasks.map((task) => task.task) };
  // Прогноз считался по прежнему срезу; новый объём уточнят проверенные партии.
  if (info.estimate) info.estimate = { ...info.estimate, remaining_ready_estimate: null,
    estimate_reason: 'После расширения среза объём будет уточнён по новым проверенным партиям.' };
  return true;
}

async function completeTargetRound(args: {
  ctx: VeStageContext; job: VeJob; base: VeAutoBase; info: VeCollectInfo;
  progress: VeCollectionTargetProgress; candidates: VeUnifiedRow[];
  rows: Array<Record<string, unknown>>; columns: string[];
  stats: NonNullable<VeCollectInfo['stats']>; hasBufferedCandidates: boolean;
  validationError: string | null; usage: VeUsage;
  /** Completing old name work must not consume the user's new reserve-review request. */
  continueManualReview?: boolean;
}): Promise<VeStageResult> {
  const { ctx, job, base, info } = args;
  // Apply the new preview goal only after this round's input has been fully
  // accounted for. An in-flight legacy constructor keeps its original scope.
  const progress = args.progress.mode === 'preview'
    ? { ...args.progress, ready_target: VE_PREVIEW_READY_TARGET } : args.progress;
  info.ready_target = progress.ready_target;
  const tasks = info.tasks ?? [];
  const reviewOnly = job.payload?.review_relevance === true;
  const prior = info.target_checkpoint;
  const validationRetry = info.validation_retry === true || !!info.company_name_recovery || info.relevance_review_requested === true;
  const columns = [...new Set([...(base.columns ?? []), ...args.columns])];
  const previousRows = Array.isArray(base.data) ? base.data : [];
  // Keep the complete post-constructor observations across every round. data is
  // still only the validated contact projection used by audit and delivery.
  const representedCompanies = new Set(args.rows.map(veRelevanceCompanyKey));
  // A constructor may return no usable row for a source company. Retain that
  // original company too; lack of an email verdict is not an irreversible reject.
  const missingConstructorRows = args.candidates.filter((row) => !representedCompanies.has(veRelevanceCompanyKey(row)))
    .map((row) => ({ ...row, _relevance_unchecked: true }));
  const retainedRows = mergeVeRelevanceRows(readVeRelevanceReserve(info.relevance_reserve), previousRows, missingConstructorRows, args.rows);
  const freshKeys = await loadOtherBaseExclusionKeys(ctx, job.project_id, base.id, base.hypothesis_id);
  const availableRows = retainedRows.filter((row) =>
    row && typeof row === 'object' && !baseRowMatchesExclusion(freshKeys, row as VeUnifiedRow),
  );
  const eligibleRows = prepareSegmentationAudience({ rows: availableRows, columns, source: 'auto', ignoreCompanyNameCheck: true }).rows;
  // The specialist's limit decides which validated addresses form the ready base.
  // Nothing is deleted: the rest stays in the reserve, marked, and every later
  // partition (also after the limit is raised) decides again from all rows.
  const contactLimit = await readVeContactLimit(ctx, job, base, info);
  const limitChanged = normalizeVeMaxEmailsPerCompany((base as unknown as { contact_cap_applied?: unknown }).contact_cap_applied) !== contactLimit;
  const capped = capVeContactsPerCompany(eligibleRows, { limit: contactLimit, incumbentKeys: new Set(previousRows.map(veRelevanceRowKey)) });
  const contactRows = capped.kept.map(stripVeCompanyCapMarker);
  const contactKeys = new Set(contactRows.map(veRelevanceRowKey));
  const overCapKeys = new Set(capped.overCap.map(veRelevanceRowKey));
  const overCapRows = capped.overCap.map(stripVeCompanyCapMarker) as VeUnifiedRow[];
  const reserveRows = retainedRows.filter((row) => !contactKeys.has(veRelevanceRowKey(row))).map((row) =>
    overCapKeys.has(veRelevanceRowKey(row)) ? { ...row, [VE_COMPANY_CAP_FIELD]: { limit: contactLimit } } : stripVeCompanyCapMarker(row));
  if (contactLimit !== null) {
    info.company_contact_cap = { limit: contactLimit, over_cap_rows: capped.overCap.length,
      companies: new Set(contactRows.map(veContactLimitKey)).size, applied_at: new Date().toISOString() };
    if (capped.overCap.length) stageLog(ctx, `[base_collect] лимит ${contactLimit} адресов на компанию: в готовой базе ${contactRows.length}, сверх лимита сохранено в резерве ${capped.overCap.length}`);
  } else delete info.company_contact_cap;
  info.relevance_reserve = { version: 1, rows: reserveRows,
    source_rows: mergeVeRelevanceRows(readVeRelevanceSourceRows(info.relevance_reserve),
      args.candidates.map((row) => ({ ...row, _ve_source_candidate: true }))),
  };
  info.relevance_summary = summarizeVeRelevanceReserve(reserveRows);
  // Бюджет раундов расходует только раунд, отправивший в проверку что-то новое
  // для базы. Повторный проход того же раунда (проверка, названия, резерв)
  // считается, как и раньше, обычным раундом.
  const priorAcquired = addAcquisitionReceipts(buildBaseExclusionKeysFromRows([]), prior?.seen_rows ?? []);
  const idleRound = !validationRetry && args.candidates.every((row) => baseRowMatchesExclusion(priorAcquired, row));
  const seen = new Map<string, Partial<VeUnifiedRow> & Pick<VeUnifiedRow, 'company' | 'inn' | 'email' | 'website'>>();
  for (const row of [...(prior?.seen_rows ?? []), ...args.candidates, ...args.rows]) {
    const compact = { company: cell(row.company), inn: cell(row.inn), email: cell(row.email), website: cell(row.website),
      ...('address' in row ? { address: cell(row.address) } : {}), ...('source_detail' in row ? { source_detail: cell(row.source_detail) } : {}) };
    seen.set(JSON.stringify(compact), compact);
  }
  // Старая задача карт тоже продолжаема: следующий раунд читает её запросы
  // из готового каталога (sourceRenewal).
  const renewableDirectory = tasks.some(isVeRenewableSourceTask);
  const exhausted = !args.hasBufferedCandidates && tasks.length > 0 && tasks.every((task) =>
    (task.source === 'companies_directory' || !!task.catalog) && task.status === 'done' && task.exhausted && !task.hit_ceiling,
  );
  // A saved-only review does not retry sources: their old failure remains in
  // task history but must not invalidate a now-confirmed saved audience.
  const taskError = reviewOnly ? undefined : tasks.find((task) => task.status === 'failed');
  const pipeline = info.preview_pipeline;
  const pendingBatches = pipeline?.batches.filter((batch) => batch.id !== pipeline.active_batch_id) ?? [];
  const pendingSources = tasks.some((task) => task.status === 'pending' || task.status === 'dispatched');
  const existingFirst = info.search_policy?.phase === 'existing';
  const discoveryPaused = info.source_contact_budget?.paused === true;
  const pendingDiscovery = !existingFirst && !discoveryPaused && (tasks.some((task) => task.status === 'done'
    && !task.task.widened && hasPendingVeSourceContacts((task.harvest ?? []).filter((row) =>
      pruneBaseRowAgainstExclusion(freshKeys, row) !== null), info.source_contact_recovery))
    || hasPendingVeSourceContacts((info.search_policy?.deferred_rows ?? []).filter((row) =>
      pruneBaseRowAgainstExclusion(freshKeys, row) !== null), info.source_contact_recovery));
  // Цифры для честной причины остановки: сколько поисков куплено, сколько они
  // дали сайтов и сколько из этих сайтов дошло до готового контакта.
  const discoveryChecked = Object.values(info.source_contact_recovery?.checked ?? {});
  const discoverySites = discoveryChecked.filter((entry) => entry.website.trim().length > 0).length;
  const discoveryContacts = countVeSourceDiscoveryContacts(contactRows);
  const finish = (readyCount: number, nameError?: string) => {
    const phaseError = args.validationError ?? nameError ?? (taskError ? `${taskError.source}: ${taskError.error ?? 'ошибка источника'}` : null);
    const result = finishCollectionRound(progress, {
      candidates: args.candidates.length, readyRows: readyCount,
      validationRetry: validationRetry || (existingFirst && (renewableDirectory || pendingSources)),
      exhausted: reviewOnly ? false : exhausted && !discoveryPaused && !pendingDiscovery && pendingBatches.length === 0 && !pendingSources,
      canContinue: !reviewOnly && (args.hasBufferedCandidates || pendingDiscovery || renewableDirectory || pendingBatches.length > 0 || pendingSources),
      error: phaseError ?? pipeline?.error ?? null,
      idle: idleRound,
    });
    // The other child is already paid for. Drain it even if this batch reaches
    // the goal or fails; do not orphan its results or start replacement work.
    if (pipeline && pendingBatches.length > 0 && !nameError && !reviewOnly) {
      if (phaseError) pipeline.error = phaseError;
      return { ...result, status: 'collecting' as const, reason: undefined, round: progress.round + 1 };
    }
    if (discoveryPaused && result.status === 'limited') return { ...result,
      reason: `Добор сайтов закрыт: последние ${VE_SOURCE_DISCOVERY_NO_GROWTH_LIMIT} платных поисков не дали ни одного готового контакта (всего поисков ${discoveryChecked.length}, найдено сайтов ${discoverySites}, контактов из них ${discoveryContacts}). Это решение о рентабельности, а не исчерпание источников: строки без контакта сохранены, сбор по строкам с готовым адресом не останавливался.`,
    };
    return result;
  };
  const checkpoint: NonNullable<VeCollectInfo['target_checkpoint']> = {
    completed_round: progress.round,
    seen_rows: [...seen.values()],
    processed_rows: validationRetry ? prior?.processed_rows ?? args.rows.length : (prior?.processed_rows ?? 0) + args.rows.length,
    prior_low_relevance: validationRetry ? prior?.prior_low_relevance ?? 0 : prior?.low_relevance ?? 0,
    prior_relevance_unchecked: validationRetry ? prior?.prior_relevance_unchecked ?? 0 : prior?.relevance_unchecked ?? 0,
    low_relevance: info.relevance_summary.irrelevant,
    // Сводный счётчик «без подтверждённой релевантности»: слагаемых стало три,
    // но само число прежнее — непроверенные строки раньше сидели внутри error.
    relevance_unchecked: info.relevance_summary.needs_review + info.relevance_summary.error
      + info.relevance_summary.unchecked,
  };
  const stats: NonNullable<VeCollectInfo['stats']> = {
    ...args.stats, rows_total: progress.candidates_processed + (validationRetry ? 0 : args.candidates.length),
    processed_rows: checkpoint.processed_rows,
    low_relevance: checkpoint.low_relevance, relevance_unchecked: checkpoint.relevance_unchecked,
    relevance_needs_review: info.relevance_summary.needs_review, relevance_errors: info.relevance_summary.error,
  };
  // Persist validated contacts + round counters BEFORE the first name call.
  // Interrupted cleanup resumes this phase, not sources/constructor/relevance.
  const pendingRows = contactRows.map((row) => VE_COMPANY_NAME_FIELD in row && isCompanyNameReady(row) ? row : {
    ...row, [VE_COMPANY_NAME_FIELD]: { version: 1, ...companyNameSource(row), status: 'failed', value: '' },
  });
  info.company_name_recovery = {
    has_buffered_candidates: args.hasBufferedCandidates, validation_error: args.validationError,
    round_low_relevance: args.stats.low_relevance ?? 0,
    round_relevance_unchecked: args.stats.relevance_unchecked ?? 0,
  };
  const nameCompanies = new Map(contactRows.map((row) => [JSON.stringify([companyNameSource(row), String(row.inn ?? '').replace(/\D/g, '')]), row]));
  const namesChecked = [...nameCompanies.values()].filter((row) => VE_COMPANY_NAME_FIELD in row && isCompanyNameReady(row)).length;
  info.company_name_cleanup = { status: 'partial', companies: nameCompanies.size, checked: namesChecked, failed: nameCompanies.size - namesChecked,
    error: 'Очистка названий завершилась не полностью' };
  const pendingReady = prepareSegmentationAudience({ rows: pendingRows, columns, source: 'auto' }).rows;
  const pendingCount = countVeTargetContacts(pendingReady, { limit: contactLimit, mode: progress.mode });
  info.target_progress = withVeTargetComposition(finish(pendingCount.counted, 'Очистка названий завершилась не полностью'),
    pendingCount, pendingReady.length);
  info.target_checkpoint = checkpoint;
  info.stats = stats;
  await persistCollectInfo(ctx, base.id, info, {
    data: pendingRows, columns,
    sample_rows: pendingReady.slice(0, SAMPLE_ROWS),
    row_count: pendingRows.length,
  });
  ctx.signal?.throwIfAborted();
  const cleaned = await cleanCollectedCompanyNames(ctx, job, info, pendingRows, args.usage);
  const readyRows = prepareSegmentationAudience({ rows: cleaned.rows, columns, source: 'auto' }).rows;
  // Цель считает охват компаний. Без лимита специалиста в неё идут не больше
  // трёх адресов одной компании; сама база при этом хранит все адреса.
  const targetCount = countVeTargetContacts(readyRows, { limit: contactLimit, mode: progress.mode });
  const targetRows = targetCount.counted;
  const nameRetry = job.result?.company_name_retry as { context?: unknown; attempts?: unknown } | undefined;
  const nameAttempts = nameRetry?.context === cleaned.checkpoint.context
    ? Number.isSafeInteger(nameRetry.attempts) && Number(nameRetry.attempts) >= 0 ? Number(nameRetry.attempts) : 3
    : 0;
  if (cleaned.summary.retryable && nameAttempts < 3) {
    // Resume only missing names. Preserve paid classification/SMTP and the
    // successful name batches, with a durable cap across worker restarts.
    info.target_progress = withVeTargetComposition({ ...progress, status: 'collecting', ready_rows: targetRows,
      candidates_processed: stats.rows_total }, targetCount, readyRows.length);
    delete info.target_progress.reason;
    await persistCollectInfo(ctx, base.id, info, {
      data: cleaned.rows, columns, row_count: cleaned.rows.length, sample_rows: readyRows.slice(0, SAMPLE_ROWS),
    });
    ctx.signal?.throwIfAborted();
    const nextNameAttempts = nameAttempts + Number(!cleaned.rateLimit?.deferred);
    const result = { ...job.result, company_name_retry: { context: cleaned.checkpoint.context, attempts: nextNameAttempts } };
    const now = Date.now();
    const { data: saved, error } = await ctx.supabase.from('ve_jobs').update({ result,
      status: 'pending', started_at: null, error: 'Подготовка названий временно недоступна; повтор по сохранённым результатам.',
      run_after: new Date(now + Math.max(cleaned.rateLimit?.deferred ? 0 : 30_000 * 2 ** nameAttempts,
        cleaned.rateLimit ? veRateLimitDelay(cleaned.rateLimit, job.id, now) : 0)).toISOString(), updated_at: new Date(now).toISOString(),
    }).eq('id', job.id).eq('status', 'running').select('id').maybeSingle();
    if (error || !saved) throw new VeRelevanceCheckpointError(error
      ? `Company name retry save: ${error.message}` : 'Company name retry lost job ownership');
    job.result = result;
    stageLog(ctx, `[company_names] временный сбой; отложен повтор ${nextNameAttempts}/3 только незавершённых названий`);
    throw new VeRelevanceRetryScheduled(base.id, { ...args.usage });
  }
  if (pipeline && cleaned.summary.status === 'complete') {
    if (readyRows.length > 0 && !pipeline.first_ready_at) pipeline.first_ready_at = new Date().toISOString();
    if (targetRows >= progress.ready_target && !pipeline.target_reached_at) pipeline.target_reached_at = new Date().toISOString();
  }
  let next = finish(targetRows, cleaned.summary.error);
  const reviewablePending = reserveRows.some((row) => isVeAcceptedEmailStatus(row._email_status)
    && (row._ve_relevance as { status?: unknown } | undefined)?.status === 'needs_review');
  const pendingAutomaticEmails = hasPendingVeSavedEmailRecovery(reserveRows, info.saved_email_recovery);
  const emailValidationCanContinue = pendingAutomaticEmails && args.validationError === 'Проверка email завершилась не полностью';
  const reviewEligible = !reviewOnly && (!args.validationError || emailValidationCanContinue) && !taskError
    && targetRows < progress.ready_target;
  const triageEnabled = isVeRelevanceTriageEnabled(job.project_id);
  const automaticBatch = reviewEligible ? buildVeRelevanceReviewBatch({
    reserve: reserveRows, ready: cleaned.rows, source: readVeRelevanceSourceRows(info.relevance_reserve), automatic: true,
    allowPaidSearch: !existingFirst, triage: triageEnabled,
  }) : null;
  // A saved-review pass that leaves its own selection byte-identical cannot
  // progress: every verdict came from the checkpoint and no row changed. Stop
  // requesting that pass instead of requeueing every 30 seconds (19.09.2026:
  // one base looped 3000 times on one company). The rows stay in the reserve.
  // Отпечаток снимается только с отбора (veSavedReviewSignature): число готовых
  // контактов и сырой статус валидации сюда больше не входят. Они менялись от
  // дочерней валидации почт и от пересчёта лимита на компанию и обнуляли
  // детектор на каждом раунде — цикл жил на этой ряби, а не на работе.
  // Форма отпечатка изменилась, поэтому после раскатки каждая база делает ровно
  // один лишний проход и только потом снова защёлкивается.
  const reviewSignature = automaticBatch?.rows.length
    ? relevanceHash(veSavedReviewSignature(automaticBatch.rows, { triage: triageEnabled }))
    : null;
  const stalledReview = reviewSignature !== null && info.relevance_review_progress?.signature === reviewSignature;
  if (reviewSignature === null) delete info.relevance_review_progress;
  else info.relevance_review_progress = { signature: reviewSignature,
    passes: stalledReview ? (info.relevance_review_progress?.passes ?? 0) + 1 : 0 };
  if (stalledReview) stageLog(ctx, `[base_collect] уточнение сохранённых контактов не продвигается: ${automaticBatch?.companies ?? 0} компаний повторно получают тот же сохранённый итог; они остаются в резерве, раунд завершается`);
  const pendingAutomaticReview = reviewEligible
    && (pendingAutomaticEmails || (Boolean(automaticBatch?.rows.length) && !stalledReview));
  const pendingManualReview = args.continueManualReview === true
    && reserveRows.some((row) => needsVeRelevanceReview(row) || needsVeSavedEmailReview(row));
  const drainingSavedEmailChild = Boolean(info.saved_email_recovery?.batch) && !args.validationError && !taskError;
  let continueSavedReview = cleaned.summary.status === 'complete'
    && (pendingAutomaticReview || pendingManualReview || drainingSavedEmailChild);
  if (continueSavedReview) {
    // Same acquisition round, same candidates: the next job wake only improves
    // already paid-for contacts. This marker is saved atomically with rows.
    next = { ...progress, ready_rows: targetRows, candidates_processed: stats.rows_total, status: 'collecting' };
    delete next.reason;
    info.relevance_review_requested = true;
  } else {
    delete info.relevance_review_requested;
    if (reviewOnly && !args.validationError && cleaned.summary.status === 'complete'
      && targetRows < progress.ready_target && reviewablePending) {
      next = { ...progress, ready_rows: targetRows, candidates_processed: stats.rows_total, status: 'limited',
        reason: 'Уточнение сохранённых контактов завершено. Неопределённые контакты остались в резерве; новый сбор в этой операции не запускается.' };
    }
  }
  // Only after existing stock and in-flight work are drained may a deficit buy
  // search. This transition is durable together with ready rows and counters.
  // An outage is not stock exhaustion; never switch phases to hide an error.
  const consumedExisting = buildBaseExclusionKeysFromRows([...seen.values()]);
  const existingBuffered = tasks.some((task) => task.status === 'done' && (task.harvest ?? []).some((row) =>
    hasExistingSourceContact(row) && pruneBaseRowAgainstExclusion(freshKeys, row) !== null
      && !baseRowMatchesExclusion(consumedExisting, row)));
  // Предел берём у итога раунда: холостой раунд его сдвигает (finishCollectionRound).
  const acquisitionLimited = stats.rows_total >= progress.max_candidates || progress.round >= next.max_rounds;
  if (existingFirst && !reviewOnly && !continueSavedReview && !args.validationError && !taskError && !pipeline?.error
    && cleaned.summary.status === 'complete' && targetRows < progress.ready_target
    && !pendingSources && !pendingBatches.length && (acquisitionLimited || (!renewableDirectory && !existingBuffered))) {
    info.search_policy!.phase = 'paid';
    const canAcquirePaid = stats.rows_total < progress.max_candidates && progress.round < next.max_rounds
      && (tasks.some((task) => task.existing_contacts_only)
        || hasPendingVeSourceContacts(info.search_policy!.deferred_rows, info.source_contact_recovery));
    // The directory's previous exhaustion referred to its site/email lanes,
    // not to the full original audience. Other sources keep their cursor.
    for (const task of tasks) if (canAcquirePaid && task.existing_contacts_only) {
      task.status = 'pending'; task.exhausted = false; task.hit_ceiling = false; delete task.note;
      delete task.existing_contacts_only;
      // Счётчик отбраковки остаётся от лейнов бесплатной фазы. В платной
      // задача читает другой срез с собственной нумерацией, и эти тысячи
      // «выброшено» ни к нему не относятся, ни закладку по ним досеять нельзя:
      // строки чужого лейна не покрывают строки нового.
      delete task.excluded_during_fetch;
      delete task.already_seen_during_fetch;
    }
    const saved = buildVeRelevanceReviewBatch({ reserve: reserveRows, ready: cleaned.rows,
      source: readVeRelevanceSourceRows(info.relevance_reserve), automatic: true, triage: triageEnabled });
    continueSavedReview = saved.rows.length > 0;
    if (continueSavedReview) info.relevance_review_requested = true;
    if (continueSavedReview || canAcquirePaid) {
      next = { ...next, status: 'collecting', round: continueSavedReview ? progress.round : progress.round + 1 };
      delete next.reason;
    }
    stageLog(ctx, `[base_collect] имеющиеся данные проверены: ${targetRows}/${progress.ready_target} готовых контактов; дополнительный поиск включён только для недостающего объёма`);
  }
  let widenedSliceDry = false;
  if (info.adaptive_collection?.pending && !continueSavedReview && !args.validationError && !taskError
    && cleaned.summary.status === 'complete' && !pipeline?.error && pendingBatches.length === 0) {
    const finishedAt = new Date().toISOString();
    const batchSource = info.adaptive_collection.pending.source_key;
    const spend = await readVeBatchSpend(ctx.supabase, job.project_id, base.id, info.adaptive_collection.pending.started_at, finishedAt);
    // Measure the source BEFORE the per-company limit: its thresholds (5 % yield,
    // $0.05 per contact) were calibrated on uncapped counts, so judging a capped
    // batch by them would call every normal source weak and buy a replan.
    // Сухость источника меряется в единицах цели: targetCount.perCompany — тот же K, что у счётчика цели.
    info.adaptive_collection = finishVeAdaptiveBatch(info.adaptive_collection, [...readyRows, ...overCapRows], spend, finishedAt,
      targetCount.perCompany);
    const policy = info.adaptive_collection;
    // Расширенный срез — последняя автоматическая попытка. Если и он дал две
    // плохие партии, а живого источника кроме него нет, база завершается сама,
    // а не перебирает срезы за счёт проверок.
    widenedSliceDry = policy.replan_needed === true && !reviewOnly && targetRows < progress.ready_target
      && tasks.some((task) => task.task.widened && veSourceStrategyKey(task.task) === batchSource)
      && !tasks.some((task) => veSourceStrategyKey(task.task) !== batchSource && veTaskCanSupply(task)
        && !veAdaptiveLowYield(policy.completed, veSourceStrategyKey(task.task))
        && !veAdaptiveSourceDry(policy.completed, veSourceStrategyKey(task.task)));
    if (widenedSliceDry) {
      const windows = veAdaptiveYieldWindows(policy.completed, batchSource);
      const companies = windows.reduce((sum, window) => sum + window.candidates, 0);
      const contacts = windows.reduce((sum, window) => sum + window.new_ready, 0);
      policy.replan_needed = false; delete policy.replan_reason;
      policy.note = 'Расширенный срез дал низкий выход двух партий подряд: сбор остановлен.';
      next = { ...next, round: progress.round, status: 'limited',
        reason: `Расширенный срез тоже дал низкий выход: последние ${companies} компаний дали ${contacts} новых готовых контактов. `
          + `Сбор остановлен, чтобы не тратить проверки впустую. Собрано ${targetRows} из ${progress.ready_target}.` };
    } else if (policy.replan_needed && !reviewOnly && targetRows < progress.ready_target
      && !acquisitionLimited && policy.replan_attempts < 2) {
      next = { ...next, status: 'collecting', round: progress.round + 1 }; delete next.reason;
    }
  }
  stats.launchable_rows = readyRows.length;
  next = withVeTargetComposition(next, targetCount, readyRows.length);
  info.target_progress = next;
  if (cleaned.summary.status === 'complete') {
    delete info.company_name_recovery;
    if (pipeline?.active_batch_id) {
      pipeline.batches = pipeline.batches.filter((batch) => batch.id !== pipeline.active_batch_id);
      pipeline.completed_batches = (pipeline.completed_batches ?? 0) + 1;
      delete pipeline.active_batch_id;
    }
  }
  delete info.validation_retry;
  if (info.plan && needsDirectoryEstimateRefresh(info.plan, info.estimate)) {
    // A long-running batch can outlive its initial source snapshot. Refresh only
    // at a worker checkpoint, never as a side effect of an interface read.
    await refreshPlanPopulation(ctx, base, info, freshKeys);
  }
  // Правило узкого рынка уже расширило срез или завершило базу в этом раунде.
  let marketDecided = false;
  if (info.estimate) {
    const sourceRows = readVeRelevanceSourceRows(info.relevance_reserve);
    const candidateCompanies = new Set(sourceRows.map(veRelevanceCompanyKey));
    // Компании реестра — строки с ИНН: остальные источники ИНН не отдают. Они
    // уже вычтены из остатка среза; компании карт и вакансий в нём не лежат.
    const sourceCompanies = new Set(sourceRows.map((row) => normalizeVeCompanyInn(cell(row.inn))).filter(Boolean)).size;
    const readyCompanies = targetCount.companies;
    const asOf = new Date().toISOString();
    info.estimate = updateCollectionEstimate(info.estimate, {
      // Выход — в единицах цели: лишние адреса тех же компаний рынок не расширяют.
      candidates: candidateCompanies.size, sourceCandidates: sourceCompanies, ready: targetRows, readyCompanies, asOf,
      // Незавершённая партия оценку больше не отменяет: база почти всегда
      // заканчивается на оборванной, и числа не было ни у одной. Флаг только
      // помечает, что выход может быть занижен неразобранным остатком.
      complete: !args.validationError && !taskError && !continueSavedReview
        && info.relevance_summary.needs_review === 0 && info.relevance_summary.error === 0
        && info.relevance_summary.unchecked === 0
        && info.relevance_summary.email_retryable === 0 && cleaned.summary.status === 'complete',
    });
    // Рынок гипотезы меньше цели. Раньше движок всё равно шёл к 500: каждый
    // следующий раунд просил БОЛЬШЕ компаний (collectionRoundLimit делит
    // недостачу на наблюдаемый выход), и узкая гипотеза упиралась в потолок
    // 10 000 компаний — а это чтение сайтов и SMTP-проверки за каждую из них.
    // Прогноз тот же, что в карточке, но на выборке не меньше 300 компаний.
    const forecast = estimateRemainingReady({
      population: veEstimatePopulation(info.estimate), candidatesProcessed: candidateCompanies.size,
      processedInPopulation: sourceCompanies, readyRows: targetRows, readyCompanies, asOf,
      eligible: candidateCompanies.size >= VE_NARROW_MARKET_MIN_COMPANIES,
    });
    const projected = forecast?.contacts ?? null;
    // Размер известен только у реестра. Пока жив источник без размера
    // (каталог карт), прогноз по реестру не говорит, что рынок кончился.
    // Сухой источник (veAdaptiveSourceDry) живым не считается.
    const unsizedLive = tasks.some((task) => task.source !== 'companies_directory' && veTaskCanSupply(task)
      && !(info.adaptive_collection && veAdaptiveSourceDry(info.adaptive_collection.completed, veSourceStrategyKey(task.task))));
    // Останавливаем только раунд, за которым не осталось уже оплаченной работы:
    // недокачанный дочерний конструктор или неразобранный запас дороже одного
    // лишнего раунда, а на следующем пробуждении оценка повторится.
    if (projected !== null && next.status === 'collecting' && !reviewOnly && !continueSavedReview
      && progress.round >= 2 && pendingBatches.length === 0 && !pendingSources && !pendingDiscovery
      && !args.hasBufferedCandidates && !info.adaptive_collection?.pending && !unsizedLive
      && targetRows + projected < VE_NARROW_MARKET_MIN_PROJECTED) {
      // Мал текущий срез, а не обязательно рынок: сначала то же расширение,
      // что и при исчерпанном плане (вторая очередь, затем новый срез).
      // Останавливаем, только когда расширять больше нечем.
      marketDecided = true;
      if (!acquisitionLimited && await widenExhaustedPlan(ctx, base, info, tasks, 'narrow_market')) {
        stageLog(ctx, `[base_collect] срез мал: прогноз ${projected} сверх ${targetRows}; срез расширен автоматически (${info.adaptive_collection?.widenings}/${VE_PLAN_WIDENING_LIMIT})`);
      } else {
        const widenings = info.adaptive_collection?.widenings ?? 0;
        next = { ...next, round: progress.round, status: 'limited',
          reason: `Рынок гипотезы исчерпан: по реестру осталось примерно ${projected} контактов`
            + `${forecast?.companies !== undefined ? ` (≈${forecast.companies} компаний)` : ''} сверх собранных ${targetRows}, `
            + `то есть база не наберёт и ${VE_NARROW_MARKET_MIN_PROJECTED}. `
            + (widenings ? `Срез уже расширялся автоматически (${widenings} из ${VE_PLAN_WIDENING_LIMIT}), дальше расширять некуда. `
              : 'Расширить срез автоматически нечем. ')
            + 'Сбор завершён, чтобы не тратить проверки впустую; собранные контакты сохранены.' };
        // Локальная переменная уже скопирована в info выше: без этой записи
        // статус и причина не сохранились бы, а «Продолжить подготовку» не
        // увидела бы базу (там требуется терминальный статус раунда).
        info.target_progress = next;
        stageLog(ctx, `[base_collect] остановка по размеру рынка: собрано ${targetRows}, прогноз остатка ${projected}, цель ${progress.ready_target}`);
      }
    }
  }
  // Сухие источники (решение владельца 23.09.2026). Размер каталога карт в
  // прогноз не входит, поэтому правило узкого рынка молчит, пока жива задача
  // карт — даже когда тысячи компаний из неё дают единицы контактов (Когнитус:
  // школы 3 376 компаний карт → 4 контакта, РАС 4 275 компаний реестра → 2).
  // Здесь решает фактический выход каждого источника: когда все живые
  // источники сухие, база сначала расширяет срез (как при исчерпанном плане),
  // а когда расширять нечем — честно завершается.
  let drySourcesStop = false;
  const adaptive = info.adaptive_collection;
  const emptyRound = next.status === 'limited' && args.candidates.length === 0 && !acquisitionLimited && !discoveryPaused;
  if (adaptive && !adaptive.pending && !widenedSliceDry && !marketDecided && !reviewOnly && !continueSavedReview
    && !args.validationError && !taskError && !pipeline?.error && cleaned.summary.status === 'complete'
    && pendingBatches.length === 0 && targetRows < progress.ready_target
    && !(adaptive.replan_needed && adaptive.replan_reason === 'plan_exhausted')
    && (next.status === 'collecting' || emptyRound)) {
    // Живой источник — задача, которая ещё может читать, или непросмотренные
    // строки в её выдаче. Исчерпанные источники в решение не входят.
    const liveKeys = tasks.filter((task) => task.status !== 'failed' && (veTaskCanSupply(task)
      || (task.harvest ?? []).some((row) => pruneBaseRowAgainstExclusion(freshKeys, row) !== null
        && !baseRowMatchesExclusion(consumedExisting, row))))
      .map((task) => veSourceStrategyKey(task.task));
    const dry = veDryLiveSources(adaptive.completed, liveKeys);
    if (dry) {
      const summary = veDrySourcesSummary(dry);
      // Низкий выход партии больше не повод для отдельного подбора среза:
      // все источники сухие, дальше решает расширение.
      if (adaptive.replan_needed) { adaptive.replan_needed = false; delete adaptive.replan_reason; }
      if (!acquisitionLimited && await widenExhaustedPlan(ctx, base, info, tasks, 'dry_sources')) {
        stageLog(ctx, `[base_collect] источники сухие (${summary}); срез расширен автоматически (${info.adaptive_collection?.widenings}/${VE_PLAN_WIDENING_LIMIT})`);
        if (next.status !== 'collecting') {
          next = { ...next, status: 'collecting', round: progress.round + 1 };
          delete next.reason;
        }
      } else {
        drySourcesStop = true;
        const widenings = adaptive.widenings ?? 0;
        adaptive.note = 'Источники перестали давать контакты: сбор остановлен.';
        next = { ...next, round: progress.round, status: 'limited',
          reason: `Источники перестали давать контакты: ${summary}. `
            + (widenings ? `Срез уже расширялся автоматически (${widenings} из ${VE_PLAN_WIDENING_LIMIT}), дальше расширять некуда. `
              : 'Расширить срез автоматически нечем. ')
            + `Сбор завершён, чтобы не тратить проверки впустую; собрано ${targetRows} из ${progress.ready_target}, контакты сохранены.` };
        stageLog(ctx, `[base_collect] остановка по сухим источникам: ${summary}; собрано ${targetRows}/${progress.ready_target}`);
      }
      info.target_progress = next;
    }
  }
  // План кончился раньше цели — это повод расширить срез, а не остановка:
  // сначала вторая очередь тех же ОКВЭД без придуманных порогов размера, затем
  // один подбор нового среза. Не больше двух раз на базу; при повторном
  // исчерпании база завершается с честной причиной.
  // Состояние задач читаем заново: переход к платной фазе выше мог их открыть.
  const sourcesRanOut = !reviewOnly && !args.hasBufferedCandidates && !pendingDiscovery
    && pendingBatches.length === 0 && !tasks.some(veTaskCanSupply);
  if (!widenedSliceDry && !drySourcesStop && sourcesRanOut && (next.status === 'exhausted' || next.status === 'limited')
    && !continueSavedReview && !args.validationError && !taskError && !pipeline?.error
    && cleaned.summary.status === 'complete' && !acquisitionLimited
    && targetRows < progress.ready_target && tasks.length > 0) {
    if (await widenExhaustedPlan(ctx, base, info, tasks)) {
      stageLog(ctx, `[base_collect] план исчерпан на ${targetRows}/${progress.ready_target}: срез расширен автоматически (${info.adaptive_collection?.widenings}/${VE_PLAN_WIDENING_LIMIT})`);
      next = { ...next, status: 'collecting', round: progress.round + 1 };
      delete next.reason;
    } else if (info.adaptive_collection?.widenings) {
      next = { ...next, reason: `${next.reason ?? 'Источники плана исчерпаны'}. Срез уже расширялся автоматически `
        + `(${info.adaptive_collection.widenings} из ${VE_PLAN_WIDENING_LIMIT}): новых подходящих компаний не нашлось, дальше сбор сам не расширяется.` };
    }
    // info уже держит прежний объект раунда (см. остановку по размеру рынка выше).
    info.target_progress = next;
  }
  if (next.status === 'collecting' && !continueSavedReview) {
    // One atomic checkpoint: prior validated output is durable BEFORE the next
    // input round becomes pending. Resuming must never revalidate these rows.
    delete info.construct;
    if (info.search_policy) delete info.search_policy.construct_rows;
    delete stats.finished_at;
    info.tasks = pipeline || info.adaptive_collection ? tasks : tasks.map((state) =>
      ((state.source === 'companies_directory' || !!state.catalog) && !state.exhausted && !state.hit_ceiling)
        || isVeLegacyMapsTask(state)
        // Закладку выдачи переносим вместе с задачей. Без неё следующий раунд
        // читает реестр с первой страницы и заново просматривает уже
        // просмотренные компании — ровно то, против чего закладка и вводилась.
        ? reopenVeSourceTask(state)
        : state,
    );
    info.limit = collectionRoundLimit(next);
  } else if (next.status !== 'collecting') {
    stats.finished_at = new Date().toISOString();
  }
  info.stats = stats;
  // Раунд, не сдвинувший ни раунд, ни кандидатов, ни готовые контакты, будет
  // ждать вдвое дольше предыдущего. Счётчик едет в том же checkpoint'е, что и
  // строки: отдельной записи он не стоит, а после рестарта воркера пауза не
  // сбрасывается в секунду.
  const roundAdvanced = veRoundAdvanced(args.progress, next);
  info.idle_rounds = veNextIdleRounds(roundAdvanced, info.idle_rounds);
  const idleRounds = info.idle_rounds;
  const status = next.status === 'collecting' ? 'collecting'
    : next.status === 'error' ? 'failed'
      : next.mode === 'preview' && readyRows.length > 0 ? 'analyzing' : 'analyzed';
  await persistCollectInfo(ctx, base.id, info, {
    data: cleaned.rows, columns, sample_rows: readyRows.slice(0, SAMPLE_ROWS), row_count: cleaned.rows.length,
    status, error: next.status === 'error' ? next.reason?.slice(0, 500) : null,
  });
  if (limitChanged) {
    // Plain column for the settings route: which finished bases still need a
    // changed limit applied. Best effort: the partition above is already durable.
    try { await ctx.supabase.from('ve_bases').update({ contact_cap_applied: contactLimit }).eq('id', base.id); } catch { /* next round retries */ }
  }
  if (next.status === 'collecting') {
    await requeueSelf(ctx, job, veIdleRequeueMs(pipeline ? 1_000 : VE_ROUND_REQUEUE_MS, idleRounds));
  } else if (status === 'analyzing') await ensureTargetBaseAnalysis(ctx, job, base.id);
  return {
    result: { base_id: base.id, rows: readyRows.length, target_status: next.status, ...(next.status === 'collecting' ? { waiting: true } : {}) },
    tokensUsed: args.usage.tokensUsed, costUsd: args.usage.costUsd,
  };
}

async function runBaseCollectStageImpl(job: VeJob, ctx: VeStageContext): Promise<VeStageResult> {
  const usage = newUsage();
  const baseId = payloadString(job, 'base_id');
  // Лимит сборки из payload (route кладёт туда выбор пользователя): один на
  // всё — пагинация реестра, чтение дочерних джоб, итоговый кап базы.
  let limit = totalRowsCap(job);
  // Refill-режим ENG auto-pipeline: финал — долив в запущенную кампанию
  // (stages/baseCollectRefill.ts), а не analyzing + base_analyze.
  const isRefill = job.payload?.refill === true;

  // ─── ВХОД: сначала узкое чтение ───
  // Тяжёлое в строке — collect_info (16-62 МБ на активную базу), data и
  // sample_rows. Решения «это не авто-база», «сборка уже завершена» и «сборка
  // не начиналась» принимаются по статусу и режиму, а их узкая проекция стоит
  // килобайты. Полную строку читаем ниже — ровно тогда, когда работа есть.
  const { data: probeRow, error: probeError } = await ctx.supabase
    .from('ve_bases')
    .select(VE_BASE_COLLECT_PROBE_COLUMNS)
    .eq('id', baseId)
    .single();
  if (probeError || !probeRow) throw new Error(`ve_bases ${baseId}: ${probeError?.message ?? 'not found'}`);
  const probe = probeRow as VeBaseCollectProbe;
  if (probe.source !== 'auto') {
    throw new Error(`ve_bases ${baseId}: source='${probe.source ?? 'upload'}' — base_collect работает только с source='auto'`);
  }
  // Завершённую сборку не переигрываем. Честный провал (напр. ноль строк) ставит
  // базе терминальный статус И роняет джобу, а воркер повторяет её до
  // MAX_ATTEMPTS — каждая повторная попытка спотыкалась об этот guard и затирала
  // настоящую причину своим сообщением. No-op сохраняет причину в ve_bases.error.
  // Пересчёт лимита адресов (reproject_contacts) идёт по полной строке: он
  // перекладывает сохранённые строки и обязан их видеть.
  if (veBaseCollectFinished(probe.status) && job.payload?.reproject_contacts !== true) {
    if (probe.status === 'analyzing' && veProbeCollectionMode(probe) === 'preview') {
      await ensureTargetBaseAnalysis(ctx, job, baseId);
    }
    stageLog(ctx, `[base_collect] база ${baseId} уже в статусе '${probe.status}' — повторная сборка не нужна`);
    return { result: { base_id: baseId, skipped: 'already_finished', base_status: probe.status } };
  }
  if (probe.status !== 'collecting' && job.payload?.reproject_contacts !== true) {
    throw new Error(`ve_bases ${baseId}: status='${probe.status}' — сборка не начиналась`);
  }

  const { data: baseRow, error: bError } = await ctx.supabase
    .from('ve_bases')
    .select('*')
    .eq('id', baseId)
    .single();
  if (bError || !baseRow) throw new Error(`ve_bases ${baseId}: ${bError?.message ?? 'not found'}`);
  const base = ((baseRow as VeAutoBase).collect_info?.preview_pipeline ? structuredClone(baseRow) : baseRow) as VeAutoBase;

  if (base.source !== 'auto') {
    throw new Error(`ve_bases ${baseId}: source='${base.source ?? 'upload'}' — base_collect работает только с source='auto'`);
  }
  // A tightened "addresses per company" limit for a base that has already
  // finished: a pure re-partition of saved rows, before the terminal-status
  // no-op below. It never collects, never pays and never changes base.status.
  if (job.payload?.reproject_contacts === true) return applyVeContactCapToFinishedBase(ctx, job, base);
  // Статус мог смениться между узким и полным чтением: терминальную базу
  // отдаём тем же no-op, а не роняем джобу на guard'е ниже.
  if (base.status === 'analyzing' || base.status === 'analyzed' || base.status === 'failed') {
    if (base.status === 'analyzing' && base.collect_info?.collection_mode === 'preview') {
      await ensureTargetBaseAnalysis(ctx, job, baseId);
    }
    stageLog(ctx, `[base_collect] база ${baseId} уже в статусе '${base.status}' — повторная сборка не нужна`);
    return { result: { base_id: baseId, skipped: 'already_finished', base_status: base.status } };
  }
  if (base.status !== 'collecting') {
    throw new Error(`ve_bases ${baseId}: status='${base.status}' — сборка не начиналась`);
  }
  const info: VeCollectInfo =
    base.collect_info && typeof base.collect_info === 'object' ? base.collect_info : {};
  if (info.adaptive_collection && !validVeAdaptiveCollection(info.adaptive_collection)) {
    throw new VeRelevanceCheckpointError('Invalid adaptive collection checkpoint');
  }
  if (info.preview_pipeline && !info.preview_pipeline.batches.length && !info.preview_pipeline.job_ids?.length
    && (info.construct?.bc_job_id || (info.target_progress?.candidates_processed ?? 0) > 0)) {
    // Rolling deploy: a previous worker may have started a newly enqueued
    // preview before understanding this marker. Keep its exact existing scope.
    const revision = info.preview_pipeline.revision;
    delete info.preview_pipeline;
    ctx.signal?.throwIfAborted();
    const { data: saved, error } = await ctx.supabase.from('ve_bases')
      .update({ collect_info: info, updated_at: new Date().toISOString() })
      .eq('id', baseId).eq('status', 'collecting')
      .eq('collect_info->preview_pipeline->>revision', String(revision)).select('id').maybeSingle();
    if (error) throw new VeRelevanceCheckpointError(`Preview compatibility checkpoint: ${error.message}`);
    if (!saved) throw new VePreviewCheckpointConflict('Preview compatibility checkpoint changed');
  }
  const mode = info.collection_mode ?? job.payload?.collection_mode;
  if (info.preview_pipeline && mode !== 'preview') throw new Error('Preview batches require preview mode');
  if (job.payload?.review_relevance === true) info.validation_retry = true;
  if (mode !== undefined && mode !== 'preview' && mode !== 'supply') throw new Error('Unknown collection_mode');
  let target: VeCollectionTargetProgress | null = null;
  if (mode === 'preview' || mode === 'supply') {
    if (isRefill || info.refill) throw new Error('Target collection cannot use legacy refill');
    if (!base.hypothesis_id || base.project_id !== job.project_id) throw new Error('Target collection requires a scoped hypothesis base');
    target = createCollectionTarget(mode, info.ready_target ?? job.payload?.ready_target as number | undefined);
    const previous = info.target_progress;
    // Холостые раунды и «Продолжить подготовку» двигают предел базы вверх.
    target.max_rounds = veCollectionMaxRounds(previous?.max_rounds);
    if (previous) {
      const firstRoundCandidates = previous.first_round_candidates ?? 2_000;
      if (!Number.isSafeInteger(previous.round) || previous.round < 1 || previous.round > target.max_rounds
        || !Number.isSafeInteger(previous.ready_target) || previous.ready_target < 1 || previous.ready_target > target.max_candidates
        || !Number.isSafeInteger(firstRoundCandidates) || firstRoundCandidates < 1 || firstRoundCandidates > 2_000
        || !Number.isSafeInteger(previous.candidates_processed) || previous.candidates_processed < 0 || previous.candidates_processed > target.max_candidates
        || !Number.isSafeInteger(previous.ready_rows) || previous.ready_rows < 0
        || (info.target_checkpoint?.completed_round ?? 0) !== previous.round - (info.validation_retry || info.company_name_recovery || info.relevance_review_requested ? 0 : 1)) {
        throw new Error('Invalid collection target checkpoint');
      }
      target.round = previous.round;
      target.candidates_processed = previous.candidates_processed;
      target.ready_rows = previous.ready_rows;
      // Состав готовой базы переживает раунд вместе со счётчиком цели.
      for (const field of ['ready_companies', 'ready_contacts', 'counted_per_company'] as const) {
        if (Number.isSafeInteger(previous[field]) && previous[field]! >= 0) target[field] = previous[field];
      }
      // A new preview default must not change the input scope of a constructor
      // already running for an older target (e.g. 1000 ready contacts).
      target.ready_target = previous.ready_target;
      target.first_round_candidates = firstRoundCandidates;
      if (Number.isSafeInteger(previous.idle_streak) && previous.idle_streak! > 0) target.idle_streak = previous.idle_streak;
    }
    info.collection_mode = mode;
    info.ready_target = target.ready_target;
    info.target_progress = target;
    limit = info.adaptive_collection ? veAdaptiveCandidateLimit(target) : collectionRoundLimit(target);
    if (info.preview_pipeline) limit = Math.min(PREVIEW_BATCH_SIZE * PREVIEW_IN_FLIGHT,
      target.max_candidates - target.candidates_processed,
      Math.max(VE_PREVIEW_FIRST_CANDIDATES * PREVIEW_IN_FLIGHT, limit));
    info.limit = limit;
    if (!info.search_policy) info.search_policy = { version: 1, phase: 'existing', deferred_rows: [] };
    if (info.search_policy.version !== 1 || !['existing', 'paid'].includes(info.search_policy.phase)
      || !Array.isArray(info.search_policy.deferred_rows)) throw new VeRelevanceCheckpointError('Invalid search policy checkpoint');
    if (!previous) await persistCollectInfo(ctx, baseId, info);
  }
  if (target && await holdInactiveSupply(ctx, job, base, info)) {
    return { result: { waiting: true, base_id: baseId, supply_held: true } };
  }
  const olderCollectingBaseId = await findOlderCollectingBase(ctx, job.project_id, base, info.supply_hold === true);
  if (olderCollectingBaseId) {
    // result при self-requeue не сохраняется воркером. Очередь должна быть
    // видна через саму базу, но большой collect_info не переписываем без нужды.
    if (info.waiting_for_base_id !== olderCollectingBaseId) {
      info.waiting_for_base_id = olderCollectingBaseId;
      await persistCollectInfo(ctx, baseId, info);
    }
    stageLog(
      ctx,
      `[base_collect] база ${baseId} ждёт старшую сборку проекта ${olderCollectingBaseId}, чтобы не дублировать контакты`,
    );
    await requeueSelf(ctx, job);
    return {
      result: { waiting: true, base_id: baseId, waiting_for_base_id: olderCollectingBaseId },
      tokensUsed: usage.tokensUsed,
      costUsd: usage.costUsd,
    };
  }
  if (info.waiting_for_base_id) {
    delete info.waiting_for_base_id;
    await persistCollectInfo(ctx, baseId, info);
  }
  if (info.supply_hold) {
    resumeHeldSupplyTimers(info);
    await persistCollectInfo(ctx, baseId, info);
  }
  await settleStaleConstruct(ctx, base, info, target);
  const namedOkved = await nameBareOkvedCodes(ctx, info);
  if (namedOkved) {
    await persistCollectInfo(ctx, baseId, info);
    stageLog(ctx, `[base_collect] ${namedOkved} сохранённых строк реестра получили название ОКВЭД вместо голого кода`);
  }

  const { data: verticalRow, error: vError } = await ctx.supabase
    .from('ve_verticals')
    .select('*')
    .eq('id', base.vertical_id)
    .single();
  if (vError || !verticalRow) {
    throw new Error(`ve_verticals ${base.vertical_id}: ${vError?.message ?? 'not found'}`);
  }
  const vertical = verticalRow as VeVertical;

  const project = await readProject(ctx.supabase, job.project_id);
  // Рынок проекта: выбор промпта планировщика (EN-источники при 'us').
  // ctx.market прокидывает воркер, фолбэк — колонка ve_projects.market.
  const market = ctx.market ?? projectMarket(project);
  ctx = { ...ctx, market };
  if (info.company_name_recovery) {
    if (!target) throw new Error('Company name recovery requires a collection target');
    return resumeSavedCompanyNames(ctx, job, base, info, target, usage);
  }
  if (job.payload?.review_relevance === true) {
    if (!target || mode !== 'preview') throw new Error('Saved relevance review requires a preview target');
    return reviewSavedRelevance(ctx, job, base, info, target, market, usage);
  }
  if (info.relevance_review_requested) {
    if (!target) throw new Error('Saved relevance review requires a collection target');
    await prefetchBufferedPreviewBatches({ ctx, base, info, project, target, market });
    return reviewSavedRelevance(ctx, job, base, info, target, market, usage);
  }
  if (info.validation_retry) {
    if (!target || mode !== 'preview') throw new Error('Validation recovery requires a preview target');
    return resumeSavedPreviewValidation(ctx, job, base, info, target, market, usage);
  }

  if (target && !info.adaptive_collection && !info.construct && !info.preview_pipeline?.batches.length
    && !info.tasks?.some((task) => task.status === 'dispatched')
    && (target.mode === 'supply' || target.first_round_candidates === VE_PREVIEW_FIRST_CANDIDATES || target.candidates_processed > 0)) {
    info.adaptive_collection = newVeAdaptiveCollection();
    target.max_rounds = Math.max(target.max_rounds, PREVIEW_MAX_BATCHES);
    await persistCollectInfo(ctx, baseId, info);
  }

  // ─── PLAN ───
  if (target && info.adaptive_collection && !info.construct && !info.adaptive_collection.pending) {
    limit = veAdaptiveCandidateLimit(target);
    info.limit = limit;
  }
  if (!info.plan) {
    const hypothesisId = payloadString(job, 'hypothesis_id');
    const { plan, planRepair, sliceProbe, usedHypotheses } = await buildPlan(
      job,
      ctx,
      vertical,
      usage,
      market,
      hypothesisId,
    );
    info.plan = plan;
    if (planRepair) info.plan_repair = planRepair;
    if (sliceProbe) info.slice_probe = sliceProbe;
    info.hypotheses = usedHypotheses;
    await refreshPlanPopulation(ctx, base, info);

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
      await persistCollectInfo(ctx, baseId, info, { status: 'failed', error: note.slice(0, 500) });
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
    stageLog(ctx, `[base_collect] план: ${info.tasks.length} задач (${info.tasks.map((t) => t.source).join(', ')})`);
  }
  if (target) await adaptCollectionSources(ctx, job, base, info, vertical, market, usage);

  // Базы, чей план был сохранён до появления estimate, получают его при
  // следующем безопасном тике, не переигрывая LLM-план и сбор источников.
  if (info.plan && needsDirectoryEstimateRefresh(info.plan, info.estimate)) {
    await refreshPlanPopulation(ctx, base, info);
    await persistCollectInfo(ctx, baseId, info);
  }
  const tasks = info.tasks ?? [];

  // Ключи компаний других баз проекта: нужны реестру ещё на DISPATCH
  // (исключение на выборке — продолжение больших сегментов) и повторно на
  // HARVEST (страховка для строк hh/карт). Лениво + мемоизация: на тиках
  // чистого ожидания дочерних парсеров лишнего чтения ve_bases нет.
  let excludedKeysCache: VeBaseExclusionKeys | null = null;
  const getExcludedKeys = async (): Promise<VeBaseExclusionKeys> => {
    if (!excludedKeysCache) {
      const otherBases = await loadOtherBaseExclusionKeys(ctx, job.project_id, baseId, target ? base.hypothesis_id : undefined);
      excludedKeysCache = target ? { ...copyExclusionKeys(otherBases), otherBases } : otherBases;
      if (target) {
        addRowsToExclusionKeys(excludedKeysCache, info.target_checkpoint?.seen_rows ?? []);
        addAcquisitionReceipts(excludedKeysCache, info.target_checkpoint?.seen_rows ?? [], info.tasks?.flatMap((task) => task.harvest ?? []) ?? []);
        addRowsToExclusionKeys(excludedKeysCache, Array.isArray(base.data) ? base.data : []);
      }
    }
    return excludedKeysCache;
  };

  retainDeferredSourceRows(info);
  const existingFirst = info.search_policy?.phase === 'existing';
  if ((info.preview_pipeline || info.adaptive_collection) && target) {
    const reservedKeys = buildBaseExclusionKeysFromRows(info.preview_pipeline?.batches.flatMap((batch) => batch.rows) ?? []);
    const consumedKeys = await getExcludedKeys();
    const canAcquire = !info.preview_pipeline?.error && !info.adaptive_collection?.pending && target.ready_rows < target.ready_target
      && target.candidates_processed + (info.preview_pipeline?.batches.reduce((sum, batch) => sum + batch.rows.length, 0) ?? 0) < target.max_candidates;
    // Retain buffered harvests. Only refill a directory when its previous
    // candidates have all been consumed/reserved, never drop its unused tail.
    for (const state of tasks) {
      if (canAcquire && (info.preview_pipeline?.batches.length ?? 0) < PREVIEW_IN_FLIGHT
        && isVeRenewableSourceTask(state)
        && !(state.harvest ?? []).some((row) => (!existingFirst || hasExistingSourceContact(row))
          && !baseRowMatchesExclusion(consumedKeys, row) && !baseRowMatchesExclusion(reservedKeys, row))) {
        if (isVeLegacyMapsTask(state)) {
          // Старая задача карт: её строки уже разобраны, дальше читаем каталог.
          if (state.child_job_id) state.legacy_child_job_id = state.child_job_id;
          state.child_job_id = null;
          state.harvest = []; state.rows = 0;
        }
        state.status = 'pending';
        if (state.catalog) { state.harvest = []; state.rows = 0; }
      }
    }
  }

  // ─── DISPATCH ───
  for (const state of tasks) {
    if (state.status !== 'pending' || info.adaptive_collection?.pending) continue;
    if (info.adaptive_collection?.active_source && veSourceStrategyKey(state.task) !== info.adaptive_collection.active_source) continue;
    if (info.preview_pipeline && target && (info.preview_pipeline.error || target.ready_rows >= target.ready_target)) continue;
    try {
      const sourceExclusions = async () => {
        const keys = await getExcludedKeys();
        if (!info.preview_pipeline) return keys;
        // A separate set keeps reserved rows available to the import path.
        return addRowsToExclusionKeys(copyExclusionKeys(keys), info.preview_pipeline.batches.flatMap((batch) => batch.rows));
      };
      // Расширенный срез берёт только компании с готовой почтой или сайтом:
      // остальные потребовали бы платного поиска сайта ради второй очереди.
      await dispatchTask(ctx, state, project, limit, sourceExclusions, usage,
        () => persistCollectInfo(ctx, baseId, info), existingFirst || Boolean(state.task.widened));
      stageLog(
        ctx,
        `[base_collect] dispatch ${state.source}: ${state.status}` +
          `${state.child_job_id ? ` (job ${state.child_job_id})` : ''}, строк: ${state.rows}`,
      );
    } catch (e) {
      ctx.signal?.throwIfAborted();
      if (e instanceof VeRelevanceCheckpointError || (e instanceof Error && e.name === 'VeWorkerShutdownError')) throw e;
      if (state.source === 'companies_directory' && isVeTransientDirectoryError(e)) throw e;
      state.status = 'failed';
      state.error = e instanceof Error ? e.message : String(e);
      stageLog(ctx, `[base_collect] dispatch ${state.source} упал: ${state.error}`);
    }
    await persistCollectInfo(ctx, baseId, info);
  }

  // ─── WAIT ───
  let polledTasks = false;
  for (const state of tasks) {
    if (state.status !== 'dispatched') continue;
    polledTasks = true;
    try {
      await pollTask(ctx, state, target?.max_candidates ?? limit);
    } catch (e) {
      state.status = 'failed';
      state.error = e instanceof Error ? e.message : String(e);
      stageLog(ctx, `[base_collect] poll ${state.source} упал: ${state.error}`);
    }
  }
  if (polledTasks) await persistCollectInfo(ctx, baseId, info);
  retainDeferredSourceRows(info);

  // Other pending sources are alternatives, not children we must await.
  const waiting = tasks.filter((t) => t.status === 'dispatched' || (t.status === 'pending'
    && (!info.adaptive_collection?.active_source || veSourceStrategyKey(t.task) === info.adaptive_collection.active_source)));
  if (waiting.length > 0 && !info.preview_pipeline) {
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
  const interleaved = dedupUnifiedRows(
    interleaveTaskHarvests(
      [...done.map((t) => taggedHarvest(t).filter((r) => normalizeCompanyForDedup(r.company) !== '')),
        ...(!existingFirst && info.search_policy ? [info.search_policy.deferred_rows] : [])],
    ),
  );

  // Исключаем компании/контакты, уже собранные в других базах этого проекта. Для
  // реестра это страховка (основное исключение прошло на выборке), для
  // hh/карт — единственная точка исключения.
  // Source pagination excludes consumed legal entities; publication instead
  // compares exact same-base observations. A newly recovered website/email is
  // new evidence even when the old unusable row already had an INN.
  const otherBaseKeys = await loadOtherBaseExclusionKeys(ctx, job.project_id, baseId, target ? base.hypothesis_id : undefined);
  // Свои строки добавляются в копию: счётчики ниже отделяют «заняты другими
  // базами» от «уже просмотрены этой базой».
  const existingKeys = target ? copyExclusionKeys(otherBaseKeys) : otherBaseKeys;
  // Do not buy website lookups for companies already excluded by another base.
  // Snapshot before adding same-base acquisition receipts: a previously seen
  // row may still legitimately recover its missing website in this base.
  // Расширенному срезу поиск сайта не покупаем: строка с одной почтой из него
  // идёт как есть, как в бесплатной фазе.
  const widenedSources = new Set(tasks.filter((task) => task.task.widened).map((task) => veSourceStrategyKey(task.task)));
  const discoveryCandidates = interleaved.filter((row) => !widenedSources.has(candidateSourceKey(row) ?? '')
    && pruneBaseRowAgainstExclusion(existingKeys, row) !== null);
  if (target) {
    addAcquisitionReceipts(existingKeys, info.target_checkpoint?.seen_rows ?? [], interleaved);
    addRowsToExclusionKeys(existingKeys, Array.isArray(base.data) ? base.data : []);
  }
  // An existing constructor owns immutable inputs. New batches prefer rows
  // already carrying a site; search missing sites only when that stock runs low.
  // Pipelined children own rows in batches[]. A display/current child must not
  // bypass discovery admission for unrelated candidates in the next child.
  const ownsLegacyInput = !!info.construct && !info.preview_pipeline;
  let prepared = ownsLegacyInput ? interleaved : applyVeSourceContacts(interleaved, info.source_contact_recovery);
  if (target && !ownsLegacyInput && !info.adaptive_collection?.pending) {
    const hints = await readVeCandidateHints(prepared, ctx.supabase, ctx.signal);
    // Enrich without reordering here: discovery indexes still refer to interleaved.
    const replacements = new Map<string, string>();
    const enrichedRows = prioritizeVeCandidates(prepared, hints, '', Date.now(), true);
    prepared = prepared.map((row, index) => {
      const enriched = enrichedRows[index];
      if (!row.website && enriched.website) replacements.set(veAcquisitionReceipt(row), enriched.website);
      return enriched;
    });
    if (replacements.size) {
      const enrich = (row: VeUnifiedRow) => {
        const website = replacements.get(veAcquisitionReceipt(row));
        return website ? { ...row, website } : row;
      };
      for (const task of tasks) if (task.harvest) task.harvest = task.harvest.map(enrich);
      if (info.search_policy) info.search_policy.deferred_rows = info.search_policy.deferred_rows.map(enrich);
      await persistCollectInfo(ctx, baseId, info);
    }
  }
  let pendingSourceRows = new Set(pendingVeSourceContacts(discoveryCandidates, info.source_contact_recovery));
  if (!existingFirst && !info.construct && !info.preview_pipeline?.batches.length && waiting.length === 0
    && (!target || target.ready_rows < target.ready_target)) {
    const immediatelyUsable = prepared.filter((row) => (row.website || row.email)
      && pruneBaseRowAgainstExclusion(existingKeys, row) !== null).length;
    if (immediatelyUsable === 0) {
      // A company/site is not a ready contact. Evaluate yield only here, after
      // every usable row and constructor has had a chance to finish validation.
      const allowance = target ? evaluateVeSourceDiscoveryBudget({ budget: info.source_contact_budget,
        checkpoint: info.source_contact_recovery, discoveryContacts: countVeSourceDiscoveryContacts(base.data) }) : null;
      if (allowance) info.source_contact_budget = allowance.budget;
      const discovery = [...pendingSourceRows].slice(0, veSourceDiscoveryLimit({ readyTarget: target?.ready_target,
        readyRows: target?.ready_rows, candidatesProcessed: target?.candidates_processed, remaining: allowance?.remaining }));
      if (discovery.length) {
        info.source_contact_discovery = { checked: Object.keys(info.source_contact_recovery?.checked ?? {}).length, remaining: pendingSourceRows.size, contacts: countVeSourceDiscoveryContacts(base.data) };
        await persistCollectInfo(ctx, base.id, info);
        await recoverVeSourceContacts({ rows: discovery, state: info.source_contact_recovery, signal: ctx.signal,
          save: async (state) => { info.source_contact_recovery = state; await persistCollectInfo(ctx, base.id, info); ctx.onCheckpoint?.(); },
        });
        prepared = applyVeSourceContacts(interleaved, info.source_contact_recovery);
        pendingSourceRows = new Set(pendingVeSourceContacts(discoveryCandidates, info.source_contact_recovery));
        if (prepared.filter((row) => (row.website || row.email) && pruneBaseRowAgainstExclusion(existingKeys, row) !== null).length === 0) {
          if (target) info.source_contact_budget = evaluateVeSourceDiscoveryBudget({ budget: info.source_contact_budget,
            checkpoint: info.source_contact_recovery, discoveryContacts: countVeSourceDiscoveryContacts(base.data) }).budget;
          if (!info.source_contact_budget?.paused && hasPendingVeSourceContacts(discoveryCandidates, info.source_contact_recovery)) {
            await requeueSelf(ctx, job, 1_000);
            return { result: { base_id: baseId, waiting: true, source_contact_discovery: true }, ...usage };
          }
        }
      }
    }
  }
  delete info.source_contact_discovery;
  if (target && info.source_contact_recovery) target.max_rounds = Math.max(target.max_rounds, PREVIEW_MAX_BATCHES);
  const considered = prepared.filter((row, index) => ownsLegacyInput
    || ((existingFirst ? hasExistingSourceContact(row) : hasExistingSourceContact(row) || !pendingSourceRows.has(interleaved[index]))
      // An unsuccessful lookup must not move empty source rows into another
      // paid enrichment lane. Keep them in harvest/deferred storage instead.
      && (!info.source_contact_budget || hasExistingSourceContact(row))));
  let excludedExisting = 0, excludedAlreadySeen = 0;
  const kept = considered.flatMap((row) => {
    const pruned = pruneBaseRowAgainstExclusion(existingKeys, row);
    if (pruned) return [pruned];
    if (existingKeys === otherBaseKeys || pruneBaseRowAgainstExclusion(otherBaseKeys, row) === null) excludedExisting += 1;
    else excludedAlreadySeen += 1;
    return [];
  });
  if (excludedExisting > 0) {
    stageLog(ctx, `[base_collect] исключено ${excludedExisting} строк — компании уже есть в других базах проекта`);
  }
  if (excludedAlreadySeen > 0) {
    stageLog(ctx, `[base_collect] пропущено ${excludedAlreadySeen} строк — эта база их уже просматривала`);
  }
  // Кап — после дедупа и исключения, как раньше после дедупа (limit уже
  // посчитан выше — тот же totalRowsCap(job)).
  const orderedKept = target && !info.preview_pipeline && !info.construct
    ? await prepareAdaptiveCandidates(ctx, base, info, kept) : kept;
  const merged = info.preview_pipeline && target
    ? await preparePreviewBatches({ ctx, base, info, project, target, available: kept, market })
    : (info.construct || info.adaptive_collection?.pending) && info.search_policy?.construct_rows ? info.search_policy.construct_rows
      : orderedKept.slice(0, info.adaptive_collection ? veAdaptiveCandidateLimit(target!)
        : info.source_contact_recovery ? Math.min(limit, PREVIEW_BATCH_SIZE) : limit);

  if (merged.length === 0 && target && info.adaptive_collection && !info.adaptive_collection.pending
    && !info.preview_pipeline?.error && !failed.length && target.ready_rows < target.ready_target) {
    const nextSource = tasks.find((task) => task.status === 'pending'
      && veSourceStrategyKey(task.task) !== info.adaptive_collection!.active_source
      && !veAdaptiveSourceDry(info.adaptive_collection!.completed, veSourceStrategyKey(task.task)));
    if (nextSource) {
      info.adaptive_collection.active_source = veSourceStrategyKey(nextSource.task);
      info.adaptive_collection.switches += 1;
      info.adaptive_collection.note = 'Текущий источник не дал новых кандидатов. Проверяем следующий источник из плана.';
      await persistCollectInfo(ctx, baseId, info);
      await requeueSelf(ctx, job, 1_000);
      return { result: { waiting: true, base_id: baseId, next_source: nextSource.source }, ...usage };
    }
  }

  if (info.preview_pipeline && merged.length === 0 && waiting.length > 0
    && !info.preview_pipeline.error && (target?.ready_rows ?? 0) < (target?.ready_target ?? 500)) {
    await requeueSelf(ctx, job, 15_000);
    return { result: { waiting: true, base_id: baseId, pending_sources: waiting.map((task) => task.source) },
      tokensUsed: usage.tokensUsed, costUsd: usage.costUsd };
  }

  let stats: NonNullable<VeCollectInfo['stats']> = {
    tasks_total: tasks.length,
    tasks_done: done.length,
    tasks_failed: failed.length,
    rows_total: merged.length,
    excluded_existing_bases: excludedExisting,
    excluded_existing_bases_before_construct: excludedExisting,
    ...(excludedAlreadySeen ? { excluded_already_seen: excludedAlreadySeen } : {}),
    excluded_during_fetch: tasks.reduce((sum, t) => sum + (t.excluded_during_fetch ?? 0), 0),
    ...(tasks.some((t) => t.already_seen_during_fetch)
      ? { already_seen_during_fetch: tasks.reduce((sum, t) => sum + (t.already_seen_during_fetch ?? 0), 0) } : {}),
    finished_at: new Date().toISOString(),
  };

  if (merged.length === 0) {
    if (target) return await completeTargetRound({
      ctx, job, base, info, progress: target, candidates: [], rows: [],
      columns: [...VE_AUTO_COLLECT_COLUMNS], stats, hasBufferedCandidates: false,
      validationError: null, usage,
    });
    // Refill-сборка ENG auto-pipeline: «новых компаний нет» — ШТАТНЫЙ исход
    // добора (сегмент под вертикаль уже выбран прошлыми сборками), а не сбой:
    // база уходит в терминальный 'analyzed' (НЕ failed), прогон журналируется
    // 'no_new', джоба завершается успешно.
    if (isRefill) {
      const refillResult = await completeVeRefillNoNew({
        ctx,
        job,
        baseId,
        verticalId: base.vertical_id,
        info,
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
    // а не «исчерпан») и реестр подтвердил продолжение — строки реально
    // пропускались на выборке как уже собранные в других базах. Повторная
    // сборка бессмысленна — честный фейл вместо общего «не дала строк».
    // Пустая выдача при ПЕРВОЙ сборке (пропусков на выборке не было) —
    // обычный нулевой сбор, не исчерпание.
    const segmentExhausted =
      (base.row_count ?? 0) === 0 &&
      failed.length === 0 &&
      tasks.every((t) => t.exhausted || (t.rows === 0 && !t.hit_ceiling)) &&
      tasks.some((t) => (t.excluded_during_fetch ?? 0) > 0);
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
      .from('ve_bases')
      .update({
        status: 'failed',
        error: note.slice(0, 500),
        collect_info: { ...info, stats },
        updated_at: new Date().toISOString(),
      })
      .eq('id', baseId);
    throw new Error(note);
  }

  // ─── CONSTRUCT ───
  const constructRequeueMs = info.preview_pipeline || (target?.mode === 'preview' && target.round === 1
    && target.first_round_candidates === VE_PREVIEW_FIRST_CANDIDATES) ? 15_000 : CONSTRUCT_REQUEUE_MS;
  // Обогащение собранных строк конструктором баз (валидация почт ВСЕГДА,
  // поиск — для бедных баз, см. constructStepsFor). Пропуск — только когда
  // фаза завершалась ранее (construct.status='done' в collect_info). База в
  // analyzing уходит только после импорта (или решения failed/cancelled
  // BC-джобы).
  let finalRows: VeUnifiedRow[] = merged;
  let finalColumns: string[] = [...VE_AUTO_COLLECT_COLUMNS];
  // Вердикты валидации по строкам (из импорта конструктора) — refill-ветке и
  // пометке строк (_email_status) при финальной записи: null, когда
  // конструктор не запускался / вернул пусто.
  let finalEmailStatuses: Array<string | null> | null = null;
  // Это реальные кандидаты после дедупа, ещё не готовые получатели. row_count
  // остаётся счётчиком финальных строк, а finished_at до финала не публикуем.
  const candidateStats = { ...stats };
  if (target) {
    candidateStats.rows_total += target.candidates_processed;
    candidateStats.processed_rows = info.target_checkpoint?.processed_rows ?? 0;
    candidateStats.launchable_rows = target.ready_contacts ?? target.ready_rows;
  }
  delete candidateStats.finished_at;
  const candidateStatsChanged = !sameCollectSnapshot(info.stats, candidateStats);
  info.stats = candidateStats;
  let construct = info.construct;
  if ((!construct || construct.status === 'dispatched') && needsConstruct(merged)) {
    if (!construct?.bc_job_id) {
      // DISPATCH-CONSTRUCT: джоба конструктора (воркер baseConstructor клеймит
      // pending), её id — в collect_info.construct; дальше WAIT с паузой 60с.
      if (info.adaptive_collection && !info.adaptive_collection.pending) {
        beginAdaptiveBatch(base, info, randomUUID(), merged);
        if (info.search_policy) info.search_policy.construct_rows = merged;
        await persistCollectInfo(ctx, baseId, info);
      }
      const { bcJobId, locale, construct: queuedConstruct } = await dispatchConstructJob({
        ctx,
        ownerId: project.created_by,
        projectName: project.name,
        baseLabel: base.filename ?? baseId,
        rows: merged,
        market,
        reservedId: info.adaptive_collection?.pending?.id,
      });
      info.construct = queuedConstruct;
      if (info.search_policy) info.search_policy.construct_rows = merged;
      await persistCollectInfo(ctx, baseId, info);
      stageLog(ctx, `[base_collect] construct: создана base_constructor_jobs ${bcJobId} (${merged.length} строк, locale ${locale})`);
      await requeueSelf(ctx, job, constructRequeueMs);
      return {
        result: { waiting: true, base_id: baseId, construct: 'dispatched' },
        tokensUsed: usage.tokensUsed,
        costUsd: usage.costUsd,
      };
    }

    // WAIT-CONSTRUCT: опрос BC-джобы до терминального статуса.
    const bcJobId = construct.bc_job_id;
    const bc = await readConstructJobStatus(ctx, bcJobId);
    const bcStatus = bc?.status ?? 'failed';
    if (bc && (candidateStatsChanged || !sameCollectSnapshot(construct.progress, bc.progress))) {
      // Терминальный BC-снимок тоже только информационный: status остаётся
      // dispatched до атомарной записи импортированных строк в финале ниже.
      // Иначе рестарт между импортом и записью пропустит импорт/валидацию.
      construct = { ...construct, progress: bc.progress };
      info.construct = construct;
      await persistCollectInfo(ctx, baseId, { ...info });
    }
    if (bcStatus === 'completed' || bcStatus === 'failed' || bcStatus === 'cancelled') {
      if (info.preview_pipeline && !info.preview_pipeline.active_batch_id) {
        // The child may complete between the scheduler's read and this read.
        info.preview_pipeline.active_batch_id = bcJobId;
        await persistCollectInfo(ctx, baseId, info);
      }
      // Джоба могла быть поставлена до обязательного split_emails. Её
      // row-level validation status нельзя безопасно прикрепить к первому
      // адресу merged-ячейки: лучший статус мог относиться ко второму.
      // Терминальную legacy-джобу не импортируем, а один раз пересобираем по
      // текущему контракту; новая selected_steps уже содержит split_emails.
      if (bc?.selected_steps && !bc.selected_steps.includes('split_emails')) {
        const replacement = await dispatchConstructJob({
          ctx,
          ownerId: project.created_by,
          projectName: project.name,
          baseLabel: base.filename ?? baseId,
          rows: merged,
          market,
        });
        info.construct = {
          ...replacement.construct,
          note: `legacy constructor job ${construct.bc_job_id} пересобирается с split_emails`,
        };
        await persistCollectInfo(ctx, baseId, info);
        stageLog(
          ctx,
          `[base_collect] construct: legacy job ${construct.bc_job_id} без split_emails → ` +
            `повтор ${replacement.bcJobId}`,
        );
        await requeueSelf(ctx, job, constructRequeueMs);
        return {
          result: { waiting: true, base_id: baseId, construct: 're_dispatched' },
          tokensUsed: usage.tokensUsed,
          costUsd: usage.costUsd,
        };
      }
      // IMPORT: failed/cancelled базу НЕ валит — импортируем частичный data,
      // если он есть, иначе идём в analyzing без обогащения.
      const imported = await importConstructRows(ctx, bcJobId);
      const failNote =
        bcStatus === 'completed'
          ? null
          : `конструктор завершился со статусом ${bcStatus}${bc?.error_message ? `: ${bc.error_message}` : ''}`;
      if (imported) {
        finalRows = imported.rows;
        finalEmailStatuses = imported.emailStatuses;
        if (imported.hasDescription) finalColumns = [...VE_AUTO_COLLECT_COLUMNS, 'description'];
        info.construct = {
          ...construct,
          status: bcStatus === 'completed' ? 'done' : bcStatus,
          emails_found: imported.emailsFound,
          valid_count: imported.validCount,
          ...(failNote ? { note: `${failNote} — импортирован частичный результат` } : {}),
        };
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
      if (
        construct.dispatched_at &&
        Date.now() - new Date(construct.dispatched_at).getTime() > CONSTRUCT_TIMEOUT_MS
      ) {
        const note = `Конструктор баз не завершился за 6ч (job ${construct.bc_job_id}, статус: ${bc?.status ?? 'не найдена'})`;
        info.construct = { ...construct, note };
        await persistCollectInfo(ctx, baseId, { ...info, stats }, { status: 'failed', error: note.slice(0, 500) });
        throw new Error(note);
      }
      await requeueSelf(ctx, job, constructRequeueMs);
      return {
        result: { waiting: true, base_id: baseId, construct: bc?.status ?? 'missing' },
        tokensUsed: usage.tokensUsed,
        costUsd: usage.costUsd,
      };
    }
  }

  // Пока конструктор валидирует/разносит email, другая база проекта могла уже
  // завершиться. Повторяем дедуп свежим чтением и уже по email тоже: именно
  // здесь ловятся контакты, найденные конструктором под разными названиями
  // компаний.
  const freshExistingKeys = await loadOtherBaseExclusionKeys(ctx, job.project_id, baseId, target ? base.hypothesis_id : undefined);
  const rowsBeforePostConstructDedup = finalRows.length;
  if (rowsBeforePostConstructDedup > 0) {
    const nextRows: VeUnifiedRow[] = [];
    const currentStatuses = finalEmailStatuses;
    const nextStatuses: Array<string | null> | null = currentStatuses ? [] : null;
    finalRows.forEach((row, index) => {
      const pruned = pruneBaseRowAgainstExclusion(freshExistingKeys, row);
      if (!pruned) return;
      nextRows.push(pruned);
      if (nextStatuses && currentStatuses) nextStatuses.push(currentStatuses[index] ?? null);
    });
    const excludedAfterConstruct = rowsBeforePostConstructDedup - nextRows.length;
    if (excludedAfterConstruct > 0) {
      finalRows = nextRows;
      finalEmailStatuses = nextStatuses;
      stats = {
        ...stats,
        rows_total: finalRows.length,
        excluded_existing_bases: stats.excluded_existing_bases + excludedAfterConstruct,
        excluded_existing_bases_after_construct: excludedAfterConstruct,
      };
      stageLog(ctx, `[base_collect] исключено ${excludedAfterConstruct} строк после конструктора — уже есть в других базах проекта`);
    }
  }

  if (finalRows.length === 0) {
    if (target) return await completeTargetRound({
      ctx, job, base, info, progress: target, candidates: merged, rows: [],
      columns: finalColumns, stats, hasBufferedCandidates: kept.length > merged.length,
      validationError: info.construct?.status === 'done' ? null : 'Проверка email завершилась не полностью', usage,
    });
    if (isRefill) {
      const refillResult = await completeVeRefillNoNew({
        ctx,
        job,
        baseId,
        verticalId: base.vertical_id,
        info,
        stats,
      });
      return {
        result: { base_id: baseId, rows: 0, refill: refillResult },
        tokensUsed: usage.tokensUsed,
        costUsd: usage.costUsd,
      };
    }
    const note = 'После исключения контактов из других баз проекта не осталось новых строк';
    await ctx.supabase
      .from('ve_bases')
      .update({
        status: 'failed',
        error: note.slice(0, 500),
        collect_info: { ...info, stats },
        updated_at: new Date().toISOString(),
      })
      .eq('id', baseId);
    throw new Error(note);
  }

  const { storedRows, lowRelevanceCount, relevanceUncheckedCount, relevanceNeedsReviewCount, relevanceErrorCount,
    relevanceCheckedCompanies, relevanceTotalCompanies, relevanceCoverageComplete, relevanceError } = await checkCollectedRelevance({
    ctx, job, base, info, finalRows, finalEmailStatuses, market, usage,
  });
  // Ровно тот же pure-контракт фильтрует аудиторию перед запуском на шаге 5.
  // Но число можно называть проверенным только после успешной построчной
  // validation: partial/failed constructor без status-колонки не должен
  // превращать синтаксически похожие адреса в «готовые».
  const hasCompleteEmailValidation =
    info.construct?.status === 'done'
    && finalEmailStatuses !== null
    && finalEmailStatuses.length === storedRows.length
    && finalEmailStatuses.every((status) => status !== null);
  const launchableRows = hasCompleteEmailValidation
    ? prepareSegmentationAudience({
        rows: storedRows,
        columns: finalColumns,
        source: 'auto',
      }).rows.length
    : null;
  const statsWithQuality = {
    ...stats,
    processed_rows: storedRows.length,
    ...(launchableRows === null ? {} : { launchable_rows: launchableRows }),
    low_relevance: lowRelevanceCount,
    relevance_unchecked: relevanceUncheckedCount,
    relevance_needs_review: relevanceNeedsReviewCount,
    relevance_errors: relevanceErrorCount,
    ...(relevanceCheckedCompanies === null
      ? {}
      : { relevance_checked_companies: relevanceCheckedCompanies }),
    ...(relevanceTotalCompanies === null
      ? {}
      : { relevance_total_companies: relevanceTotalCompanies }),
    relevance_coverage_complete: relevanceCoverageComplete,
  };
  if (target) return await completeTargetRound({
    ctx, job, base, info, progress: target, candidates: merged, rows: storedRows,
    columns: finalColumns, stats: statsWithQuality, hasBufferedCandidates: kept.length > merged.length,
    validationError: !relevanceCoverageComplete ? relevanceError ?? 'Проверка релевантности завершилась не полностью'
      : !hasCompleteEmailValidation ? 'Проверка email завершилась не полностью' : null,
    usage,
  });

  // Legacy non-target/refill jobs keep their existing contract. The new name
  // phase requires the durable round/recovery state used by preview and supply;
  // do not introduce an unrecoverable paid phase into an old in-flight job.

  // ─── REFILL (ENG auto-pipeline) ───
  // Вместо финала «analyzing + base_analyze»: долив валидных строк лидами в
  // уже запущенную кампанию, база → терминальный 'analyzed', итог — в
  // collect_info.refill_result и ve_auto_pipeline_runs.
  if (isRefill) {
    return await runVeRefillAppend({
      ctx,
      job,
      base: { id: baseId, project_id: job.project_id, vertical_id: base.vertical_id },
      info,
      stats: statsWithQuality,
      finalRows: storedRows,
      finalColumns,
      emailStatuses: finalEmailStatuses,
      usage,
    });
  }

  const { error: updError } = await ctx.supabase
    .from('ve_bases')
    .update({
      columns: finalColumns,
      sample_rows: storedRows.slice(0, SAMPLE_ROWS),
      data: storedRows,
      row_count: storedRows.length,
      status: 'analyzing',
      collect_info: { ...info, stats: statsWithQuality },
      updated_at: new Date().toISOString(),
    })
    .eq('id', baseId);
  if (updError) throw new Error(`ve_bases harvest update: ${updError.message}`);

  const { error: jobError } = await ctx.supabase.from('ve_jobs').insert({
    project_id: job.project_id,
    stage: 'base_analyze',
    status: 'pending',
    payload: { base_id: baseId },
  });
  if (jobError) throw new Error(`ve_jobs base_analyze enqueue: ${jobError.message}`);

  return {
    result: {
      base_id: baseId,
      rows: storedRows.length,
      low_relevance: lowRelevanceCount,
      tasks_done: done.length,
      tasks_failed: failed.length,
      failed_sources: failed.map((f) => f.source),
    },
    tokensUsed: usage.tokensUsed,
    costUsd: usage.costUsd,
  };
}

/** Keep an explicit target error without erasing a committed round checkpoint. */
export async function runBaseCollectStage(job: VeJob, ctx: VeStageContext): Promise<VeStageResult> {
  ctx.onCheckpoint?.();
  if (job.error && (job.result?.relevance_retry || job.result?.company_name_retry)) {
    ctx.signal?.throwIfAborted();
    // The saved reason belongs to the previous cooldown. A later constructor
    // poll or capacity continuation must not show that old provider outage.
    const { data: saved, error } = await ctx.supabase.from('ve_jobs')
      .update({ error: null, updated_at: new Date().toISOString() })
      .eq('id', job.id).eq('status', 'running').select('id').maybeSingle();
    if (error || !saved) throw new VeRelevanceCheckpointError(
      error ? `Relevance retry status clear: ${error.message}` : 'Relevance retry lost job ownership',
    );
    job.error = null;
  }
  try {
    return await runBaseCollectStageImpl(job, ctx);
  } catch (error) {
    ctx.signal?.throwIfAborted();
    // Do not reread the winner's revision and stamp our obsolete error over it.
    // The worker also leaves the winner's job lifecycle untouched.
    if (error instanceof VePreviewCheckpointConflict) throw error;
    // The generic worker persists Retry-After. A waiting job must not leave
    // the base's progress looking like a terminal preparation failure.
    if (error instanceof VeLlmRateLimitError || isVeTransientDirectoryError(error)) throw error;
    if (error instanceof VeRelevanceRetryScheduled) {
      return { result: { base_id: error.baseId, waiting: true, relevance_retry: true },
        tokensUsed: error.usage.tokensUsed, costUsd: error.usage.costUsd };
    }
    try {
      const baseId = payloadString(job, 'base_id');
      const { data: base, error: readError } = await ctx.supabase.from('ve_bases')
        .select('status, collect_info').eq('id', baseId).maybeSingle();
      const info = base?.collect_info as VeCollectInfo | undefined;
      if (!readError && info?.target_progress && base?.status !== 'analyzing' && base?.status !== 'analyzed') {
        await persistCollectInfo(ctx, baseId, { ...info, target_progress: {
          ...info.target_progress, status: 'error',
          reason: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        } });
      }
    } catch (snapshotError) {
      stageLog(ctx, `[base_collect] target error snapshot unavailable: ${snapshotError instanceof Error ? snapshotError.message : String(snapshotError)}`);
    }
    throw error;
  }
}
