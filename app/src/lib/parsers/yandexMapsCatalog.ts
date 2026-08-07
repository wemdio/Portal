import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { YandexMapsOrganization } from '@/lib/parsers/yandexMapsServiceClient';

/** Потолок выдачи за один запуск поиска по каталогу. Совпадает с limit в RPC. */
export const CATALOG_MAX_RESULTS = 50000;

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
export type CatalogRubric = { rubric: string; companies: number };
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
      .select('rubric, companies')
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
 * Считается с потолком, и потолок низкий намеренно: замер на боевых данных
 * показал 59 с на «Москва + Кафе» и 3,9 мин на «вся Россия + Кафе» при потолке
 * 200 тыс. — запрос честно добирал строки до упора. Пользователю в форме нужен
 * порядок величины, а не точное число, поэтому считаем до 20 тыс. и дальше
 * показываем «более 20 000».
 */
export async function countYandexMapsCatalog(
  filters: YandexMapsCatalogFilters,
  cap = 20000,
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
  return { total, capped: total >= cap };
}

/**
 * Страница выдачи каталога. Для перехода к следующей передавайте `after` —
 * yandex_id последней полученной строки (курсор по первичному ключу).
 */
export async function searchYandexMapsCatalog(
  filters: YandexMapsCatalogFilters,
  limit: number,
  after: string | null = null,
): Promise<YandexMapsCatalogRow[]> {
  if (!supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin.rpc('yandex_maps_catalog_search', {
    p_cities: cleanList(filters.cities),
    p_categories: cleanList(filters.categories),
    p_countries: cleanList(filters.countries),
    // Из своей базы не жалко отдать больше, чем позволял живой парсер:
    // это один SELECT, а не тысячи запросов в Яндекс.
    p_limit: Math.max(0, Math.min(CATALOG_MAX_RESULTS, Math.floor(limit))),
    p_offset: 0,
    p_after: after,
  });
  if (error) throw new Error(`Каталог Яндекс.Карт недоступен: ${error.message}`);
  return (Array.isArray(data) ? data : []) as YandexMapsCatalogRow[];
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

export function catalogRowToJobOrganization(jobId: string, row: YandexMapsCatalogRow) {
  const organization = catalogRowToOrganization(row);
  return { job_id: jobId, ...organization };
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
