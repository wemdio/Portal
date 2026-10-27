import type { PoolClient } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { TWO_GIS_IMPORT_LOCK } from '@/lib/twoGis/importSnapshot';
import { VeTwoGisSnapshotError, withVeTwoGisReadOnly } from './twoGisSource';
// baseCollect берёт 2ГИС только отсюда: twoGisSource напрямую импортируют лишь этот модуль и воркер.
export { VeTwoGisUnavailableError } from './twoGisSource';
import { veTwoGisCityKey, type VeTwoGisCardRow } from './twoGisRows';

/**
 * Страница снимка 2ГИС для близнеца (план 26.10, R3 «Страница»). Только воркер:
 * модуль тянет pg через twoGisSource. Один вызов — одна короткая read-only
 * транзакция (заметка 18): тихо проверить импорт, сверить сборку ve2.card_features
 * со снимком и флагом базы и прочитать одну страницу. Исходы для одной базы
 * (идёт импорт, флаг устарел) — значения, а не исключения: исключение внутри
 * withVeTwoGisReadOnly считается сбоем базы и после трёх подряд ставит паузу всем.
 * Сборка не на текущем снимке — VeTwoGisSnapshotError: она общая для всех баз,
 * считается в статусе, но паузу не ставит и соединение не рвёт, так что каждый
 * близнец уходит на своём первом чтении. Сдерживания по снимку нет: для 3b
 * 'snapshot' → retire близнеца, сохранённый до следующего диспатча. Плохой вход
 * отсекается до транзакции и сбоем не считается.
 *
 * Ничего не пишет и не предполагает, что вызывающий сохраняет состояние между
 * страницами: журнал пишется по странице, курсор — один раз в конце диспатча,
 * после сбоя повтор перечитывает свои заявки (решение чата VE2, п.8).
 *
 * Строка http-only сайта несёт website 'http://host'. В 3b строки близнеца со
 * строками других источников не сливаются: каждая точка слияния их снимает, а сам
 * близнец dedupUnifiedRows не зовёт. Когда карантин снимут (часть 5), слияние с
 * голым host той же компании из другого источника оставит website первой строки —
 * порядок слияния или перенос схемы решает часть 5.
 */
export const VE_TWO_GIS_WINDOW_IDS = 20_000;
export const VE_TWO_GIS_PAGE_ROWS = 500;
export const VE_TWO_GIS_MAX_RUBRICS = 8;

/** Что базе можно брать вопреки флагам карточки (решает VE2 по рубрикам и тексту гипотезы). */
export interface VeTwoGisAllow { nonCompany: boolean; privateRubric: boolean; ipName: boolean; government: boolean }

export interface VeTwoGisPageInput {
  /** Снимок и таблица сайтов из флага базы (collect_info.two_gis_source). */
  flag: { snapshot_id: number; features_version: number };
  rubrics: readonly string[];
  /** card_id, после которого читать; '' — с начала (id карточек не пусты). */
  after: string;
  /** Только veTwoGisQueryScope(two_gis_query): {} — вся Россия. */
  scope: { region_codes?: string[]; cities?: string[] };
  allow: VeTwoGisAllow;
  /** Не больше строк на выходе (≤ 500). */
  limit: number;
}

export interface VeTwoGisBuild { snapshotId: number; featuresVersion: number }

export type VeTwoGisPageResult =
  | { kind: 'import' }
  | { kind: 'stale'; build: VeTwoGisBuild }
  | { kind: 'page'; rows: VeTwoGisCardRow[]; cursor: string; exhausted: boolean; windowIds: number };

type QueryClient = Pick<PoolClient, 'query'>;

function rubricsOf(input: VeTwoGisPageInput): string[] {
  const rubrics = [...new Set(input.rubrics.map((value) => String(value).trim()).filter(Boolean))];
  if (!rubrics.length || rubrics.length > VE_TWO_GIS_MAX_RUBRICS) {
    throw new Error(`2ГИС: страница принимает 1–${VE_TWO_GIS_MAX_RUBRICS} рубрик, передано ${rubrics.length}`);
  }
  return rubrics;
}

