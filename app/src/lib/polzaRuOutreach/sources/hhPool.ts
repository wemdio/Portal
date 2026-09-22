/**
 * Кандидаты из hh_vacancies — вакансии, которые портал и так собирает каждый день.
 *
 * Один вызов RPC polza_ru_hh_employers на запуск (полный проход таблицы ~30 с),
 * дальше раннер режет список на волны в памяти. Строка = работодатель; внутри
 * до десяти свежих вакансий, свежие первыми.
 *
 * Словари: в России функция SDR называется по-разному, поэтому ищем не только
 * «SDR» (SPEC §3.2). Название — лишь повод посмотреть вакансию; допуск в оффер
 * решает дословная цитата из полного текста (analyze.ts).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Найм SDR / активных продаж (INSTRUCTION_02). */
export const SDR_TITLE_PATTERN = [
  '\\msdr\\M', '\\mbdr\\M', 'sales development', 'business development', 'менеджер по развитию',
  'развити[ея] бизнеса', 'активн\\w* продаж', 'холодн\\w* (продаж|звонк|поиск)', 'лидогенерац',
  'привлечени\\w* (новых )?клиент', 'b2b', 'руководител\\w* отдела продаж', '\\mроп\\M',
  'коммерческ\\w* директор', 'по работе с партн[её]р', 'дилерск', 'экспорт',
].join('|');

/** Вакансии продаж шире SDR: сигнал «компания усиливает продажи» (SPEC §3). */
export const SALES_TITLE_PATTERN = [
  SDR_TITLE_PATTERN, 'менеджер по продажам', 'менеджер отдела продаж', 'специалист по продажам',
  'директор по продажам', 'head of sales', 'key account', 'аккаунт.менеджер', 'менеджер по работе с клиентами',
  'менеджер по оптов', 'тендерн',
].join('|');

export interface HhVacancyRef {
  vacancy_id: string;
  name: string;
  url: string | null;
  published_at: string | null;
}

export interface HhEmployerCandidate {
  employerKey: string;
  employerId: string | null;
  companyName: string;
  companySiteUrl: string | null;
  vacancyCount: number;
  latestPublishedAt: string | null;
  vacancies: HhVacancyRef[];
}

export async function loadHhEmployers(
  db: SupabaseClient,
  opts: { pattern: string; freshnessDays: number; minVacancies?: number },
): Promise<HhEmployerCandidate[]> {
  const since = new Date(Date.now() - opts.freshnessDays * 86_400_000).toISOString();
  const { data, error } = await db.rpc('polza_ru_hh_employers', {
    p_pattern: `(${opts.pattern})`,
    p_since: since,
    p_min_vacancies: opts.minVacancies ?? 1,
  });
  if (error) throw new Error(`hh candidates query failed: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    employerKey: String(row.employer_key),
    employerId: row.employer_id ? String(row.employer_id) : null,
    companyName: String(row.company_name ?? '').trim(),
    companySiteUrl: row.company_site_url ? String(row.company_site_url) : null,
    vacancyCount: Number(row.vacancy_count ?? 0),
    latestPublishedAt: row.latest_published_at ? String(row.latest_published_at) : null,
    vacancies: Array.isArray(row.vacancies)
      ? (row.vacancies as Array<Record<string, unknown>>).map((v) => ({
          vacancy_id: String(v.vacancy_id),
          name: String(v.name ?? ''),
          url: v.url ? String(v.url) : null,
          published_at: v.published_at ? String(v.published_at) : null,
        }))
      : [],
  })).filter((c) => c.companyName && c.vacancies.length > 0);
}
