/**
 * Роутинг кейсов Polza для английских писем (en-outreach-flow-improvements §6).
 *
 * Библиотека общая с «Нашим автоаутричем» (polza_ru_cases): кейс попадает в
 * английское письмо, только если он утверждён, клиент разрешил публикацию,
 * срок не истёк и у него есть английский текст. Подбор — по отраслевой
 * группе; нет совпадения — письмо 3 без кейса, «похожий» не притягиваем.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { IndustryGroup } from '@/lib/polzaRuOutreach/types';

export interface EnCase {
  caseId: string;
  segment: string;
  snippet: string;
  url: string | null;
  groups: string[];
}

export async function loadEnCases(db: SupabaseClient): Promise<EnCase[]> {
  const { data, error } = await db
    .from('polza_ru_cases')
    .select('case_id,case_text_en,case_segment_en,case_url,industry_groups,expires_at')
    .eq('status', 'approved')
    .eq('legal_publication_approved', true)
    .not('case_text_en', 'is', null);
  if (error) throw new Error(`cases load failed: ${error.message}`);
  const now = Date.now();
  return (data ?? [])
    .filter((c) => !c.expires_at || new Date(String(c.expires_at)).getTime() > now)
    .filter((c) => String(c.case_text_en ?? '').trim())
    .map((c) => ({
      caseId: String(c.case_id),
      segment: String(c.case_segment_en ?? 'B2B'),
      snippet: String(c.case_text_en).trim().replace(/[.\s]+$/, ''),
      url: c.case_url ? String(c.case_url) : null,
      groups: (c.industry_groups ?? []) as string[],
    }));
}

export function routeEnCase(cases: EnCase[], group: IndustryGroup | null): { record: EnCase; reason: string } | null {
  if (!group) return null;
  const hit = cases.find((c) => c.groups.includes(group));
  return hit ? { record: hit, reason: `industry group: ${group}` } : null;
}
