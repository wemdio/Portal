/**
 * S1 — выборка свежих SDR/BDR-вакансий из eng_hiring_cache.
 *
 * Источник только jobhive (нативные ATS в кэше протухли 02.08.2026, план §3).
 * Дедуп по компании: одна строка на company_name, берём самую свежую вакансию.
 * Строки с country_code='remote'/NULL не берём — гео там недоказуемо.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PolzaOutreachConfig, PolzaOutreachVacancyCandidate } from './types';

// \m..\M — границы слова в POSIX-регулярке Postgres; iregex = регистронезависимо.
const SDR_TITLE_REGEX = '\\m(sdr|bdr|sales development|business development|outbound sales)\\M';
const MIN_DESCRIPTION_CHARS = 300;
const PAGE_SIZE = 500;
// Страховочный потолок сканирования строк кэша: чтобы набрать `limit` компаний
// после дедупа, просматриваем вакансии страницами до этого максимума.
const MAX_SCAN_ROWS = 5000;

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
      .filter('vacancy_title', 'iregex', SDR_TITLE_REGEX)
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
