/**
 * S1 — выборка свежих SDR/BDR-вакансий из eng_hiring_cache.
 *
 * Источник только jobhive (нативные ATS в кэше протухли 02.08.2026, план §3).
 * Дедуп по компании: одна строка на company_name, берём самую свежую вакансию.
 * Строки с country_code='remote'/NULL не берём — гео там недоказуемо.
 *
 * Раньше выборка отдавала ровно `limit` компаний и на этом конвейер
 * заканчивался: из ста вакансий до готовой цепочки доходили единицы, а
 * «лимит 100» в форме читался как «сто готовых компаний». Теперь выборка
 * умеет отдавать кандидатов волнами — раннер берёт следующую, пока не наберёт
 * нужное число готовых или пока кэш не кончится.
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
/** Сколько строк кэша просматриваем за одну волну, прежде чем сдаться. */
const MAX_SCAN_ROWS_PER_WAVE = 20000;

type CacheRow = {
  id: string;
  vacancy_title: string;
  vacancy_description: string | null;
  vacancy_url: string;
  country_code: string | null;
  published_at: string | null;
  company_name: string;
  company_description: string | null;
  company_site_url: string | null;
};

export interface VacancyWave {
  candidates: PolzaOutreachVacancyCandidate[];
  /** Смещение в кэше, с которого продолжать следующую волну. */
  nextOffset: number;
  /** Кэш закончился: следующих волн не будет. */
  exhausted: boolean;
}

export interface SelectVacanciesOptions {
  /** Сколько компаний нужно набрать в этой волне (по умолчанию config.limit). */
  want?: number;
  /** С какого места в кэше продолжать (конец прошлой волны). */
  startOffset?: number;
  /** Компании, уже взятые прошлыми волнами: ключ — нижний регистр названия. */
  seenCompanies?: Set<string>;
}

export async function selectVacancies(
  db: SupabaseClient,
  config: PolzaOutreachConfig,
  options: SelectVacanciesOptions = {},
): Promise<VacancyWave> {
  const want = Math.max(1, options.want ?? config.limit);
  const seen = options.seenCompanies ?? new Set<string>();
  const cutoff = new Date(Date.now() - config.posted_within_days * 86_400_000).toISOString();
  const now = new Date().toISOString();
  const countries = config.countries.map((c) => c.toLowerCase());

  const byCompany = new Map<string, PolzaOutreachVacancyCandidate>();
  let offset = Math.max(0, options.startOffset ?? 0);
  const scanStartedAt = offset;
  let exhausted = false;

  while (offset - scanStartedAt < MAX_SCAN_ROWS_PER_WAVE && byCompany.size < want) {
    const query = db
      .from('eng_hiring_cache')
      .select(
        'id,vacancy_title,vacancy_description,vacancy_url,country_code,published_at,company_name,company_description,company_site_url',
      )
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
    if (rows.length === 0) {
      exhausted = true;
      break;
    }

    let consumed = 0;
    for (const row of rows) {
      consumed += 1;
      if (byCompany.size >= want) break;
      // Точная проверка по границам слова: база отдала более широкий набор.
      if (!SDR_TITLE_RE.test(row.vacancy_title ?? '')) continue;
      const description = row.vacancy_description ?? '';
      if (description.trim().length <= MIN_DESCRIPTION_CHARS) continue;
      const company = row.company_name?.trim();
      if (!company) continue;

      const key = company.toLowerCase();
      if (seen.has(key)) continue;
      const candidate: PolzaOutreachVacancyCandidate = {
        vacancyId: row.id,
        jobTitle: row.vacancy_title,
        jobSourceUrl: row.vacancy_url,
        jobCountryCode: (row.country_code ?? '').toLowerCase(),
        jobPublishedAt: row.published_at,
        companyName: company,
        companyDescription: row.company_description,
        companySiteUrl: row.company_site_url,
        vacancyDescription: description,
      };
      // Страницы идут от свежих к старым: первая встреченная вакансия компании
      // и есть самая свежая — дальше только заполняем дыры новых компаний.
      if (!byCompany.has(key)) byCompany.set(key, candidate);
    }

    // Смещение двигаем ровно на просмотренные строки: волна может оборваться
    // на середине страницы, и следующая обязана продолжить с того же места,
    // иначе непросмотренный хвост страницы потеряется навсегда.
    offset += consumed;
    if (rows.length < PAGE_SIZE) {
      exhausted = true;
      break;
    }
  }

  return { candidates: [...byCompany.values()], nextOffset: offset, exhausted };
}
