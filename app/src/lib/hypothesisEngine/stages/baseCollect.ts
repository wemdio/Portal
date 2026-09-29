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
import { buildCatalogRepairMessagesEn, buildSourcePlanMessagesEn } from '../prompts/sourcePlan.en';
import { HeCatalogRepairSchema, HeSourcePlanSchema } from '../schemas';
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
   * Ключа нет — план пришёл от планировщика как есть. outcome='failed' объясняет
   * тонкую базу: каталога не было и добавить его не вышло.
   */
  plan_repair?: HePlanRepair;
  /**
   * Проба каталожного среза на принадлежность вертикали
   * (ensureSliceMatchesVertical, market='us'). Ключа нет — пробы не было
   * (RU-план, план без каталога или проба не состоялась).
   */
  slice_probe?: HeSliceProbe;
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
  sliceProbe?: HeSliceProbe;
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

/** Выборка из среза одной задачи: те же коллекторы, только с крошечным лимитом. */
async function sampleCatalogSlice(
  ctx: HeStageContext,
  task: HeCollectTask,
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

  const retried: HeCollectTask = {
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

  // ─── PLAN ───
  if (!info.plan) {
    const { plan, planRepair, sliceProbe, usedHypotheses } = await buildPlan(job, ctx, vertical, usage, market);
    info.plan = plan;
    if (planRepair) info.plan_repair = planRepair;
    if (sliceProbe) info.slice_probe = sliceProbe;
    info.hypotheses = usedHypotheses;

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
  const tasks = info.tasks ?? [];

  // Ключи компаний других баз проекта: нужны реестру ещё на DISPATCH
  // (исключение на выборке — продолжение больших сегментов) и повторно на
  // HARVEST (страховка для строк hh/карт). Лениво + мемоизация: на тиках
  // чистого ожидания дочерних парсеров лишнего чтения he_bases нет.
  let excludedKeysCache: HeBaseExclusionKeys | null = null;
  const getExcludedKeys = async (): Promise<HeBaseExclusionKeys> => {
    if (!excludedKeysCache) {
      excludedKeysCache = await loadOtherBaseExclusionKeys(ctx, job.project_id, baseId, market);
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
  const kept = interleaved.filter((r) => !matchesExclusion(existingKeys, r.company, r.inn, r.website));
  const excludedExisting = interleaved.length - kept.length;
  if (excludedExisting > 0) {
    stageLog(ctx, `[base_collect] исключено ${excludedExisting} строк — компании уже есть в других базах проекта`);
  }
  // Кап — после дедупа и исключения, как раньше после дедупа (limit уже
  // посчитан выше: totalRowsCap(job), у refill — уменьшенный под дневной кап).
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
    // Пишем ДО диспатча: если диспатч упадёт и воркер повторит джобу, гейт не
    // будет оплачен второй раз.
    await persistCollectInfo(ctx, baseId, info);
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
      await persistCollectInfo(ctx, baseId, info);
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
    if (bcStatus === 'completed' || bcStatus === 'failed' || bcStatus === 'cancelled') {
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
              collect_info: { ...info, stats },
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
      info,
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
    collect_info: { ...info, stats: statsWithQuality },
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
   */
  let updErrorMsg: string | null = null;
  for (let attempt = 1; attempt <= HARVEST_WRITE_ATTEMPTS; attempt += 1) {
    const { error } = await ctx.supabase.from('he_bases').update(harvestRow).eq('id', baseId);
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
    // среза: воркер повторит джобу, повтор попадёт в ЭТУ ЖЕ ветку (harvest и
    // запись гейта лежат в collect_info, гейт второй раз не платится) и
    // перезапишет тот же текст, а базу в терминальном статусе
    // repairBaseAfterCollectFinalFail не трогает — причина доживает до кабинета.
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