/**
 * Текст и параметры страницы. Текст зависит только от числа рубрик (1–8): без
 * имени запроса node-postgres берёт custom plan, и «$k OR …» сворачиваются.
 * Окно — первые 20 000 card_id по рубрикам после курсора; из него — горячие
 * карточки (cf.hot: новый живой домен) по географии и флагам, одна на домен
 * сайта, не больше limit. Телефон, почта, сайт и соцсети карточки не читаются:
 * сайт строки — cf.host.
 */
export function buildVeTwoGisPageQuery(input: VeTwoGisPageInput): { text: string; values: unknown[] } {
  const rubrics = rubricsOf(input);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > VE_TWO_GIS_PAGE_ROWS) {
    throw new Error(`2ГИС: размер страницы ${input.limit} вне 1–${VE_TWO_GIS_PAGE_ROWS}`);
  }
  if (typeof input.after !== 'string') throw new Error('2ГИС: курсор страницы не строка');
  const regionCodes = [...new Set(input.scope.region_codes ?? [])];
  const cityKeys = [...new Set((input.scope.cities ?? []).map(veTwoGisCityKey).filter(Boolean))];
  const branches = rubrics.map((_, index) => `    (SELECT cs.card_id FROM public.card_subcategories cs`
    + ` WHERE cs.value = $${10 + index} AND cs.card_id > $1::text ORDER BY cs.card_id LIMIT ${VE_TWO_GIS_WINDOW_IDS})`);
  const text = `WITH win AS MATERIALIZED (
  SELECT DISTINCT u.card_id FROM (
${branches.join('\n    UNION ALL\n')}
  ) u ORDER BY u.card_id LIMIT ${VE_TWO_GIS_WINDOW_IDS}),
bounds AS (SELECT count(*)::int AS window_ids, max(win.card_id) AS window_last FROM win),
hits AS MATERIALIZED (
  SELECT DISTINCT ON (cf.registrable_domain) cf.card_id, cf.registrable_domain, cf.host, cf.site_scheme, cf.region_code
  FROM win JOIN ve2.card_features cf ON cf.card_id = win.card_id
  WHERE cf.hot
    AND ($2::boolean OR cf.region_code = ANY($3::text[]) OR cf.city_key = ANY($4::text[]))
    AND ($5::boolean OR NOT cf.is_non_company) AND ($6::boolean OR NOT cf.is_private_rubric)
    AND ($7::boolean OR NOT cf.is_ip_name) AND ($8::boolean OR NOT cf.is_government)
  ORDER BY cf.registrable_domain, cf.card_id),
page AS (
  SELECT h.card_id, h.registrable_domain, h.host, h.site_scheme, h.region_code, c.name, c.city_name
  FROM (SELECT * FROM hits ORDER BY hits.card_id LIMIT $9::int) h JOIN public.cards c ON c.id = h.card_id)
SELECT b.window_ids, b.window_last, p.* FROM bounds b LEFT JOIN page p ON true ORDER BY p.card_id NULLS LAST`;
  return { text, values: [input.after, !regionCodes.length && !cityKeys.length, regionCodes, cityKeys,
    input.allow.nonCompany, input.allow.privateRubric, input.allow.ipName, input.allow.government, input.limit, ...rubrics] };
}

/**
 * Курсор следующей страницы. Полная страница — с последней выданной карточки:
 * в окне могли остаться ещё. Неполная — окно разобрано, дальше с его конца;
 * источник исчерпан, когда и окно было неполным. Сравнение — только на равенство:
 * порядок card_id задаёт сортировка базы.
 */
