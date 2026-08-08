import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { YandexMapsOrganization } from '@/lib/parsers/yandexMapsServiceClient';

/**
 * Потолка на выдачу нет: оператор выбрал места и сферы — значит ему нужны все
 * организации, а не произвольные 50 000 из них (столько забирали раньше).
 *
 * Ограничение осталось только на то, что выполняется **внутри HTTP-запроса**.
 * Сбор идёт через Kong, а тот рвёт соединение через 60 секунд, поэтому крупные
 * выборки уходят в очередь: задача заводится `pending`, и её доделывает воркер,
 * которому шлюз не указ. Порог — по числу организаций, а не по времени: 20 тыс.
 * строк вставляются за считанные секунды даже на холодном кэше.
 */
export const CATALOG_INLINE_LIMIT = 20000;

/**
 * Потолок предпросчёта «сколько найдётся». Нужен потому, что предпросчёт уходит
 * на каждое изменение фильтра: точный счёт по выборке в полмиллиона организаций
 * — это чтение сотен тысяч страниц кучи, и на каждый клик так ходить нельзя.
 * Выше потолка показываем «более N» — точная цифра там оператору и не нужна,
 * собраны всё равно будут все.
 */
export const CATALOG_PREVIEW_CAP = 100000;

export type YandexMapsCatalogFilters = {
  /** Выбранные места. Совпадение проверяется и по городу, и по региону. */
  cities?: string[];
  categories?: string[];
  countries?: string[];
};

export type YandexMapsCatalogRow = {
  yandex_id: string;
  name?: string | null;
  categories?: string | null;
  subcategories?: string | null;
  country?: string | null;
  city?: string | null;
  address?: string | null;
  phone?: string | null;
  mobile_phone?: string | null;
  all_phones?: string | null;
  website?: string | null;
  email?: string | null;
  card_url?: string | null;
  working_hours?: string | null;
  rating?: string | null;
  reviews_count?: string | null;
  telegram?: string | null;
  vkontakte?: string | null;
  instagram?: string | null;
  whatsapp?: string | null;
};

function cleanList(values: unknown): string[] {
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
    : [];
}

export function normalizeYandexMapsCatalogFilters(input: unknown): YandexMapsCatalogFilters | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  const filters: YandexMapsCatalogFilters = {
    cities: cleanList(value.cities),
    categories: cleanList(value.categories),
    countries: cleanList(value.countries),
  };
  return filters.cities?.length || filters.categories?.length || filters.countries?.length ? filters : null;
}

export function catalogHasFilters(input: unknown): boolean {
  return normalizeYandexMapsCatalogFilters(input) !== null;
}

export type CatalogPlace = { country: string; region: string; city: string; companies: number };
/** with_contacts — у скольких организаций рубрики есть телефон, сайт или почта. */
export type CatalogRubric = { rubric: string; companies: number; with_contacts: number };
export type CatalogDictionaries = { places: CatalogPlace[]; rubrics: CatalogRubric[] };

/**
 * Справочники для формы поиска. Берутся из самого каталога, а не из
 * захардкоженных списков: иначе на экране можно выбрать город или рубрику,
 * которых в базе нет, и запуск молча вернёт ноль организаций.
 */
export async function fetchYandexMapsCatalogDictionaries(): Promise<CatalogDictionaries> {
  if (!supabaseAdmin) return { places: [], rubrics: [] };
  const [placesResult, rubricsResult] = await Promise.all([
    supabaseAdmin
      .from('yandex_maps_catalog_places')
      .select('country, region, city, companies')
      .order('companies', { ascending: false })
      .limit(50000),
    supabaseAdmin
      .from('yandex_maps_catalog_rubrics')
      // Доля организаций с контактами отделяет рабочие рубрики от объектов
      // карты: «Скамейки» — вторая по размеру рубрика каталога, но телефон
      // есть у 20 записей из 554 тысяч, и для аутрича она пуста.
      .select('rubric, companies, with_contacts')
      .order('companies', { ascending: false })
      .limit(20000),
  ]);
  if (placesResult.error) throw new Error(`Справочник мест недоступен: ${placesResult.error.message}`);
  if (rubricsResult.error) throw new Error(`Справочник рубрик недоступен: ${rubricsResult.error.message}`);
  return {
    places: (placesResult.data ?? []) as CatalogPlace[],
    rubrics: (rubricsResult.data ?? []) as CatalogRubric[],
  };
}

