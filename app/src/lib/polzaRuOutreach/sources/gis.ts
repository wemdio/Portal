/**
 * 2ГИС: компании, которые сигнальный конвейер 2ГИС уже проверил по сайту
 * (gis_signal_company_signals). Берём «несколько филиалов» как слабый повод
 * роста и «отдел продаж / целевая вакансия» как справку без выбора цепочки.
 * Большинство там — локальный B2C; его отсекает проверка B2B по сайту.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeDomain } from '../company';
import type { Signal } from '../types';

export interface GisCandidate {
  twogisId: string;
  companyName: string;
  domain: string;
  signals: Signal[];
}

function evidenceText(evidence: unknown, key: string): string | null {
  if (!evidence || typeof evidence !== 'object') return null;
  const v = (evidence as Record<string, unknown>)[key];
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null;
}

export async function loadGisCandidates(db: SupabaseClient, freshnessDays: number, limit: number): Promise<GisCandidate[]> {
  const since = new Date(Date.now() - freshnessDays * 86_400_000).toISOString();
  const { data, error } = await db.rpc('polza_ru_gis_candidates', { p_since: since, p_limit: limit });
  if (error) throw new Error(`2ГИС: ${error.message}`);
  const out: GisCandidate[] = [];
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const domain = normalizeDomain(String(r.domain ?? '')) ?? normalizeDomain(String(r.site ?? ''));
    if (!domain) continue;
    const url = `https://2gis.ru/firm/${String(r.twogis_id)}`;
    const signals: Signal[] = [];
    if (r.multi_office) {
      signals.push({
        type: 'new_office', source: 'gis', title: 'несколько филиалов', date: null, url,
        quote: evidenceText(r.evidence, 'multiOffice'), level: 'B', meta: { twogis_id: r.twogis_id, standing: true },
      });
    }
    if (r.sales_team) {
      signals.push({
        type: 'sales_team', source: 'gis', title: 'отдел продаж / вакансия продаж на сайте', date: r.checked_at ? String(r.checked_at) : null,
        url, quote: evidenceText(r.evidence, 'salesDept') ?? evidenceText(r.evidence, 'targetVacancy'), level: 'C',
      });
    }
    out.push({ twogisId: String(r.twogis_id), companyName: String(r.company_name ?? domain), domain, signals });
  }
  return out;
}