export function nextVeTwoGisCursor(after: string, page: { rows: readonly { card_id: string }[]; windowIds: number;
  windowLast: string | null }, limit: number): { cursor: string; exhausted: boolean } {
  const full = page.rows.length >= limit;
  const cursor = full ? page.rows[page.rows.length - 1].card_id : page.windowLast ?? after;
  if (page.windowIds > 0 && cursor === after) throw new Error('2ГИС: курсор страницы не продвинулся');
  return { cursor, exhausted: !full && page.windowIds < VE_TWO_GIS_WINDOW_IDS };
}

const count = (value: unknown) => (value == null ? null : Number(value));

/**
 * Проверка сборки внутри транзакции: тихо — идёт ли импорт, затем сборка против текущего
 * снимка и флага базы. Глобальная рассинхронизация — VeTwoGisSnapshotError.
 */
async function readVeTwoGisBuildWith(client: QueryClient, flag: VeTwoGisPageInput['flag']):
  Promise<{ kind: 'import' } | { kind: 'stale'; build: VeTwoGisBuild } | { kind: 'current'; build: VeTwoGisBuild }> {
  const lock = await client.query('SELECT pg_try_advisory_xact_lock_shared(hashtext($1)) AS locked', [TWO_GIS_IMPORT_LOCK]);
  if (lock.rows[0]?.locked !== true) return { kind: 'import' };
  // Чтение card_features держит AccessShareLock до конца транзакции: подмена сборки не встанет между проверкой и страницей.
  const state = await client.query(`SELECT bs.snapshot_id, bs.features_version,
  (SELECT ds.id FROM public.dataset_snapshots ds ORDER BY ds.imported_at DESC, ds.id DESC LIMIT 1) AS current_snapshot_id,
  (SELECT cf.features_version FROM ve2.card_features cf LIMIT 1) AS table_features_version
FROM ve2.build_state bs WHERE bs.singleton`);
  const row = state.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new VeTwoGisSnapshotError('2ГИС: ve2.build_state пуст — сборка Ш5 не завершена');
  const build: VeTwoGisBuild = { snapshotId: Number(row.snapshot_id), featuresVersion: Number(row.features_version) };
  if (count(row.current_snapshot_id) !== build.snapshotId) {
    throw new VeTwoGisSnapshotError('2ГИС: сборка ve2.card_features не на текущем снимке');
  }
  if (count(row.table_features_version) !== build.featuresVersion) {
    throw new VeTwoGisSnapshotError('2ГИС: ve2.card_features не совпадает с build_state');
  }
  if (flag.snapshot_id !== build.snapshotId || flag.features_version !== build.featuresVersion) {
    return { kind: 'stale', build };
  }
  return { kind: 'current', build };
}

/** Внутри read-only транзакции withVeTwoGisReadOnly: сам ничего не перехватывает. */
export async function readVeTwoGisPageWith(client: QueryClient, input: VeTwoGisPageInput): Promise<VeTwoGisPageResult> {
  const query = buildVeTwoGisPageQuery(input); // неверный вход — до первого запроса
  // Окно — Merge Append → Unique; HashAggregate+Sort на проде втрое медленнее (EXPLAIN 26.10).
  await client.query('SET LOCAL enable_hashagg = off');
  const checked = await readVeTwoGisBuildWith(client, input.flag);
  if (checked.kind !== 'current') return checked;
  const page = await client.query(query.text, query.values);
  const rows = (page.rows as Array<Record<string, unknown>>).filter((item) => item.card_id != null).map((item): VeTwoGisCardRow => ({
    card_id: String(item.card_id), registrable_domain: String(item.registrable_domain), host: String(item.host),
    site_scheme: item.site_scheme === 'http' ? 'http' : 'https',
    region_code: item.region_code == null ? null : String(item.region_code),
    name: String(item.name ?? ''), city_name: String(item.city_name ?? ''),
  }));
  const head = (page.rows[0] ?? {}) as Record<string, unknown>;
  const windowIds = Number(head.window_ids ?? 0);
  const next = nextVeTwoGisCursor(input.after, { rows, windowIds,
    windowLast: head.window_last == null ? null : String(head.window_last) }, input.limit);
  return { kind: 'page', rows, cursor: next.cursor, exhausted: next.exhausted, windowIds };
}