/**
 * Сколько организаций найдётся по выбранным фильтрам.
 *
 * Потолок был 20 тыс., потому что на боевых данных предпросчёт «Москва + Кафе»
 * шёл 59 секунд. После индексов по токенам и настройки базы тот же запрос —
 * 0,79 с, поэтому потолок поднят до CATALOG_PREVIEW_CAP. Совсем убрать его
 * нельзя: предпросчёт уходит на каждое изменение фильтра.
 *
 * `cap = null` считает точно, без потолка — так спрашивает API, когда решает,
 * выполнять сбор в запросе или отдать воркеру.
 */
export async function countYandexMapsCatalog(
  filters: YandexMapsCatalogFilters,
  cap: number | null = CATALOG_PREVIEW_CAP,
): Promise<{ total: number; capped: boolean }> {
  if (!supabaseAdmin) return { total: 0, capped: false };
  const { data, error } = await supabaseAdmin.rpc('yandex_maps_catalog_count', {
    p_cities: cleanList(filters.cities),
    p_categories: cleanList(filters.categories),
    p_countries: cleanList(filters.countries),
    p_cap: cap,
  });
  if (error) throw new Error(`Не удалось посчитать организации: ${error.message}`);
  const total = Number(data ?? 0);
  return { total, capped: cap !== null && total >= cap };
}

/**
 * Складывает выдачу каталога прямо в результаты запуска — одним запросом
 * внутри базы, без чтения строк в Node.
 *
 * Раньше это делал воркер: читал каталог страницами по 2000 строк через
 * PostgREST и теми же страницами писал обратно, из-за чего данные дважды шли
 * по сети, а человек ждал очереди. Искать при этом нечего — всё уже лежит в
 * соседней таблице той же базы, и `insert ... select` укладывается в запрос
 * API: 50 тыс. строк за ~3 с на замере.
 *
 * Вызывается из двух мест: из API, когда выборка небольшая и её быстрее сделать
 * прямо в запросе, и из воркера — для всего остального.
 */
