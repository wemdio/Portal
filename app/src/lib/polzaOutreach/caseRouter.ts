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
import { caseAllowedForProduct, MIN_CASE_LEADS } from '@/lib/polzaRuOutreach/libraries';
import { rankCaseMatches, type CaseMatchContext } from '@/lib/outreachLlm/caseMatching';

export interface EnCase {
  caseId: string;
  segment: string;
  snippet: string;
  url: string | null;
  groups: string[];
  profiles?: string[];
  crossMarket?: boolean;
}

export async function loadEnCases(db: SupabaseClient): Promise<EnCase[]> {
  const { data, error } = await db
    .from('polza_ru_cases')
    .select('case_id,case_text_en,case_segment_en,case_url,industry_groups,expires_at,allowed_chains,leads_count,metrics')
    .eq('status', 'approved')
    .eq('legal_publication_approved', true)
    .not('case_text_en', 'is', null);
  if (error) throw new Error(`cases load failed: ${error.message}`);
  const now = Date.now();
  return (data ?? [])
    .filter((c) => !c.expires_at || new Date(String(c.expires_at)).getTime() > now)
    .filter((c) => String(c.case_text_en ?? '').trim())
    .filter((c) => c.metrics?.cold_email !== false && (c.metrics?.public_project === true || (typeof c.leads_count === 'number' && c.leads_count >= MIN_CASE_LEADS)))
    .filter((c) => c.metrics?.cross_market_reference === true || caseAllowedForProduct({ case_id: c.case_id, public_name: '', industry_groups: c.industry_groups ?? [], allowed_chains: c.allowed_chains ?? [], case_text_short: c.case_text_en }, 'classic_abroad'))
    .map((c) => ({
      caseId: String(c.case_id),
      segment: String(c.case_segment_en ?? 'B2B'),
      snippet: String(c.case_text_en).trim().replace(/[.\s]+$/, ''),
      url: c.case_url ? String(c.case_url) : null,
      groups: (c.industry_groups ?? []) as string[],
      profiles: Array.isArray(c.metrics?.outreach_profiles) ? c.metrics.outreach_profiles.filter((p: unknown) => typeof p === 'string') : [],
      crossMarket: c.metrics?.cross_market_reference === true,
    }));
}

/**
 * Кейс по отраслевой группе. Подходящих кейсов у группы бывает несколько, и
 * раньше всем доставался первый по порядку строк в базе: в запуске 23.09 у 72
 * из 100 готовых писем стоял один и тот же Bero.pro. Теперь кейс выбирается
 * среди подходящих по домену компании — устойчиво (у компании всегда один и
 * тот же) и вразнобой между компаниями.
 */
export function routeEnCase(cases: EnCase[], group: IndustryGroup | null, key = '', context?: CaseMatchContext): { record: EnCase; reason: string } | null {
  if (context) {
    const match = rankCaseMatches(cases.map((c) => ({ ...c, id: c.caseId, text: c.snippet })), group, { ...context, key }, 1)[0];
    return match ? { record: match.record, reason: match.reason } : null;
  }
  if (!group) return null;
  const hits = cases.filter((c) => c.groups.includes(group)).sort((a, b) => a.caseId.localeCompare(b.caseId));
  if (!hits.length) return null;
  let h = 0;
  for (const ch of key.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { record: hits[h % hits.length], reason: `industry group: ${group}` };
}
