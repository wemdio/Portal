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
 *  1. PLAN — один LLM-вызов (модель bulk): вертикаль + неотклонённые гипотезы
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
 *     хост без www/пути), исключение компаний из ДРУГИХ ve_bases того же
 *     проекта (иначе одна компания копилась в нескольких базах проекта через
 *     повторные сборки; для строк hh/карт это единственная точка исключения,
 *     для реестра — страховка после исключения на выборке), кап
 *     totalRowsCap(job) — limit из payload джобы
 *     (дефолт 10000). Ноль строк — база failed с разбором по задачам,
 *     джоба падает. Упавшие задачи фиксируются в collect_info, но не валят
 *     джобу, если хотя бы одна задача дала строки.
 *  5. CONSTRUCT — обогащение собранных строк конструктором баз
 *     (base_constructor_jobs: find_emails при бедной базе →
 *     enrich_descriptions по одной строке компании → split_emails →
 *     dedup_email → validate_emails → cap_emails_per_company; locale джобы
 *     по рынку).
 *     Пропускается, когда email уже есть у >50% строк (RU-источники богатые)
 *     или фаза завершалась ранее (construct.status='done' в collect_info).
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
 * У hh/карт
 * исключение остаётся только на мёрдже: продолжение для них требует
 * вариации поисковых запросов — future work.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CompaniesSearchFilters } from '@/app/api/client/companies-search/route';
