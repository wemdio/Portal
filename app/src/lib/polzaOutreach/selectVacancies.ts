/**
 * S1 — выборка свежих SDR/BDR-вакансий из eng_hiring_cache.
 *
 * Источник только jobhive (нативные ATS в кэше протухли 02.08.2026, план §3).
 * Дедуп по компании: одна строка на company_name, берём самую свежую вакансию.
 * Строки с country_code='remote'/NULL не берём — гео там недоказуемо.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PolzaOutreachConfig, PolzaOutreachVacancyCandidate } from './types';

/**
 * Названия вакансий, которые нас интересуют.
 *
 * Раньше это была одна POSIX-регулярка, уезжавшая в PostgREST оператором
 * `iregex`, и он её не принимал вовсе:
 *   failed to parse filter (iregex.\m(sdr|bdr|...)\M)
 * Причины две сразу: оператора с таким именем у PostgREST нет, а скобки в
 * значении фильтра для него служебные и требуют кавычек.
 *
 * Поэтому отбор разнесён на два шага. База сужает выборку по подстрокам — это
 * она умеет без экзотики. Точное совпадение по границам слова проверяется уже
 * здесь, регуляркой JavaScript: `\b` делает ровно то же, что `\m..\M` в
 * Postgres. Подстрочный фильтр заведомо шире точного, поэтому по дороге не
 * теряется ни одна нужная вакансия — отсеиваются только лишние, вроде
 * «Ambassador» при поиске «bdr».
 */
const SDR_TITLE_TERMS = ['sdr', 'bdr', 'sales development', 'business development', 'outbound sales'];
const SDR_TITLE_RE = new RegExp(`\\b(${SDR_TITLE_TERMS.join('|')})\\b`, 'i');
const MIN_DESCRIPTION_CHARS = 300;
const PAGE_SIZE = 500;
// Страховочный потолок сканирования строк кэша: чтобы набрать `limit` компаний
// после дедупа, просматриваем вакансии страницами до этого максимума.
const MAX_SCAN_ROWS = 20000;

type CacheRow = {
  id: string;
  vacancy_title: string;
  vacancy_description: string | null;
  vacancy_url: string;
  country_code: string | null;
  published_at: string | null;
  company_name: string;
  company_description: string | null;
};

export async function selectVacancies(
  db: SupabaseClient,
  config: PolzaOutreachConfig,
): Promise<PolzaOutreachVacancyCandidate[]> {
  const cutoff = new Date(Date.now() - config.posted_within_days * 86_400_000).toISOString();
  const now = new Date().toISOString();
  const countries = config.countries.map((c) => c.toLowerCase());

  const byCompany = new Map<string, PolzaOutreachVacancyCandidate>();
  let offset = 0;

  while (offset < MAX_SCAN_ROWS && byCompany.size < config.limit) {
    const query = db
      .from('eng_hiring_cache')
      .select('id,vacancy_title,vacancy_description,vacancy_url,country_code,published_at,company_name,company_description')
      .eq('source', 'jobhive')
      .gte('published_at', cutoff)
      .lte('published_at', now)
      .or(SDR_TITLE_TERMS.map((term) => `vacancy_title.ilike.%${term}%`).join(','))
      .in('country_code', countries)
      .not('vacancy_description', 'is', null)
      .order('published_at', { ascending: false, nullsFirst: false })
      .range(offset, offset + PAGE_SIZE - 1);
    const { data, error } = await query;
    if (error) throw new Error(`polza outreach S1 cache select failed: ${error.message}`);

    const rows = (data ?? []) as unknown as CacheRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      if (byCompany.size >= config.limit) break;
      // Точная проверка по границам слова: база отдала более широкий набор.
      if (!SDR_TITLE_RE.test(row.vacancy_title ?? '')) continue;
      const description = row.vacancy_description ?? '';
      if (description.trim().length <= MIN_DESCRIPTION_CHARS) continue;
      const company = row.company_name?.trim();
      if (!company) continue;

      const key = company.toLowerCase();
      const candidate: PolzaOutreachVacancyCandidate = {
        vacancyId: row.id,
        jobTitle: row.vacancy_title,
        jobSourceUrl: row.vacancy_url,
        jobCountryCode: (row.country_code ?? '').toLowerCase(),
        jobPublishedAt: row.published_at,
        companyName: company,
        companyDescription: row.company_description,
        vacancyDescription: description,
      };
      // Страницы идут от свежих к старым: первая встреченная вакансия компании
      // и есть самая свежая — дальше только заполняем дыры новых компаний.
      if (!byCompany.has(key)) byCompany.set(key, candidate);
    }

    offset += rows.length;
    if (rows.length < PAGE_SIZE) break;
  }

  return [...byCompany.values()];
}
