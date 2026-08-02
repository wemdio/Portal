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
 *  2. DISPATCH — каждая pending-задача уходит в свой коллектор:
 *     companies_directory — синхронно через searchRows с пагинацией страницами
 *     по 1000 (строки сразу в задаче, дочерней джобы нет; кап — limit из
 *     payload джобы, см. totalRowsCap; компании других баз проекта
 *     пропускаются ещё на выборке — см. блок про продолжение ниже);
 *     hh_live / yandex_maps / google_maps — insert дочерней джобы
 *     (parser_jobs / yandex_maps_jobs / google_maps_jobs), её id — в
 *     child_job_id. collect_info персистится после каждой задачи.
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
 *     (дефолт 10000); he_bases → status='analyzing' и ставится
 *     стадия base_analyze. Ноль строк — база failed с разбором по задачам,
 *     джоба падает. Упавшие задачи фиксируются в collect_info, но не валят
 *     джобу, если хотя бы одна задача дала строки.
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
import { callLLMWithSchema, getHeModel } from '../llm';
import {
  buildSourcePlanMessages,
  type HeCollectTask,
  type HeSourcePlan,
} from '../prompts/sourcePlan';
import { HeSourcePlanSchema } from '../schemas';
import type { HeBase, HeJob, HeProject, HeVertical } from '../types';
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
const SAMPLE_ROWS = 30;
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

/**
 * Нормализация названия компании для дедупа: lowercase, срез юрформ
 * (ООО/ИП/АО/ПАО/ЗАО/ОАО/АНО/НКО и латинские LLC/LTD/INC/OOO — отдельными
 * словами, в любых кавычках; латинское IP НЕ срезаем — слишком коллизионно:
 * «IP Solutions»), удаление кавычек («»„“""'') и прочей пунктуации,
 * схлопывание пробелов. Иначе «ООО "ТЕРАБАЙТ"» из реестра и «ТЕРАБАЙТ»
 * из hh жили в базе обе.
 */