import { searchRows } from '@/lib/companiesSearch/rpcSearch';
import { applyFundedFilters } from '@/lib/funded/queryFilters';
import { buildRolesRegex } from '@/lib/parsers/atsFilters';
import { domainToSiteUrl, resolveCompanyDomainViaPdl } from '@/lib/parsers/companyDomainResolver';
import { extractEmail, extractEmails } from '@/lib/tools/dfybUtils';
import { getVeDirectorySegmentStats } from '../dossierData';
import { callLLMWithSchema, getVeModel } from '../llm';
import { projectMarket, type VeMarket } from '../market';
import { findIrrelevantRows } from '../relevanceGate';
import { prepareSegmentationAudience } from '../segmentationAudit';
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
  completeVeRefillNoNew,
  runVeRefillAppend,
  type VeRefillResult,
} from './baseCollectRefill';
import {
  addUsage,
  newUsage,
  payloadString,
  readProject,
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
const YANDEX_RESULTS_PER_URL = 500;

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
    category: cell(row.okved_code),
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
    phone: cell(row.phone),
    address: cell(row.address),
    category: cell(row.categories),
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
export function dedupUnifiedRows(rows: VeUnifiedRow[]): VeUnifiedRow[] {
  const idxByExactKey = new Map<string, number>();
  const firstIdxByCompany = new Map<string, number>();
  const out: VeUnifiedRow[] = [];
  const mergedEmails = (left: string, right: string): string =>
    extractEmails(`${left}, ${right}`).join(', ');
  for (const row of rows) {
    const company = normalizeCompanyForDedup(row.company);
    if (!company) continue;
    const website = normalizeWebsiteForDedup(row.website);
    const key = `${company}|${website}`;
    const idx = firstIdxByCompany.get(company);
    if (idx === undefined) {
      firstIdxByCompany.set(company, out.length);
      idxByExactKey.set(key, out.length);
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
      const email = mergedEmails(out[idx].email, row.email);
      if (rowRich && !existingRich) {
        out[idx] = { ...row, email };
        idxByExactKey.set(key, idx);
      } else if (email !== out[idx].email) {
        out[idx] = { ...out[idx], email };
      }
      continue;
    }
    // У обеих строк непустые сайты: точный дубль пропускаем, разные домены
    // (дочки/филиалы) живут обе.
    const exactIdx = idxByExactKey.get(key);
    if (exactIdx !== undefined) {
      const email = mergedEmails(out[exactIdx].email, row.email);
      if (email !== out[exactIdx].email) out[exactIdx] = { ...out[exactIdx], email };
      continue;
    }
    idxByExactKey.set(key, out.length);
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

/**
 * Оценить company-level размер реестровой части плана. Складывать два
 * независимых среза нельзя: одна компания может проходить оба фильтра, а RPC
 * считает каждый срез отдельно. Поэтому точную цифру сохраняем только для
 * плана с одной directory-задачей; во всех остальных случаях UI получает
 * честную причину вместо ложной суммы.
 */
async function estimatePlanDirectorySegment(
  plan: VeSourcePlan,
  supabase: SupabaseClient,
): Promise<NonNullable<VeCollectInfo['estimate']>> {
  const directoryTasks = plan.tasks.filter((task) => task.source === 'companies_directory');
  if (directoryTasks.length === 0) {
    return {
      unique_companies: null,
      companies_with_email: null,
      note: 'В плане нет реестрового среза: размер оценивается по фактическим результатам источников.',
    };
  }
  if (directoryTasks.length > 1) {
    return {
      unique_companies: null,
      companies_with_email: null,
      note: 'В плане несколько пересекающихся реестровых срезов; их размеры не складываются.',
    };
  }

  const filters = mapDirectoryFilters(directoryTasks[0].directory_filters);
  const stats = await getVeDirectorySegmentStats(
    {
      okvedCodes: filters.okvedCodes ?? [],
      includeIp: filters.includeIp,
      regionCodes: filters.regionCodes,
      revenueFrom: filters.revenueFrom ?? undefined,
      revenueTo: filters.revenueTo ?? undefined,
      employeesFrom: filters.employeesFrom ?? undefined,
      employeesTo: filters.employeesTo ?? undefined,
      // Email — следующая ступень воронки, а не фильтр population estimate.
      // Иначе при hasEmail=true обе цифры искусственно становятся одинаковыми.
      requireEmail: false,
    },
    supabase,
  );
  return {
    unique_companies: stats.companies_unique_total,
    companies_with_email: stats.matched_companies_with_email ?? null,
    companies_with_phone: stats.matched_companies_with_phone ?? null,
    directory_rows_total: stats.directory_rows_total,
    ...(stats.error ? { note: `Оценка реестрового среза недоступна: ${stats.error}` } : {}),
  };
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

export type VeCollectSource = VeCollectTask['source'];

export type VeCollectTaskStatus = 'pending' | 'dispatched' | 'done' | 'failed';

export interface VeCollectTaskState {
  source: VeCollectSource;
  status: VeCollectTaskStatus;
  /** id дочерней джобы парсера; null у синхронного реестра. */
  child_job_id: string | null;
  /** Собрано строк (после завершения задачи). */
  rows: number;
  /** Снапшот задачи из плана (фильтры/запросы) — нужен на harvest. */
  task: VeCollectTask;
  /** Унифицированные строки задачи (реестр — сразу на dispatch). */
  harvest?: VeUnifiedRow[];
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
  estimate?: {
    unique_companies: number | null;
    companies_with_email: number | null;
    companies_with_phone?: number | null;
    directory_rows_total?: number | null;
    note?: string;
  };
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
    /** Реестр: строк пропущено ещё на выборке (уже собраны в других базах проекта). */
    excluded_during_fetch: number;
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
    /** Покрытие relevance-gate по уникальным company-группам. */
    relevance_checked_companies?: number;
    relevance_total_companies?: number;
    relevance_coverage_complete?: boolean;
    finished_at: string;
  };
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
): Promise<void> {
  const { error } = await ctx.supabase
    .from('ve_bases')
    .update({ collect_info: info, updated_at: new Date().toISOString() })
    .eq('id', baseId);
  if (error) throw new Error(`ve_bases collect_info update: ${error.message}`);
}

/* ─────────────────────────── Фаза PLAN ─────────────────────────── */

async function buildPlan(
  job: VeJob,
  ctx: VeStageContext,
  vertical: VeVertical,
  usage: VeUsage,
  market: VeMarket,
  hypothesisId: string | null,
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
    VeSourcePlanSchema,
    { model: getVeModel('bulk') },
  );
  addUsage(usage, llm);

  const withCatalog = await ensureCatalogSource(ctx, llm.data, promptInput, usage, market);
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
      model: getVeModel('bulk'),
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
      model: getVeModel('bulk'),
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
async function fetchDirectoryRows(
  ctx: VeStageContext,
  filters: CompaniesSearchFilters,
  limit: number,
  excludedKeys: VeBaseExclusionKeys,
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
      // Дубль другой базы: по email, имени (с ИНН-уточнением) или точно по ИНН.
      const pruned = pruneBaseRowAgainstExclusion(excludedKeys, mapDirectoryRow(r));
      if (!pruned) {
        excludedDuringFetch += 1;
        continue;
      }
      // Новых строк на странице может быть больше остатка до limit — лишние
      // не берём (они не попадают ни в базу, ни в исключения и будут
      // подобраны следующей сборкой-продолжением).
      if (rows.length < limit) {
        rows.push(pruned.email === cell(r.email) ? r : { ...r, email: pruned.email });
      }
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
    throw new Error('ve_projects.created_by пуст — дочерней джобе парсера некому принадлежать');
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
async function pollTask(ctx: VeStageContext, state: VeCollectTaskState, limit: number): Promise<void> {
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
 * (см. app/worker/verticalEngineV2.ts).
 */
async function requeueSelf(ctx: VeStageContext, job: VeJob, cooldownMs = 30_000): Promise<void> {
  const { error } = await ctx.supabase
    .from('ve_jobs')
    .update({
      status: 'pending',
      started_at: null,
      run_after: new Date(Date.now() + cooldownMs).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id);
  if (error) throw new Error(`ve_jobs requeue: ${error.message}`);
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
export interface VeBaseExclusionKeys {
  /** нормализованное имя → ИНН'ы, встреченные под ним в других базах. */
  nameInns: Map<string, Set<string>>;
  /** Все ИНН других баз (матч «то же юрлицо, другое написание»). */
  inns: Set<string>;
  /** Все email других баз: один и тот же контакт не должен попасть в разные запуски. */
  emails: Set<string>;
}

/** Совпадение юрлица исключает строку целиком, независимо от её контактов. */
function baseRowMatchesCompanyExclusion(
  keys: VeBaseExclusionKeys,
  row: Pick<VeUnifiedRow, 'company' | 'inn' | 'email'>,
): boolean {
  const innKey = normalizeInnForDedup(row.inn);
  if (innKey && keys.inns.has(innKey)) return true;
  const nameKey = normalizeCompanyForDedup(row.company);
  if (!nameKey) return false;
  const knownInns = keys.nameInns.get(nameKey);
  if (knownInns === undefined) return false;
  // Точное сравнение юрлиц только когда ИНН есть с обеих сторон.
  if (innKey && knownInns.size > 0) return knownInns.has(innKey);
  return true;
}

/**
 * Удалить из multi-email строки уже занятые контакты. Совпадение компании или
 * ИНН исключает всю строку; совпадение одного email — только этот email.
 * null означает, что после безопасного исключения строка целиком занята.
 */
export function pruneBaseRowAgainstExclusion(
  keys: VeBaseExclusionKeys,
  row: VeUnifiedRow,
): VeUnifiedRow | null {
  if (baseRowMatchesCompanyExclusion(keys, row)) return null;
  const emails = extractEmails(row.email);
  if (emails.length === 0) return row;
  const freshEmails = emails.filter((email) => !keys.emails.has(email));
  if (freshEmails.length === 0) return null;
  if (freshEmails.length === emails.length) return row;
  return { ...row, email: freshEmails.join(', ') };
}

/** Строка исключена целиком: занято юрлицо или все найденные email. */
export function baseRowMatchesExclusion(
  keys: VeBaseExclusionKeys,
  row: Pick<VeUnifiedRow, 'company' | 'inn' | 'email'>,
): boolean {
  if (baseRowMatchesCompanyExclusion(keys, row)) return true;
  const emails = extractEmails(row.email);
  return emails.length > 0 && emails.every((email) => keys.emails.has(email));
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
    const innKey = normalizeInnForDedup(innValue);
    if (innKey) keys.inns.add(innKey);
    const company = uploadField(rec, COMPANY_UPLOAD_COLUMNS);
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
  return keys;
}

export function buildBaseExclusionKeysFromRows(rows: unknown[]): VeBaseExclusionKeys {
  return addRowsToExclusionKeys(
    { nameInns: new Map<string, Set<string>>(), inns: new Set<string>(), emails: new Set<string>() },
    rows,
  );
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
): Promise<VeBaseExclusionKeys> {
  const { data, error } = await ctx.supabase
    .from('ve_bases')
    .select('data')
    .eq('project_id', projectId)
    .neq('status', 'failed')
    .neq('id', baseId);
  if (error) throw new Error(`ve_bases exclusion read: ${error.message}`);

  const keys: VeBaseExclusionKeys = {
    nameInns: new Map<string, Set<string>>(),
    inns: new Set<string>(),
    emails: new Set<string>(),
  };
  for (const row of (data ?? []) as Array<{ data?: unknown }>) {
    addRowsToExclusionKeys(keys, Array.isArray(row.data) ? row.data : []);
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
  base: Pick<VeAutoBase, 'id' | 'created_at'>,
): Promise<string | null> {
  const { data, error } = await ctx.supabase
    .from('ve_bases')
    .select('id, created_at')
    .eq('project_id', projectId)
    .eq('source', 'auto')
    .eq('status', 'collecting')
    .neq('id', base.id);
  if (error) throw new Error(`ve_bases collecting read: ${error.message}`);
  const older = ((data ?? []) as Array<Pick<VeAutoBase, 'id' | 'created_at'>>)
    .filter((candidate) => isOlderCollectingBase(base, candidate))
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
 * Шаги конструктора для авто-базы VE2: (поиск на сайтах, если база бедная)
 * → описания по одной строке компании → разнос адресов по строкам → дедуп
 * почт → ВАЛИДАЦИЯ → кап на компанию. AI-шагов
 * (ta_scoring/personalization) нет — генерация и скоринг остаются в Движке.
 *
 * validate_emails — ВСЕГДА: раньше конструктор запускался только при бедных
 * почтах, и базы реестра/карт (email уже есть, но это протухшие info@ из
 * ЕГРЮЛ-источников) уходили в рассылку без валидации — баунсы ложились на
 * домен клиента. find_emails — только когда email есть у ≤50% строк
 * (ENG-базы pdl/funded/eng_hiring, бедные hh-сборки).
 */
const CONSTRUCT_STEPS_AFTER_SPLIT = [
  'split_emails',
  'dedup_email',
  'validate_emails',
  'cap_emails_per_company',
];

/** Свыше этого размера enrich_descriptions (per-site фетчи) не укладывается в
 *  6-часовой таймаут конструктора — для больших баз шаг пропускаем. */
const CONSTRUCT_ENRICH_MAX_ROWS = 5000;

function constructStepsFor(merged: VeUnifiedRow[]): string[] {
  const withEmail = merged.filter((r) => r.email.trim() !== '').length;
  const poor = withEmail * 2 <= merged.length;
  const enrich = merged.length <= CONSTRUCT_ENRICH_MAX_ROWS ? ['enrich_descriptions'] : [];
  // enrich_descriptions зависит только от компании/сайта. Выполняем его до
  // split_emails: иначе до пяти адресов одной компании породят до пяти
  // одинаковых HTTP-запросов и способны выбить 6-часовой таймаут.
  return [...(poor ? ['find_emails'] : []), ...enrich, ...CONSTRUCT_STEPS_AFTER_SPLIT];
}
/** Канонические заголовки сетки конструктора (порядок — как VE_AUTO_COLLECT_COLUMNS). */
const CONSTRUCT_HEADERS_RU = ['Компания', 'Сайт', 'Email', 'Телефон', 'Вакансия', 'Адрес', 'Категория', 'Сотрудники', 'Выручка', 'ИНН', 'Источник'];
const CONSTRUCT_HEADERS_EN = ['Company', 'Site', 'Email', 'Phone', 'Vacancy', 'Address', 'Category', 'Employees', 'Revenue', 'INN', 'Source'];
/** Сколько ждём BC-джобу, прежде чем считать её зависшей (база → failed). */
const CONSTRUCT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/** Пауза между тиками ожидания BC-джобы (run_after). */
const CONSTRUCT_REQUEUE_MS = 60_000;

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
  ctx: VeStageContext,
  bcJobId: string,
): Promise<{
  status: string;
  error_message: string | null;
  selected_steps: string[] | null;
} | null> {
  const { data, error } = await ctx.supabase
    .from('base_constructor_jobs')
    .select('status, error_message, selected_steps')
    .eq('id', bcJobId)
    .maybeSingle();
  if (error) throw new Error(`base_constructor_jobs read: ${error.message}`);
  if (!data) return null;
  const row = data as { status?: unknown; error_message?: unknown; selected_steps?: unknown };
  return {
    status: String(row.status ?? ''),
    error_message: typeof row.error_message === 'string' ? row.error_message : null,
    selected_steps: Array.isArray(row.selected_steps)
      ? row.selected_steps.filter((step): step is string => typeof step === 'string')
      : null,
  };
}

async function dispatchConstructJob(input: {
  ctx: VeStageContext;
  ownerId: string | null | undefined;
  baseLabel: string;
  rows: VeUnifiedRow[];
  market: VeMarket;
}): Promise<{ bcJobId: string; locale: 'ru' | 'en'; steps: string[] }> {
  const { ctx, ownerId, baseLabel, rows, market } = input;
  if (!ownerId) {
    throw new Error('ve_projects.created_by пуст — джобе конструктора некому принадлежать');
  }
  const locale = market === 'us' ? 'en' : 'ru';
  const steps = constructStepsFor(rows);
  const bcJobId = await insertChildJob(ctx, 'base_constructor_jobs', {
    user_id: ownerId,
    file_name: `VE2 · ${baseLabel}`,
    status: 'pending',
    locale,
    selected_steps: steps,
    // Кап «до 5 почт на компанию» — ключ max, как читает STEP_RUNNERS воркера.
    step_config: { cap_emails_per_company: { max: 5 } },
    data: buildConstructGrid(rows, market),
    initial_row_count: rows.length,
    total_steps: steps.length,
  });
  return { bcJobId, locale, steps };
}

export interface VeConstructImport {
  rows: Array<VeUnifiedRow & { description: string }>;
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
  if (!Array.isArray(grid) || grid.length < 2) return null;

  const header = (grid[0] as unknown[]).map((h) => String(h ?? '').trim().toLowerCase());
  const idxByKey = new Map<string, number>();
  header.forEach((h, i) => {
    const key = CONSTRUCT_HEADER_MAP[h];
    if (key && !idxByKey.has(key)) idxByKey.set(key, i);
  });
  const statusIdx = header.indexOf('email статус');

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

export async function runBaseCollectStage(job: VeJob, ctx: VeStageContext): Promise<VeStageResult> {
  const usage = newUsage();
  const baseId = payloadString(job, 'base_id');
  // Лимит сборки из payload (route кладёт туда выбор пользователя): один на
  // всё — пагинация реестра, чтение дочерних джоб, итоговый кап базы.
  const limit = totalRowsCap(job);
  // Refill-режим ENG auto-pipeline: финал — долив в запущенную кампанию
  // (stages/baseCollectRefill.ts), а не analyzing + base_analyze.
  const isRefill = job.payload?.refill === true;

  const { data: baseRow, error: bError } = await ctx.supabase
    .from('ve_bases')
    .select('*')
    .eq('id', baseId)
    .single();
  if (bError || !baseRow) throw new Error(`ve_bases ${baseId}: ${bError?.message ?? 'not found'}`);
  const base = baseRow as VeAutoBase;

  if (base.source !== 'auto') {
    throw new Error(`ve_bases ${baseId}: source='${base.source ?? 'upload'}' — base_collect работает только с source='auto'`);
  }
  // Завершённую сборку не переигрываем. Честный провал (напр. ноль строк) ставит
  // базе терминальный статус И роняет джобу, а воркер повторяет её до
  // MAX_ATTEMPTS — каждая повторная попытка спотыкалась об этот guard и затирала
  // настоящую причину своим сообщением. No-op сохраняет причину в ve_bases.error.
  if (base.status === 'analyzing' || base.status === 'analyzed' || base.status === 'failed') {
    stageLog(ctx, `[base_collect] база ${baseId} уже в статусе '${base.status}' — повторная сборка не нужна`);
    return { result: { base_id: baseId, skipped: 'already_finished', base_status: base.status } };
  }
  if (base.status !== 'collecting') {
    throw new Error(`ve_bases ${baseId}: status='${base.status}' — сборка не начиналась`);
  }
  const olderCollectingBaseId = await findOlderCollectingBase(ctx, job.project_id, base);
  if (olderCollectingBaseId) {
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

  const info: VeCollectInfo =
    base.collect_info && typeof base.collect_info === 'object' ? base.collect_info : {};

  // ─── PLAN ───
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
    info.estimate = await estimatePlanDirectorySegment(plan, ctx.supabase);

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
        .from('ve_bases')
        .update({
          status: 'failed',
          error: note.slice(0, 500),
          collect_info: info,
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
    stageLog(ctx, `[base_collect] план: ${info.tasks.length} задач (${info.tasks.map((t) => t.source).join(', ')})`);
  }
  // Базы, чей план был сохранён до появления estimate, получают его при
  // следующем безопасном тике, не переигрывая LLM-план и сбор источников.
  if (!info.estimate && info.plan) {
    info.estimate = await estimatePlanDirectorySegment(info.plan, ctx.supabase);
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

  // Исключаем компании/контакты, уже собранные в других базах этого проекта. Для
  // реестра это страховка (основное исключение прошло на выборке), для
  // hh/карт — единственная точка исключения.
  const existingKeys = await getExcludedKeys();
  const kept = interleaved
    .map((row) => pruneBaseRowAgainstExclusion(existingKeys, row))
    .filter((row): row is VeUnifiedRow => row !== null);
  const excludedExisting = interleaved.length - kept.length;
  if (excludedExisting > 0) {
    stageLog(ctx, `[base_collect] исключено ${excludedExisting} строк — компании уже есть в других базах проекта`);
  }
  // Кап — после дедупа и исключения, как раньше после дедупа (limit уже
  // посчитан выше — тот же totalRowsCap(job)).
  const merged = kept.slice(0, limit);

  let stats: NonNullable<VeCollectInfo['stats']> = {
    tasks_total: tasks.length,
    tasks_done: done.length,
    tasks_failed: failed.length,
    rows_total: merged.length,
    excluded_existing_bases: excludedExisting,
    excluded_existing_bases_before_construct: excludedExisting,
    excluded_during_fetch: tasks.reduce((sum, t) => sum + (t.excluded_during_fetch ?? 0), 0),
    finished_at: new Date().toISOString(),
  };

  if (merged.length === 0) {
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
  const construct = info.construct;
  if ((!construct || construct.status === 'dispatched') && needsConstruct(merged)) {
    if (!construct?.bc_job_id) {
      // DISPATCH-CONSTRUCT: джоба конструктора (воркер baseConstructor клеймит
      // pending), её id — в collect_info.construct; дальше WAIT с паузой 60с.
      const { bcJobId, locale } = await dispatchConstructJob({
        ctx,
        ownerId: project.created_by,
        baseLabel: base.filename ?? baseId,
        rows: merged,
        market,
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
      // Джоба могла быть поставлена до обязательного split_emails. Её
      // row-level validation status нельзя безопасно прикрепить к первому
      // адресу merged-ячейки: лучший статус мог относиться ко второму.
      // Терминальную legacy-джобу не импортируем, а один раз пересобираем по
      // текущему контракту; новая selected_steps уже содержит split_emails.
      if (bc?.selected_steps && !bc.selected_steps.includes('split_emails')) {
        const replacement = await dispatchConstructJob({
          ctx,
          ownerId: project.created_by,
          baseLabel: base.filename ?? baseId,
          rows: merged,
          market,
        });
        info.construct = {
          bc_job_id: replacement.bcJobId,
          status: 'dispatched',
          dispatched_at: new Date().toISOString(),
          note: `legacy constructor job ${construct.bc_job_id} пересобирается с split_emails`,
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
      await requeueSelf(ctx, job, CONSTRUCT_REQUEUE_MS);
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
  const freshExistingKeys = await loadOtherBaseExclusionKeys(ctx, job.project_id, baseId);
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
  };
  let storedRows: StoredRow[] = finalRows;
  if (finalEmailStatuses) {
    storedRows = storedRows.map((r, i) => {
      const st = finalEmailStatuses[i];
      return st ? { ...r, _email_status: st } : r;
    });
  }
  let lowRelevanceCount = 0;
  let relevanceUncheckedCount = 0;
  let relevanceCheckedCompanies: number | null = null;
  let relevanceTotalCompanies: number | null = null;
  let relevanceCoverageComplete = false;
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
      verticalName,
      verticalSummary: (vrow as { summary?: string | null } | null)?.summary ?? '',
      hypothesisTitle,
      hypothesisDescription,
      language: market === 'us' ? 'en' : 'ru',
      log: (m) => stageLog(ctx, m),
    });
    usage.tokensUsed += gate.tokensUsed;
    usage.costUsd += gate.costUsd;
    lowRelevanceCount = gate.flagged.size;
    relevanceUncheckedCount = gate.unchecked.size;
    relevanceCheckedCompanies = gate.coverage.checkedCompanies;
    relevanceTotalCompanies = gate.coverage.totalCompanies;
    relevanceCoverageComplete = gate.coverage.complete;
    if (gate.flagged.size > 0 || gate.unchecked.size > 0) {
      storedRows = storedRows.map((r, i) =>
        gate.flagged.has(i)
          ? { ...r, _low_relevance: true }
          : gate.unchecked.has(i)
            ? { ...r, _relevance_unchecked: true }
            : r,
      );
    }
    stageLog(
      ctx,
      `[base_collect] релевант-гейт: проверено ${gate.coverage.checkedCompanies}/` +
        `${gate.coverage.totalCompanies} компаний; нерелевантных строк ${lowRelevanceCount}; ` +
        `без verdict ${relevanceUncheckedCount}`,
    );
  } catch (e) {
    // Неожиданный сбой вне never-throw контракта gate тоже fail-closed: ни одна
    // строка без verdict не должна попасть в проверенный итог или refill.
    relevanceUncheckedCount = storedRows.length;
    storedRows = storedRows.map((row) => ({ ...row, _relevance_unchecked: true }));
    stageLog(
      ctx,
      `[base_collect] релевант-гейт недоступен, все ${storedRows.length} строк исключены: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }
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
    ...(relevanceCheckedCompanies === null
      ? {}
      : { relevance_checked_companies: relevanceCheckedCompanies }),
    ...(relevanceTotalCompanies === null
      ? {}
      : { relevance_total_companies: relevanceTotalCompanies }),
    relevance_coverage_complete: relevanceCoverageComplete,
  };

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
