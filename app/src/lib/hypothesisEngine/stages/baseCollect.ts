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
 *     (base_constructor_jobs: dedup_email → find_emails → validate_emails →
 *     cap_emails_per_company → enrich_descriptions; locale джобы по рынку).
 *     Пропускается, когда email уже есть у >50% строк (RU-источники богатые)
 *     или фаза завершалась ранее (construct.status='done' в collect_info).
 *     DISPATCH-CONSTRUCT создаёт BC-джобу (bc_job_id — в collect_info.construct)
 *     и уходит в self-requeue с паузой 60с; WAIT-CONSTRUCT опрашивает её до
 *     терминального статуса (таймаут 6ч → база failed); IMPORT мапит сетку
 *     обратно в унифицированные колонки по имени заголовка (email — первый
 *     адрес merged-ячейки) и добавляет колонку description В КОНЕЦ заголовков.
 *     failed/cancelled BC-джоба базу НЕ валит: импортируется частичный data,
 *     если он есть, иначе переход к analyzing без обогащения. Далее —
 *     he_bases → status='analyzing' и ставится стадия base_analyze.
 *
 * Refill-режим (ENG auto-pipeline, payload.refill=true; постановка — крон
 * app/worker/heAutoPipelineCron.ts через enqueueHeBaseCollect): PLAN →
 * DISPATCH → WAIT → HARVEST → CONSTRUCT идут как обычно, но вместо финала
 * «analyzing + base_analyze» собранные строки доливаются лидами в уже
 * запущенную кампанию Instantly, база уходит в терминальный 'analyzed',
 * итог пишется в collect_info.refill_result и he_auto_pipeline_runs.
 * Пустой harvest — штатный 'no_new' (база НЕ failed). Вся механика —
 * stages/baseCollectRefill.ts.
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
 * У hh/карт
 * исключение остаётся только на мёрдже: продолжение для них требует
 * вариации поисковых запросов — future work.
 */

import type { CompaniesSearchFilters } from '@/app/api/client/companies-search/route';
import { searchRows } from '@/lib/companiesSearch/rpcSearch';
import { applyFundedFilters } from '@/lib/funded/queryFilters';
import { buildRolesRegex } from '@/lib/parsers/atsFilters';
import { extractEmail } from '@/lib/tools/dfybUtils';
import { callLLMWithSchema, getHeModel } from '../llm';
import { projectMarket, type HeMarket } from '../market';
import { findIrrelevantRows } from '../relevanceGate';
import {
  buildSourcePlanMessages,
  type HeCollectTask,
  type HeSourcePlan,
  type SourcePlanPromptInput,
} from '../prompts/sourcePlan';
import { buildCatalogRepairMessagesEn, buildSourcePlanMessagesEn } from '../prompts/sourcePlan.en';
import { HeCatalogRepairSchema, HeSourcePlanSchema } from '../schemas';
import type { HeBase, HeJob, HeProject, HeVertical } from '../types';
import {
  completeHeRefillNoNew,
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
 * иначе первая). Асимметрия с кросс-базовым исключением осознанная: там
 * матч ТОЛЬКО по компании (website может отсутствовать у целого источника),
 * а здесь пары с РАЗНЫМИ непустыми сайтами живут обе — у дочек/филиалов
 * бывают разные домены. Строки с пустым нормализованным ключом компании
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
  /** Реестр: строк пропущено на выборке как уже собранные в других базах проекта. */
  excluded_during_fetch?: number;
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
  /** Пометка для UI (частичный импорт / без обогащения / таймаут). */
  note?: string;
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
   * Ключа нет — план пришёл от планировщика как есть. outcome='failed' объясняет
   * тонкую базу: каталога не было и добавить его не вышло.
   */
  plan_repair?: HePlanRepair;
  /** Гипотезы, по которым реально строился план (accepted-дефолт или выбор специалиста). */
  hypotheses?: Array<{ id: string; title: string; status: string | null }>;
  tasks?: HeCollectTaskState[];
  /** Фаза CONSTRUCT: состояние передачи базы конструктору (появляется после HARVEST). */
  construct?: HeConstructInfo;
  stats?: {
    tasks_total: number;
    tasks_done: number;
    tasks_failed: number;
    rows_total: number;
    /** Строк отсеяно как уже существующие в других базах проекта. */
    excluded_existing_bases: number;
    /** Реестр: строк пропущено ещё на выборке (уже собраны в других базах проекта). */
    excluded_during_fetch: number;
    finished_at: string;
  };
}