/** Одна страница — один вызов withVeTwoGisReadOnly. Неверный вход бросает до транзакции и сбоем базы не считается. */
export async function readVeTwoGisPage(input: VeTwoGisPageInput,
  options: { db?: SupabaseClient; now?: () => Date } = {}): Promise<VeTwoGisPageResult> {
  buildVeTwoGisPageQuery(input);
  return withVeTwoGisReadOnly((client) => readVeTwoGisPageWith(client, input), options);
}

/** Словарь рубрик для подбора: больше этого — отказ у вызывающего (как у каталога Яндекса). */
export const VE_TWO_GIS_DICTIONARY_MAX = 5000;
export interface VeTwoGisRubricCount { label: string; cards: number }
export type VeTwoGisDictionaryResult = { kind: 'import' } | { kind: 'stale'; build: VeTwoGisBuild }
  | { kind: 'dictionary'; rubrics: VeTwoGisRubricCount[] };

/**
 * Рубрики снимка с числом карточек по стране (facet_subcategories) — под той же проверкой
 * импорта и сборки: импортёр очищает facet_subcategories в своей транзакции. Лишняя строка
 * (LIMIT 5001) показывает переполнение; отказ — у вызывающего, не исключением здесь:
 * исключение внутри транзакции считается сбоем базы.
 */
export async function readVeTwoGisRubricDictionaryWith(client: QueryClient, flag: VeTwoGisPageInput['flag']): Promise<VeTwoGisDictionaryResult> {
  const checked = await readVeTwoGisBuildWith(client, flag);
  if (checked.kind !== 'current') return checked;
  const result = await client.query(`SELECT fs.value AS label, sum(fs.row_count)::bigint AS cards FROM public.facet_subcategories fs
WHERE btrim(fs.value) <> '' GROUP BY fs.value ORDER BY fs.value LIMIT ${VE_TWO_GIS_DICTIONARY_MAX + 1}`);
  return { kind: 'dictionary', rubrics: (result.rows as Array<Record<string, unknown>>).map((row) => ({
    label: String(row.label), cards: Number(row.cards) || 0 })) };
}

const DICTIONARY_TTL_MS = 10 * 60_000;
let dictionaryCache: { key: string; at: number; read: Promise<VeTwoGisDictionaryResult> } | null = null;

/**
 * Один вызов withVeTwoGisReadOnly (заметка 18). Кэш процесса — одна запись на снимок и таблицу
 * сайтов, 10 мин, общий для одновременных вызовов; хранится только прочитанный словарь —
 * импорт, устаревший флаг и сбой запись снимают. Результат общий: вызывающий его не меняет.
 */
export async function readVeTwoGisRubricDictionary(flag: VeTwoGisPageInput['flag'],
  options: { db?: SupabaseClient; now?: () => Date } = {}): Promise<VeTwoGisDictionaryResult> {
  const key = `${flag.snapshot_id}:${flag.features_version}`;
  const at = (options.now ?? (() => new Date()))().getTime();
  if (dictionaryCache?.key === key && at - dictionaryCache.at < DICTIONARY_TTL_MS) return dictionaryCache.read;
  const entry = { key, at, read: withVeTwoGisReadOnly((client) => readVeTwoGisRubricDictionaryWith(client, flag), options) };
  dictionaryCache = entry;
  try {
    const result = await entry.read;
    if (result.kind !== 'dictionary' && dictionaryCache === entry) dictionaryCache = null;
    return result;
  } catch (error) {
    if (dictionaryCache === entry) dictionaryCache = null;
    throw error;
  }
}