export function normalizeCompanyForDedup(name: string): string {
  let s = ` ${name.trim().toLowerCase()} `;
  // Пунктуация → пробел: кавычки всех стилей, дефисы, точки — всё небуквенное.
  s = s.replace(/[^0-9a-zа-яё\s]+/gi, ' ');
  // Юрформы отдельными словами (длинные формы раньше коротких: «пао» до «ао»).
  s = s.replace(/(^|\s)(ооо|ип|пао|зао|оао|ано|нко|ао|llc|ltd|inc|ooo)(?=\s|$)/g, ' ');
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

export interface HeCollectInfo {
  /** Лимит строк, выбранный при запуске сборки (route пишет при создании базы). */
  limit?: number;
  plan?: HeSourcePlan;
  /** Гипотезы, по которым реально строился план (accepted-дефолт или выбор специалиста). */
  hypotheses?: Array<{ id: string; title: string; status: string | null }>;
  tasks?: HeCollectTaskState[];
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

/** Таблица дочерней джобы по источнику (у реестра дочерней джобы нет). */
const CHILD_JOB_TABLE: Record<Exclude<HeCollectSource, 'companies_directory'>, string> = {
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
): Promise<{ plan: HeSourcePlan; usedHypotheses: Array<{ id: string; title: string; status: string | null }> }> {
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

  const llm = await callLLMWithSchema(
    buildSourcePlanMessages({
      verticalName: vertical.name,
      verticalSummary: vertical.summary,
      synonyms: Array.isArray(vertical.synonyms) ? vertical.synonyms : [],
      hypotheses,
      companyTypes,
    }),
    HeSourcePlanSchema,
    { model: getHeModel('bulk') },
  );
  addUsage(usage, llm);
  return {
    plan: llm.data,
    // Провенанс плана: по каким гипотезам реально строили (для collect_info и UI —
    // иначе на вопрос «точно все верно?» ответа нет ни в БД, ни на экране).
    usedHypotheses: hypotheses.map((h) => ({ id: h.id, title: h.title, status: h.status })),
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
 * Каждая строка сверяется с excludedKeys — нормализованными компаниями
 * других баз проекта (формат loadOtherBaseCompanyKeys: матч только по
 * компании через normalizeCompanyForDedup, как и на финальном мёрдже —
 * website в одном из источников может отсутствовать). Известные строки
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
  excludedKeys: Set<string>,
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
      const key = normalizeCompanyForDedup(cell(r.name));
      if (key && excludedKeys.has(key)) {
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

async function dispatchTask(
  ctx: HeStageContext,
  state: HeCollectTaskState,
  project: HeProject,
  limit: number,
  getExcludedKeys: () => Promise<Set<string>>,
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
    state.child_job_id = await insertChildJob(ctx, CHILD_JOB_TABLE.google_maps, {
      user_id: userId,
      status: 'queued',
      total_targets: inputLines.length,
      config: {
        inputLines,
        limitPerQuery: 100,
        language: 'ru',
        region: 'RU',
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
  const table = CHILD_JOB_TABLE[state.source as Exclude<HeCollectSource, 'companies_directory'>];
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
 * не раньше run_after (30с пауза между тиками ожидания дочерних парсеров;
 * без паузы цикл claim→requeue крутился с нулевой задержкой, ~10 запросов
 * к БД на итерацию в течение всего ожидания). Финальный done-апдейт воркер
 * пропускает, видя, что строка больше не running (см. app/worker/hypothesisEngine.ts).
 */
async function requeueSelf(ctx: HeStageContext, job: HeJob): Promise<void> {
  const { error } = await ctx.supabase
    .from('he_jobs')
    .update({
      status: 'pending',
      started_at: null,
      run_after: new Date(Date.now() + 30_000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id);
  if (error) throw new Error(`he_jobs requeue: ${error.message}`);
}

/* ─────────────────────────── Исключение чужих баз проекта ─────────────────────────── */

/**
 * Нормализованные ключи компаний из ДРУГИХ he_bases того же проекта (любой
 * source, любой статус кроме failed; текущая база исключена). Без этого одна
 * и та же компания копилась в нескольких базах проекта через повторные
 * сборки. Матч только по компании — website в одном из источников может
 * отсутствовать; компания — из колонки 'company'. data jsonb чужой базы и так читается целиком (одно поле
 * строки), поэтому slice до MAX_ROWS_LIMIT — лишь JS-предохранитель; он
 * обязан быть не меньше максимального размера базы: кап 10k при лимите
 * сборки до 50k отрезал хвост чужой базы из исключений, и вторая сборка
 * собирала компании 10001–50000 первой заново как «новые».
 */
async function loadOtherBaseCompanyKeys(
  ctx: HeStageContext,
  projectId: string,
  baseId: string,
): Promise<Set<string>> {
  const { data, error } = await ctx.supabase
    .from('he_bases')
    .select('data')
    .eq('project_id', projectId)
    .neq('status', 'failed')
    .neq('id', baseId);
  if (error) throw new Error(`he_bases exclusion read: ${error.message}`);

  const keys = new Set<string>();
  for (const row of (data ?? []) as Array<{ data?: unknown }>) {
    const rows = Array.isArray(row.data) ? row.data.slice(0, MAX_ROWS_LIMIT) : [];
    for (const item of rows) {
      const company = (item as Record<string, unknown> | null)?.company;
      if (typeof company !== 'string') continue;
      const key = normalizeCompanyForDedup(company);
      if (key) keys.add(key);
    }
  }
  return keys;
}

/* ─────────────────────────── Стадия ─────────────────────────── */

export async function runBaseCollectStage(job: HeJob, ctx: HeStageContext): Promise<HeStageResult> {
  const usage = newUsage();
  const baseId = payloadString(job, 'base_id');
  // Лимит сборки из payload (route кладёт туда выбор пользователя): один на
  // всё — пагинация реестра, чтение дочерних джоб, итоговый кап базы.
  const limit = totalRowsCap(job);

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

  const info: HeCollectInfo =
    base.collect_info && typeof base.collect_info === 'object' ? base.collect_info : {};

  // ─── PLAN ───
  if (!info.plan) {
    const { plan, usedHypotheses } = await buildPlan(job, ctx, vertical, usage);
    info.plan = plan;
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
  let excludedKeysCache: Set<string> | null = null;
  const getExcludedKeys = async (): Promise<Set<string>> => {
    if (!excludedKeysCache) {
      excludedKeysCache = await loadOtherBaseCompanyKeys(ctx, job.project_id, baseId);
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
  const kept = interleaved.filter((r) => !existingKeys.has(normalizeCompanyForDedup(r.company)));
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

  const { error: updError } = await ctx.supabase
    .from('he_bases')
    .update({
      columns: [...HE_AUTO_COLLECT_COLUMNS],
      sample_rows: merged.slice(0, SAMPLE_ROWS),
      data: merged,
      row_count: merged.length,
      status: 'analyzing',
      collect_info: { ...info, stats },
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
      rows: merged.length,
      tasks_done: done.length,
      tasks_failed: failed.length,
      failed_sources: failed.map((f) => f.source),
    },
    tokensUsed: usage.tokensUsed,
    costUsd: usage.costUsd,
  };
}