/** he_bases-строка авто-сборки: колонки source/collect_info моложе HeBase. */
type HeAutoBase = HeBase & {
  source?: string;
  collect_info?: HeCollectInfo | null;
  error?: string | null;
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

async function persistCollectInfo(
  ctx: HeStageContext,
  baseId: string,
  info: HeCollectInfo,
): Promise<void> {
  const { error } = await ctx.supabase
    .from('he_bases')
    .update({ collect_info: info, updated_at: new Date().toISOString() })
    .eq('id', baseId);
  if (error) throw new Error(`he_bases collect_info update: ${error.message}`);
}

/* ─────────────────────────── Фаза PLAN ─────────────────────────── */

async function buildPlan(
  job: HeJob,
  ctx: HeStageContext,
  vertical: HeVertical,
  usage: HeUsage,
  market: HeMarket,
): Promise<{
  plan: HeSourcePlan;
  planRepair?: HePlanRepair;
  usedHypotheses: Array<{ id: string; title: string; status: string | null }>;
}> {
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

  const promptInput = {
    verticalName: vertical.name,
    verticalSummary: vertical.summary,
    synonyms: Array.isArray(vertical.synonyms) ? vertical.synonyms : [],
    hypotheses,
    companyTypes,
  };

  const llm = await callLLMWithSchema(
    // Рынок 'us' — EN-промпт с ENG-источниками (pdl/funded/eng_hiring/google_maps).
    (market === 'us' ? buildSourcePlanMessagesEn : buildSourcePlanMessages)(promptInput),
    HeSourcePlanSchema,
    { model: getHeModel('bulk') },
  );
  addUsage(usage, llm);

  const { plan, planRepair } = await ensureCatalogSource(ctx, llm.data, promptInput, usage, market);
  return {
    plan,
    planRepair,
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

  const task: HeCollectTask = {
    source: 'pdl',
    rationale: repair.data.rationale,
    pdl_filters: repair.data.pdl_filters,
  };
  // Потолок плана — 4 задачи (HeSourcePlanSchema). Если модель уже выбрала
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
      // Дубль другой базы: по имени (с ИНН-уточнением) или точно по ИНН.
      if (matchesExclusion(excludedKeys, cell(r.name), r.inn)) {
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

/** Одна повторная попытка чтения страницы: рестарт/блип Kong не должен валить сбор. */
const PDL_READ_RETRY_MS = 3000;

/** Ошибки чтения: HTML maintenance-страницы Kong (504/рестарт) — не в error задачи. */
function cleanPdlReadError(message: string): string {
  if (message.includes('<html') || message.includes('<!doctype')) {
    return 'pdl_companies read: non-JSON response (gateway timeout/restart)';
  }
  return `pdl_companies read: ${message}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPdlRows(
  ctx: HeStageContext,
  filters: HeCollectTask['pdl_filters'],
  limit: number,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let lastId = '';
  for (;;) {
    const params = {
      p_industries: filters?.industries?.length ? lowerList(filters.industries) : null,
      p_sizes: filters?.sizes?.length ? lowerList(filters.sizes) : null,
      p_countries: filters?.countries?.length ? lowerList(filters.countries) : null,
      p_name: filters?.name ? filters.name.replace(/[%_]/g, '') : null,
      p_after_id: lastId || null,
      p_limit: ENG_CATALOG_PAGE_SIZE,
    };
    // Одна повторная попытка при сбое чтения (блип/рестарт Kong): страница
    // идемпотентна, удвоенного трафика на happy-path нет.
    let data: unknown = null;
    let error: { message: string } | null = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const res = await ctx.supabase.rpc('search_pdl_companies', params);
      data = res.data;
      error = res.error ? { message: res.error.message } : null;
      if (!error) break;
      if (attempt < 2) await sleep(PDL_READ_RETRY_MS);
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
  ctx: HeStageContext,
  filters: HeCollectTask['funded_filters'],
  limit: number,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let lastId = '';
  for (;;) {
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
 * eng_hiring_cache (компании, нанимающие ENG-роли): SQL сужает выборку по
 * стране (country_code), свежести (published_at >= now - posted_within_days) и
 * роли (buildRolesIlikeFilter — надмножество), точность роли добирает regex по
 * vacancy_title в JS (buildRolesRegex из ATS-фильтров, как в engHiring).
 * Дедуп по компании внутри задачи: выживает самая свежая вакансия.
 * Пагинация офсетная (order по published_at с keyset несовместим), с потолком
 * ENG_HIRING_MAX_PAGES.
 */
async function fetchEngHiringRows(
  ctx: HeStageContext,
  query: HeCollectTask['eng_hiring_query'],
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
  return out;
}

async function dispatchTask(
  ctx: HeStageContext,
  state: HeCollectTaskState,
  project: HeProject,
  limit: number,
  getExcludedKeys: () => Promise<HeBaseExclusionKeys>,
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
    );
    state.status = 'done';
    state.rows = state.harvest.length;
    state.child_job_id = null;
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
 * Ключи исключения по другим базам проекта. Два канала матча:
 *  - ИНН: то же юрлицо под другим написанием имени («ООО Ромашка» vs
 *    «РОМАШКА ООО») ловится по множеству всех ИНН;
 *  - имя: если под этим именем в других базах есть ИНН и у входящей строки
 *    тоже — сравниваем юрлица точно (одноимённые компании разных регионов
 *    с разными ИНН больше НЕ вымываются); если ИНН пуст хотя бы с одной
 *    стороны — консервативный матч по имени, как раньше.
 */
export interface HeBaseExclusionKeys {
  /** нормализованное имя → ИНН'ы, встреченные под ним в других базах. */
  nameInns: Map<string, Set<string>>;
  /** Все ИНН других баз (матч «то же юрлицо, другое написание»). */
  inns: Set<string>;
}

/** Строка исключена: совпал непустой ИНН или имя (с ИНН-уточнением, см. выше). */
function matchesExclusion(keys: HeBaseExclusionKeys, company: string, inn: unknown): boolean {
  const innKey = normalizeInnForDedup(inn);
  if (innKey && keys.inns.has(innKey)) return true;
  const nameKey = normalizeCompanyForDedup(company);
  if (!nameKey) return false;
  const knownInns = keys.nameInns.get(nameKey);
  if (knownInns === undefined) return false;
  // Точное сравнение юрлиц только когда ИНН есть с обеих сторон.
  if (innKey && knownInns.size > 0) return knownInns.has(innKey);
  return true;
}

/**
 * Ключи компаний из ДРУГИХ he_bases того же проекта (любой
 * source, любой статус кроме failed; текущая база исключена). Без этого одна
 * и та же компания копилась в нескольких базах проекта через повторные
 * сборки. Компания — из колонки 'company', ИНН — из 'inn'. data jsonb чужой базы и так читается целиком (одно поле
 * строки), поэтому slice до MAX_ROWS_LIMIT — лишь JS-предохранитель; он
 * обязан быть не меньше максимального размера базы: кап 10k при лимите
 * сборки до 50k отрезал хвост чужой базы из исключений, и вторая сборка
 * собирала компании 10001–50000 первой заново как «новые».
 */
async function loadOtherBaseExclusionKeys(
  ctx: HeStageContext,
  projectId: string,
  baseId: string,
): Promise<HeBaseExclusionKeys> {
  const { data, error } = await ctx.supabase
    .from('he_bases')
    .select('data')
    .eq('project_id', projectId)
    .neq('status', 'failed')
    .neq('id', baseId);
  if (error) throw new Error(`he_bases exclusion read: ${error.message}`);

  const keys: HeBaseExclusionKeys = { nameInns: new Map<string, Set<string>>(), inns: new Set<string>() };
  for (const row of (data ?? []) as Array<{ data?: unknown }>) {
    const rows = Array.isArray(row.data) ? row.data.slice(0, MAX_ROWS_LIMIT) : [];
    for (const item of rows) {
      const rec = item as Record<string, unknown> | null;
      const innKey = normalizeInnForDedup(rec?.inn);
      if (innKey) keys.inns.add(innKey);
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
    }
  }
  return keys;
}

/* ─────────────────────────── Фаза CONSTRUCT ─────────────────────────── */

/**
 * Шаги конструктора для авто-базы HE: дедуп почт → (поиск на сайтах, если
 * база бедная) → ВАЛИДАЦИЯ → кап на компанию → описания. AI-шагов
 * (ta_scoring/personalization) нет — генерация и скоринг остаются в Движке.
 *
 * validate_emails — ВСЕГДА: раньше конструктор запускался только при бедных
 * почтах, и базы реестра/карт (email уже есть, но это протухшие info@ из
 * ЕГРЮЛ-источников) уходили в рассылку без валидации — баунсы ложились на
 * домен клиента. find_emails — только когда email есть у ≤50% строк
 * (ENG-базы pdl/funded/eng_hiring, бедные hh-сборки).
 */
const CONSTRUCT_STEPS_TAIL = ['validate_emails', 'cap_emails_per_company', 'enrich_descriptions'];

/** Свыше этого размера enrich_descriptions (per-site фетчи) не укладывается в
 *  6-часовой таймаут конструктора — для больших баз шаг пропускаем. */
const CONSTRUCT_ENRICH_MAX_ROWS = 5000;

function constructStepsFor(merged: HeUnifiedRow[]): string[] {
  const withEmail = merged.filter((r) => r.email.trim() !== '').length;
  const poor = withEmail * 2 <= merged.length;
  const tail =
    merged.length > CONSTRUCT_ENRICH_MAX_ROWS
      ? CONSTRUCT_STEPS_TAIL.filter((s) => s !== 'enrich_descriptions')
      : CONSTRUCT_STEPS_TAIL;
  return ['dedup_email', ...(poor ? ['find_emails'] : []), ...tail];
}
/** Канонические заголовки сетки конструктора (порядок — как HE_AUTO_COLLECT_COLUMNS). */
const CONSTRUCT_HEADERS_RU = ['Компания', 'Сайт', 'Email', 'Телефон', 'Вакансия', 'Адрес', 'Категория', 'Сотрудники', 'Выручка', 'ИНН', 'Источник'];
const CONSTRUCT_HEADERS_EN = ['Company', 'Site', 'Email', 'Phone', 'Vacancy', 'Address', 'Category', 'Employees', 'Revenue', 'INN', 'Source'];
/** Сколько ждём BC-джобу, прежде чем считать её зависшей (база → failed). */
const CONSTRUCT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/** Пауза между тиками ожидания BC-джобы (run_after). */
const CONSTRUCT_REQUEUE_MS = 60_000;

/** Заголовок сетки конструктора (lowercase) → унифицированная колонка / description. */
const CONSTRUCT_HEADER_MAP: Record<string, keyof HeUnifiedRow | 'description'> = {
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
): Promise<{ status: string; error_message: string | null } | null> {
  const { data, error } = await ctx.supabase
    .from('base_constructor_jobs')
    .select('status, error_message')
    .eq('id', bcJobId)
    .maybeSingle();
  if (error) throw new Error(`base_constructor_jobs read: ${error.message}`);
  if (!data) return null;
  const row = data as { status?: unknown; error_message?: unknown };
  return {
    status: String(row.status ?? ''),
    error_message: typeof row.error_message === 'string' ? row.error_message : null,
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

/* ─────────────────────────── Стадия ─────────────────────────── */

export async function runBaseCollectStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  const usage = newUsage();
  const baseId = payloadString(job, 'base_id');
  // Лимит сборки из payload (route кладёт туда выбор пользователя): один на
  // всё — пагинация реестра, чтение дочерних джоб, итоговый кап базы.
  const limit = totalRowsCap(job);
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

  const info: HeCollectInfo =
    base.collect_info && typeof base.collect_info === 'object' ? base.collect_info : {};

  // ─── PLAN ───
  if (!info.plan) {
    const { plan, planRepair, usedHypotheses } = await buildPlan(job, ctx, vertical, usage, market);
    info.plan = plan;
    if (planRepair) info.plan_repair = planRepair;
    info.hypotheses = usedHypotheses;
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
  const tasks = info.tasks ?? [];

  // Ключи компаний других баз проекта: нужны реестру ещё на DISPATCH
  // (исключение на выборке — продолжение больших сегментов) и повторно на
  // HARVEST (страховка для строк hh/карт). Лениво + мемоизация: на тиках
  // чистого ожидания дочерних парсеров лишнего чтения he_bases нет.
  let excludedKeysCache: HeBaseExclusionKeys | null = null;
  const getExcludedKeys = async (): Promise<HeBaseExclusionKeys> => {
    if (!excludedKeysCache) {
      excludedKeysCache = await loadOtherBaseExclusionKeys(ctx, job.project_id, baseId);
    }
    return excludedKeysCache;
  };

  // ─── DISPATCH ───
  for (const state of tasks) {
    if (state.status !== 'pending') continue;
    try {
      await dispatchTask(ctx, state, project, limit, getExcludedKeys);
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
  const interleaved = dedupUnifiedRows(
    interleaveTaskHarvests(
      done.map((t) => (t.harvest ?? []).filter((r) => normalizeCompanyForDedup(r.company) !== '')),
    ),
  );

  // Исключаем компании, уже собранные в других базах этого проекта. Для
  // реестра это страховка (основное исключение прошло на выборке), для
  // hh/карт — единственная точка исключения.
  const existingKeys = await getExcludedKeys();
  const kept = interleaved.filter((r) => !matchesExclusion(existingKeys, r.company, r.inn));
  const excludedExisting = interleaved.length - kept.length;
  if (excludedExisting > 0) {
    stageLog(ctx, `[base_collect] исключено ${excludedExisting} строк — компании уже есть в других базах проекта`);
  }
  // Кап — после дедупа и исключения, как раньше после дедупа (limit уже
  // посчитан выше — тот же totalRowsCap(job)).
  const merged = kept.slice(0, limit);

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
      .from('he_bases')
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
  const construct = info.construct;
  if ((!construct || construct.status === 'dispatched') && needsConstruct(merged)) {
    if (!construct?.bc_job_id) {
      // DISPATCH-CONSTRUCT: джоба конструктора (воркер baseConstructor клеймит
      // pending), её id — в collect_info.construct; дальше WAIT с паузой 60с.
      if (!project.created_by) {
        throw new Error('he_projects.created_by пуст — джобе конструктора некому принадлежать');
      }
      const locale = market === 'us' ? 'en' : 'ru';
      const steps = constructStepsFor(merged);
      const bcJobId = await insertChildJob(ctx, 'base_constructor_jobs', {
        user_id: project.created_by,
        file_name: `HE · ${base.filename ?? baseId}`,
        status: 'pending',
        locale,
        selected_steps: steps,
        // Кап «до 5 почт на компанию» — ключ max, как читает STEP_RUNNERS воркера.
        step_config: { cap_emails_per_company: { max: 5 } },
        data: buildConstructGrid(merged, market),
        initial_row_count: merged.length,
        total_steps: steps.length,
      });
      info.construct = { bc_job_id: bcJobId, status: 'dispatched', dispatched_at: new Date().toISOString() };
      await persistCollectInfo(ctx, baseId, info);
      stageLog(ctx, `[base_collect] construct: создана base_constructor_jobs ${bcJobId} (${merged.length} строк, locale ${locale})`);
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
    if (bcStatus === 'completed' || bcStatus === 'failed' || bcStatus === 'cancelled') {
      // IMPORT: failed/cancelled базу НЕ валит — импортируем частичный data,
      // если он есть, иначе идём в analyzing без обогащения.
      const imported = await importConstructRows(ctx, construct.bc_job_id);
      const failNote =
        bcStatus === 'completed'
          ? null
          : `конструктор завершился со статусом ${bcStatus}${bc?.error_message ? `: ${bc.error_message}` : ''}`;
      if (imported) {
        finalRows = imported.rows;
        finalEmailStatuses = imported.emailStatuses;
        if (imported.hasDescription) finalColumns = [...HE_AUTO_COLLECT_COLUMNS, 'description'];
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
        await ctx.supabase
          .from('he_bases')
          .update({
            status: 'failed',
            error: note.slice(0, 500),
            collect_info: { ...info, stats },
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
  // 2) релевант-гейт LLM → _low_relevance на строках вне вертикали (шум
  //    hh/карт/реестра): запуск фильтрует их в launchTemplate, refill — в
  //    selectRefillLeadRows. Пометки живут только в jsonb-строках: в columns
  //    не попадают, сетки UI и маппинг операторов их не видят.
  type StoredRow = HeUnifiedRow & { _email_status?: string; _low_relevance?: boolean };
  let storedRows: StoredRow[] = finalRows;
  if (finalEmailStatuses) {
    storedRows = storedRows.map((r, i) => {
      const st = finalEmailStatuses[i];
      return st ? { ...r, _email_status: st } : r;
    });
  }
  let lowRelevanceCount = 0;
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
      lowRelevanceCount = gate.flagged.size;
      storedRows = storedRows.map((r, i) =>
        gate.flagged.has(i) ? { ...r, _low_relevance: true } : r,
      );
      stageLog(ctx, `[base_collect] релевант-гейт: помечено ${lowRelevanceCount} строк вне вертикали`);
    }
  } catch (e) {
    stageLog(ctx, `[base_collect] релевант-гейт пропущен: ${e instanceof Error ? e.message : String(e)}`);
  }
  const statsWithQuality = { ...stats, low_relevance: lowRelevanceCount };

  // ─── REFILL (ENG auto-pipeline) ───
  // Вместо финала «analyzing + base_analyze»: долив валидных строк лидами в
  // уже запущенную кампанию, база → терминальный 'analyzed', итог — в
  // collect_info.refill_result и he_auto_pipeline_runs.
  if (isRefill) {
    return await runHeRefillAppend({
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
    .from('he_bases')
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
  if (updError) throw new Error(`he_bases harvest update: ${updError.message}`);

  const { error: jobError } = await ctx.supabase.from('he_jobs').insert({
    project_id: job.project_id,
    stage: 'base_analyze',
    status: 'pending',
    payload: { base_id: baseId },
  });
  if (jobError) throw new Error(`he_jobs base_analyze enqueue: ${jobError.message}`);

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
