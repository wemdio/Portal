/**
 * Стартапы Y Combinator из funded_companies (source='yc') — второй источник
 * английского аутрича (en-outreach-flow-improvements CEO, MVP v1).
 *
 * Повод — участие в батче: «usually this stage is about proving repeatable
 * GTM fast». Фильтр до загрузки: размер команды, страна, свежий батч и
 * отрасль не consumer/education/government — B2B подтверждает разбор сайта.
 * SEC Form D сюда не берём: без жёсткой чистки от фондов и SPV это мусор
 * (этап 2 плана CEO).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeDomain, PDL_COUNTRY_BY_CODE } from './resolveDomain';
import type { PolzaOutreachConfig } from './types';

export interface YcCompany {
  name: string;
  domain: string;
  website: string;
  batch: string;
  teamSize: number | null;
  country: string | null;
  industry: string | null;
  description: string | null;
  tags: string[];
  sourceUrl: string | null;
}

const EXCLUDED_INDUSTRIES = ['consumer', 'education', 'government'];

function batchYear(batch: string | null): number | null {
  const m = batch?.match(/(\d{4})/);
  return m ? Number(m[1]) : null;
}

export async function loadYcCompanies(db: SupabaseClient, config: PolzaOutreachConfig): Promise<YcCompany[]> {
  const countries = config.countries.map((c) => PDL_COUNTRY_BY_CODE[c]).filter(Boolean);
  const out: YcCompany[] = [];
  const seen = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('funded_companies')
      .select('name,website,batch,team_size,country,industry,description,short_description,tags,source_url')
      .eq('source', 'yc')
      .in('country', countries)
      .gte('team_size', config.min_employees)
      .lte('team_size', config.max_employees)
      .not('website', 'is', null)
      .order('team_size', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`YC companies load failed: ${error.message}`);
    for (const r of data ?? []) {
      const industry = r.industry ? String(r.industry).toLowerCase() : null;
      if (industry && EXCLUDED_INDUSTRIES.includes(industry)) continue;
      const year = batchYear(r.batch ? String(r.batch) : null);
      if (!year || year < config.yc_batch_from_year) continue;
      const domain = normalizeDomain(String(r.website ?? ''));
      if (!domain || !domain.includes('.') || seen.has(domain)) continue;
      seen.add(domain);
      out.push({
        name: String(r.name),
        domain,
        website: `https://${domain}`,
        batch: String(r.batch),
        teamSize: r.team_size != null ? Number(r.team_size) : null,
        country: r.country ? String(r.country) : null,
        industry,
        description: (r.short_description ?? r.description) ? String(r.short_description ?? r.description) : null,
        tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
        sourceUrl: r.source_url ? String(r.source_url) : null,
      });
    }
    if (!data || data.length < PAGE) break;
  }
  // Свежие батчи первыми: у них повод «доказать повторяемый GTM» самый живой.
  return out.sort((a, b) => (batchYear(b.batch) ?? 0) - (batchYear(a.batch) ?? 0));
}