export async function fillJobFromYandexMapsCatalog(
  jobId: string,
  filters: YandexMapsCatalogFilters,
  /** null — забрать всё, что нашлось. Число — потолок (кабинет клиента, тариф). */
  limit: number | null = null,
): Promise<{ organizations: number; links: number }> {
  if (!supabaseAdmin) return { organizations: 0, links: 0 };
  const { data, error } = await supabaseAdmin.rpc('yandex_maps_catalog_fill_job', {
    p_job_id: jobId,
    p_cities: cleanList(filters.cities),
    p_categories: cleanList(filters.categories),
    p_countries: cleanList(filters.countries),
    p_limit: limit === null ? null : Math.max(0, Math.floor(limit)),
  });
  if (error) throw new Error(`Не удалось собрать выдачу из каталога: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { organizations?: number; links?: number } | null;
  return { organizations: Number(row?.organizations ?? 0), links: Number(row?.links ?? 0) };
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

// Яндекс открывает организацию по одному ID, без слага. Слаг из названия
// давал ссылки с процентными последовательностями на пол-адреса и не
// совпадал с card_url из снапшота, из-за чего одна компания дублировалась.
function fallbackCardUrl(row: YandexMapsCatalogRow): string {
  return `https://yandex.ru/maps/org/${text(row.yandex_id)}`;
}

export function catalogRowToOrganization(row: YandexMapsCatalogRow): YandexMapsOrganization {
  return {
    name: text(row.name),
    country: text(row.country),
    city: text(row.city),
    address: text(row.address),
    rating: text(row.rating),
    reviews_count: text(row.reviews_count),
    website: text(row.website),
    email: text(row.email),
    phone: text(row.all_phones || row.phone || row.mobile_phone),
    telegram: text(row.telegram),
    vk: text(row.vkontakte),
    instagram: text(row.instagram),
    whatsapp: text(row.whatsapp),
    card_url: text(row.card_url) || fallbackCardUrl(row),
    working_hours: text(row.working_hours),
    categories: [text(row.categories), text(row.subcategories)].filter(Boolean).join(' | '),
  };
}

export function yandexIdFromCardUrl(cardUrl: string): string | null {
  const matches = cardUrl.match(/(?:^|\/)(\d{5,})(?:[/?#]|$)/g);
  if (!matches?.length) return null;
  const value = matches[matches.length - 1]?.match(/\d{5,}/)?.[0];
  return value || null;
}

export async function upsertYandexMapsCatalogOrganizations(
  organizations: Array<YandexMapsOrganization & { country?: string; city?: string }>,
  sourceKind = 'parser',
): Promise<number> {
  if (!supabaseAdmin || !organizations.length) return 0;
  const rows = organizations.flatMap((organization) => {
    const yandexId = yandexIdFromCardUrl(text(organization.card_url));
    if (!yandexId) return [];
    return [{
      yandex_id: yandexId,
      name: text(organization.name),
      country: text(organization.country),
      city: text(organization.city),
      address: text(organization.address),
      rating: text(organization.rating),
      reviews_count: text(organization.reviews_count),
      website: text(organization.website),
      email: text(organization.email),
      phone: text(organization.phone),
      telegram: text(organization.telegram),
      vkontakte: text(organization.vk),
      instagram: text(organization.instagram),
      whatsapp: text(organization.whatsapp),
      card_url: text(organization.card_url),
      working_hours: text(organization.working_hours),
      categories: text(organization.categories),
      source_kind: sourceKind,
      source_file: 'live_parser',
    }];
  });
  let count = 0;
  for (let index = 0; index < rows.length; index += 100) {
    const { data, error } = await supabaseAdmin.rpc('yandex_maps_catalog_upsert_rows', {
      p_rows: rows.slice(index, index + 100),
    });
    if (error) throw new Error(`Не удалось пополнить каталог Яндекс.Карт: ${error.message}`);
    count += Number(data ?? 0);
  }
  return count;
}

export type DiscoveryTask = { id: number; country: string; place: string; rubric: string };

/**
 * Берёт из очереди следующую пару «место × рубрика» для поиска новых
 * организаций. Дневной бюджет обращений к Яндексу общий с остальными задачами.
 */
export async function claimYandexMapsCatalogDiscovery(
  limit: number,
  dailyLimit: number,
): Promise<DiscoveryTask[]> {
  if (!supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin.rpc('yandex_maps_catalog_claim_discovery', {
    p_limit: Math.max(1, Math.min(100, Math.floor(limit))),
    p_daily_limit: Math.max(0, Math.floor(dailyLimit)),
  });
  if (error) throw new Error(`Не удалось получить очередь обхода: ${error.message}`);
  return (Array.isArray(data) ? data : []) as DiscoveryTask[];
}

/**
 * Отсеивает уже известные организации. Это главная экономия механизма: из
 * выдачи Яндекса идентификатор виден прямо в ссылке, поэтому карточку мы
 * открываем только у тех, кого в каталоге ещё нет.
 */
export async function filterUnknownYandexIds(ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!supabaseAdmin || !unique.length) return new Set(unique);
  const known = new Set<string>();
  // Запрос ограничен по размеру, поэтому спрашиваем частями.
  for (let index = 0; index < unique.length; index += 1000) {
    const { data, error } = await supabaseAdmin.rpc('yandex_maps_catalog_known_ids', {
      p_ids: unique.slice(index, index + 1000),
    });
    if (error) throw new Error(`Не удалось сверить каталог: ${error.message}`);
    for (const row of (Array.isArray(data) ? data : []) as Array<string | { yandex_id: string }>) {
      known.add(typeof row === 'string' ? row : row.yandex_id);
    }
  }
  return new Set(unique.filter((id) => !known.has(id)));
}

export async function markYandexMapsCatalogSeen(
  seen: string[],
  task: DiscoveryTask,
  exhaustive: boolean,
): Promise<number> {
  if (!supabaseAdmin) return 0;
  const { data, error } = await supabaseAdmin.rpc('yandex_maps_catalog_mark_seen', {
    p_seen: [...new Set(seen.filter(Boolean))],
    p_country: task.country,
    p_place: task.place,
    p_rubric: task.rubric,
    p_exhaustive: exhaustive,
  });
  if (error) throw new Error(`Не удалось отметить организации: ${error.message}`);
  return Number(data ?? 0);
}

export async function finishYandexMapsCatalogDiscovery(
  id: number,
  stats: { seenLinks: number; foundNew: number; exhaustive: boolean; error?: string | null },
): Promise<void> {
  if (!supabaseAdmin) return;
  const { error } = await supabaseAdmin.rpc('yandex_maps_catalog_finish_discovery', {
    p_id: id,
    p_seen_links: stats.seenLinks,
    p_found_new: stats.foundNew,
    p_exhaustive: stats.exhaustive,
    p_error: stats.error ? String(stats.error).slice(0, 1000) : null,
  });
  if (error) throw new Error(`Не удалось закрыть задание обхода: ${error.message}`);
}

/** Счётчик дневного расхода обращений к Яндексу — общий на все фоновые задачи. */
export async function recordYandexMapsCatalogRefreshCompleted(count: number): Promise<void> {
  if (!supabaseAdmin || count <= 0) return;
  const { error } = await supabaseAdmin.rpc('yandex_maps_catalog_record_completed', {
    p_completed: Math.floor(count),
  });
  if (error) throw new Error(`Не удалось записать статистику обновления каталога: ${error.message}`);
}
