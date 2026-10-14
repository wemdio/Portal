/**
 * Общая база компаний (companies_directory) — кандидаты цепочки «Только
 * профиль» и данные о размере компании для скоринга.
 *
 * Запись базы не является поводом написать: она даёт только кандидата и
 * выручку/штат. Цепочка icp_only собирается, только если сайт компании
 * получил высокий ЦА-балл.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeInn } from '../company';

export interface DirectoryRow {
  inn: string | null;
  name: string;
  website: string;
  revenue: number | null;
  employees: number | null;
  okved: string | null;
  email: string | null;
}

export async function loadDirectoryCandidates(
  db: SupabaseClient,
  opts: { minRevenue: number; maxRevenue: number; minEmployees: number; limit: number; okvedPrefixes?: string[] },
): Promise<DirectoryRow[]> {
  // Префиксы ОКВЭД → регэксп по началу кода: «62.01» ловит 62.01 и 62.01.1,
  // «46.6» — 46.61…46.69, «28» — весь класс (у ОКВЭД после класса всегда точка).
  const okvedRegex = (opts.okvedPrefixes ?? []).length
    ? String.raw`^(` + (opts.okvedPrefixes ?? []).map((p) => p.replace(/\./g, String.raw`\.`)).join('|') + ')'
    : null;
  const { data, error } = await db.rpc('polza_ru_directory_candidates_v2', {
    p_min_revenue: opts.minRevenue,
    p_max_revenue: opts.maxRevenue,
    p_min_employees: opts.minEmployees,
    p_okved_regex: okvedRegex,
    p_limit: opts.limit,
  });
  if (error) throw new Error(`directory candidates failed: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>)
    .filter((r) => r.name && r.website)
    .map((r) => ({
      inn: normalizeInn(r.inn),
      name: String(r.name),
      website: String(r.website),
      revenue: r.revenue != null ? Number(r.revenue) : null,
      employees: r.employees_count != null ? Number(r.employees_count) : null,
      okved: r.okved_code ? String(r.okved_code) : null,
      email: r.email ? String(r.email) : null,
    }));
}

/** Выручка и штат по ИНН для кандидатов из других источников. */
export async function loadSizeByInn(
  db: SupabaseClient,
  inns: string[],
): Promise<Map<string, { revenue: number | null; employees: number | null; website: string | null }>> {
  const out = new Map<string, { revenue: number | null; employees: number | null; website: string | null }>();
  const unique = Array.from(new Set(inns.filter(Boolean)));
  for (let i = 0; i < unique.length; i += 500) {
    const { data, error } = await db
      .from('companies_directory')
      .select('inn,revenue,employees_count,website')
      .in('inn', unique.slice(i, i + 500));
    if (error) throw new Error(`directory size lookup failed: ${error.message}`);
    for (const r of data ?? []) {
      if (!r.inn) continue;
      out.set(String(r.inn), {
        revenue: r.revenue != null ? Number(r.revenue) : null,
        employees: r.employees_count != null ? Number(r.employees_count) : null,
        website: r.website ? String(r.website) : null,
      });
    }
  }
  return out;
}
