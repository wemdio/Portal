/**
 * Step 1 of the pipeline: cheap SQL pre-filter over the 2.2M-row
 * companies_directory registry. No network calls — only structured fields.
 * Larger companies are returned first so the limited shortlist is the most
 * promising slice for an event agency.
 */

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { DirectoryCompany, SelectFilters } from './types';

const DIRECTORY_COLUMNS =
  'id,name,inn,kpp,ogrn,address,region_code,okved_code,activity_type,employees_count,revenue,website,email,phones';

const MAX_LIMIT = 2000;

/** Pulls a targeted shortlist of companies from the registry. */
export async function selectCompanies(filters: SelectFilters): Promise<DirectoryCompany[]> {
  if (!supabaseAdmin) throw new Error('Supabase service role not configured');

  const limit = Math.min(Math.max(filters.limit, 1), MAX_LIMIT);

  let query = supabaseAdmin
    .from('companies_directory')
    .select(DIRECTORY_COLUMNS)
    .not('name', 'is', null)
    .order('employees_count', { ascending: false, nullsFirst: false })
    .limit(limit);

  if (filters.regionCodes && filters.regionCodes.length > 0) {
    query = query.in('region_code', filters.regionCodes);
  }

  if (filters.okvedPrefixes && filters.okvedPrefixes.length > 0) {
    const orExpr = filters.okvedPrefixes
      .map((p) => `okved_code.like.${p.replace(/[^0-9.]/g, '')}*`)
      .join(',');
    query = query.or(orExpr);
  }

  if (filters.minEmployees && filters.minEmployees > 0) {
    query = query.gte('employees_count', filters.minEmployees);
  }

  const { data, error } = await query;
  if (error) throw new Error(`companies_directory query failed: ${error.message}`);

  return (data ?? []) as DirectoryCompany[];
}
