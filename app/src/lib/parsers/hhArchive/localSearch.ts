/**
 * Локальный поиск по накопленной истории `hh_vacancies` для парсера
 * «HH архив». Раньше preview и runner ходили в api.hh.ru — но HH API отдаёт
 * вакансии только за последние ~60 дней, поэтому любые запросы за старые
 * периоды возвращали 0 (см. инцидент 27.07.2026 — «HH архив выдаёт 0»).
 *
 * Теперь ищем прямо в `hh_vacancies`: обычный HH-парсер спецов льёт туда
 * с 04.02.2026 (~760К уникальных vacancy_id к июлю 2026), а auto-pipeline
 * Mailganer (см. hhAutoParser.ts sinkJobId) добавляет ежедневный поток.
 *
 * Плюс: работает без внешней сети, без прокси, мгновенно.
 * Минус: за периоды до 04.02.2026 всегда 0 — юзеру про это говорит плашка
 * в UI (см. HHArchiveParserView.tsx).
 */

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { findRegionById } from './regions';

/**
 * HH area ID → региональное название строкой (как хранится в
 * `hh_vacancies.area`). Возвращает `null`, если фильтровать по региону не
 * надо (юзер выбрал «Вся Россия» = 113 или ничего). Неизвестные ID
 * (мелкие города за пределами топ-100 HH_REGIONS) отбрасываются — они
 * редки и живая ротация словаря стоит отдельной задачи.
 */
export function areaIdsToNames(ids: string[]): string[] | null {
  const cleaned = ids.map((s) => s.trim()).filter(Boolean);
  if (cleaned.length === 0) return null;
  // «113» = вся Россия. Даже если юзер выбрал ещё какие-то регионы вместе
  // с 113 — 113 покрывает всё, лишний ANY-фильтр только сузит выдачу.
  if (cleaned.includes('113')) return null;

  const names = new Set<string>();
  for (const id of cleaned) {
    const region = findRegionById(id);
    if (region) names.add(region.name);
  }
  return names.size > 0 ? Array.from(names) : null;
}

export interface LocalSearchFilters {
  /** ILIKE '%query%' по hh_vacancies.name. Пустая строка — не фильтруем. */
  query: string;
  /** HH area IDs как в UI (например ['1', '2'] = Москва + Питер). */
  areaIds: string[];
  /** ISO date 'YYYY-MM-DD' — нижняя граница по published_at. */
  dateFrom?: string;
  /** ISO date 'YYYY-MM-DD' — верхняя граница по published_at. */
  dateTo?: string;
}

/**
 * Считает, сколько строк в `hh_vacancies` подпадает под фильтры. Это
 * НЕ уникальные vacancy_id — одна и та же вакансия может встречаться
 * несколько раз (у обычного парсера и sink-задания разные job_id).
 * Для preview этого достаточно: юзер оценивает «имеет смысл запускать
 * или пусто». Реальный runner дедупит по vacancy_id.
 */
export async function countVacanciesLocal(filters: LocalSearchFilters): Promise<number> {
  if (!supabaseAdmin) throw new Error('supabaseAdmin not configured');

  const areaNames = areaIdsToNames(filters.areaIds);

  let q = supabaseAdmin
    .from('hh_vacancies')
    .select('vacancy_id', { count: 'exact', head: true });

  if (filters.query.trim()) {
    q = q.ilike('name', `%${filters.query.trim()}%`);
  }
  if (areaNames && areaNames.length > 0) {
    q = q.in('area', areaNames);
  }
  if (filters.dateFrom) {
    q = q.gte('published_at', `${filters.dateFrom}T00:00:00Z`);
  }
  if (filters.dateTo) {
    q = q.lte('published_at', `${filters.dateTo}T23:59:59Z`);
  }

  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

export interface LocalVacancyRow {
  vacancy_id: string;
  name: string;
  url: string;
  company_name: string;
  company_url: string | null;
  employer_id: string | null;
  company_site_url: string | null;
  area: string;
  published_at: string | null;
}

/**
 * Забирает уникальные вакансии из локального архива под фильтры.
 * Дедуп по vacancy_id — берём первую (самая свежая по published_at DESC).
 * Пагинация батчами по 1000 через .range(); останавливаемся, когда набрали
 * `limit` уникальных или закончились данные.
 */
export async function fetchVacanciesLocal(
  filters: LocalSearchFilters,
  limit: number,
  /**
   * Отмена (единый жизненный цикл задач). Один запрос — до 500 батчей по
   * 1000 строк, и без сигнала остановка воркера ждала бы конца всего чанка.
   * С ним оборванный батч возвращается сразу, а цикл выходит на ближайшей
   * границе. Необязателен: preview и старые вызовы работают как раньше.
   */
  signal?: AbortSignal,
): Promise<LocalVacancyRow[]> {
  if (!supabaseAdmin) throw new Error('supabaseAdmin not configured');
  if (limit <= 0) return [];

  const areaNames = areaIdsToNames(filters.areaIds);
  const BATCH = 1000;
  const seen = new Set<string>();
  const out: LocalVacancyRow[] = [];

  let offset = 0;
  // Hard верхняя граница на всякий случай: 500К записей = ~500 итераций.
  // В реальности набирается 5-50К за 10-50 батчей.
  const MAX_ITERATIONS = 500;

  for (let iter = 0; iter < MAX_ITERATIONS; iter += 1) {
    if (signal?.aborted) return out;
    let q = supabaseAdmin
      .from('hh_vacancies')
      .select('vacancy_id,name,url,company_name,company_url,employer_id,company_site_url,area,published_at')
      .order('published_at', { ascending: false, nullsFirst: false })
      .range(offset, offset + BATCH - 1);

    // Только когда сигнал передан: в вызовах без него цепочка билдера остаётся
    // ровно прежней (включая фейк PostgREST в тестах).
    if (signal) q = q.abortSignal(signal);
    if (filters.query.trim()) q = q.ilike('name', `%${filters.query.trim()}%`);
    if (areaNames && areaNames.length > 0) q = q.in('area', areaNames);
    if (filters.dateFrom) q = q.gte('published_at', `${filters.dateFrom}T00:00:00Z`);
    if (filters.dateTo) q = q.lte('published_at', `${filters.dateTo}T23:59:59Z`);

    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const row of data as LocalVacancyRow[]) {
      if (!seen.has(row.vacancy_id)) {
        seen.add(row.vacancy_id);
        out.push(row);
        if (out.length >= limit) return out;
      }
    }

    if (data.length < BATCH) break;
    offset += BATCH;
  }

  return out;
}

/**
 * Дата самой старой записи в hh_vacancies — для UI-плашки
 * «Данные из локального архива с {дата}. За более ранние периоды 0».
 * Кэшируется на 1 час: min() потенциально тяжёлое, но граница крайне
 * медленно меняется (только когда истечёт retention или чистят таблицу).
 */
let cachedOldest: { at: number; value: string | null } | null = null;
export async function getOldestVacancyDate(): Promise<string | null> {
  const ONE_HOUR = 60 * 60 * 1000;
  if (cachedOldest && Date.now() - cachedOldest.at < ONE_HOUR) {
    return cachedOldest.value;
  }
  if (!supabaseAdmin) return null;
  try {
    const { data } = await supabaseAdmin
      .from('hh_vacancies')
      .select('published_at')
      .not('published_at', 'is', null)
      .order('published_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    const value = (data?.published_at as string | null) ?? null;
    cachedOldest = { at: Date.now(), value };
    return value;
  } catch {
    return cachedOldest?.value ?? null;
  }
}
