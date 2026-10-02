import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Постраничное чтение организаций запуска ЯКарт — для выгрузки и списка.
 *
 * Раньше страницы шли «order by created_at, offset N». Запуск по каталогу
 * вставляет строки пачками с одним created_at (194 тысячи строк — семь разных
 * меток времени), и порядок внутри метки не определён: страницы задваивали и
 * теряли строки, а дальние offset на таблице в 9,5 млн строк упирались в
 * лимит времени запроса. Выгрузка обрывалась на первых пяти тысячах.
 *
 * Теперь ключ страницы — card_url: он уникален внутри запуска, и по нему есть
 * индекс (job_id, card_url), так что каждая страница — короткий проход по
 * индексу. Строки без card_url (бывают у живого парсинга) идут отдельной
 * последней страницей.
 */

export const ORGANIZATIONS_PAGE = 5000;

export interface OrganizationPage<T> {
  rows: T[];
  /** Курсор следующей страницы; null — страниц с card_url больше нет. */
  nextAfter: string | null;
}

/** Одна страница по card_url после курсора after (null — с начала). */
export async function fetchOrganizationPage<T = Record<string, unknown>>(
  supabase: SupabaseClient,
  jobId: string,
  after: string | null,
  limit = ORGANIZATIONS_PAGE,
): Promise<OrganizationPage<T>> {
  let query = supabase
    .from('yandex_maps_organizations')
    .select('*')
    .eq('job_id', jobId)
    .not('card_url', 'is', null)
    .order('card_url', { ascending: true })
    .limit(limit);
  if (after !== null) query = query.gt('card_url', after);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Record<string, unknown>[];
  const last = rows[rows.length - 1];
  return {
    rows: rows as T[],
    nextAfter: rows.length === limit && last ? String(last.card_url) : null,
  };
}

/** Строки запуска без card_url — их немного, одной выборкой. */
export async function fetchOrganizationsWithoutCard<T = Record<string, unknown>>(
  supabase: SupabaseClient,
  jobId: string,
): Promise<T[]> {
  const { data, error } = await supabase
    .from('yandex_maps_organizations')
    .select('*')
    .eq('job_id', jobId)
    .is('card_url', null);
  if (error) throw new Error(error.message);
  return (data ?? []) as T[];
}

/** Все строки запуска страницами: сначала с card_url, в конце — без него. */
export async function* iterateOrganizations(
  supabase: SupabaseClient,
  jobId: string,
): AsyncGenerator<Record<string, unknown>[]> {
  let after: string | null = null;
  for (;;) {
    const page: OrganizationPage<Record<string, unknown>> = await fetchOrganizationPage(supabase, jobId, after);
    if (page.rows.length) yield page.rows;
    if (page.nextAfter === null) break;
    after = page.nextAfter;
  }
  const rest = await fetchOrganizationsWithoutCard(supabase, jobId);
  if (rest.length) yield rest;
}
