import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeVeCompanyInn, normalizeVeWebsiteHost } from './collectionIdentity';
import { veOfficialWebsiteCandidates } from './relevanceEvidence';
import { veCompanyFactKey, VE_COMPANY_FACT_TTL_MS } from './companyFacts';

type Candidate = { company: string; inn: string; website: string; address: string; email: string; category: string };
export interface VeCandidateHint { key: string; website: string; facts: string; observedAt: string; inns: string[]; ownerInns: string[] }
/** Only ordering changes. Missing evidence never rejects a candidate, and no
 * score or shared fact can grant admission to a hypothesis. Stable ties retain
 * the source's order; low-information candidates remain in the saved harvest. */
export function prioritizeVeCandidates<T extends Candidate>(rows: T[], hints: VeCandidateHint[] = [], focus = '', now = Date.now(), preserveOrder = false): T[] {
  const byKey = new Map<string, VeCandidateHint[]>();
  for (const hint of hints) {
    const age = now - Date.parse(hint.observedAt);
    if (!Number.isFinite(age) || age < 0 || age >= VE_COMPANY_FACT_TTL_MS || !veOfficialWebsiteCandidates(hint.website).length) continue;
    byKey.set(hint.key, [...(byKey.get(hint.key) ?? []), hint]);
  }
  const terms = [...new Set((focus.toLowerCase().match(/[\p{L}]{4,}/gu) ?? []).map((s) => s.slice(0, 5)))];
  const scored = rows.map((row, index) => {
    const inn = normalizeVeCompanyInn(row.inn);
    const sites = veOfficialWebsiteCandidates(row.website);
    const facts = (byKey.get(veCompanyFactKey(row) ?? '') ?? []).filter((hint) =>
      (!sites.length || sites.some((site) => normalizeVeWebsiteHost(site.href) === normalizeVeWebsiteHost(hint.website)))
      && (!inn || (hint.ownerInns.includes(inn) && hint.inns.every((item) => item === inn))));
    const best = facts.sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
    const prepared = best && !sites.length ? { ...row, website: best.website } : row;
    const text = [row.category, (row as T & { description?: string }).description ?? '', ...facts.map((hint) => hint.facts)].join(' ').toLowerCase();
    const profile = /[\p{L}]{4}/u.test(text);
    const hits = terms.filter((term) => text.includes(term)).length;
    const score = (best ? 100 : 0) + (profile ? 25 : 0) + Math.min(20, hits * 4)
      + (veOfficialWebsiteCandidates(prepared.website).length ? 30 : 0) + (row.email.trim() ? 5 : 0);
    return { row: prepared, score, index };
  });
  return (preserveOrder ? scored : scored.sort((a, b) => b.score - a.score || a.index - b.index)).map((entry) => entry.row);
}

export async function readVeCandidateHints(rows: Candidate[], db: SupabaseClient, signal?: AbortSignal): Promise<VeCandidateHint[]> {
  const keys = [...new Set(rows.map(veCompanyFactKey).filter((key): key is string => !!key))];
  const hints: VeCandidateHint[] = [];
  // Bound one scheduling tick; remaining candidates stay saved for later ticks.
  for (let start = 0; start < Math.min(keys.length, 2000); start += 200) {
    signal?.throwIfAborted();
    try {
      const { data, error } = await db.from('ve_company_fact_pages')
        .select('company_key,observed_at,website:page->>url,facts:page->>text,inns:page->inns,owner_inns:page->ownerInns')
        .in('company_key', keys.slice(start, start + 200)).eq('reader_version', 1)
        .gt('expires_at', new Date().toISOString()).order('observed_at', { ascending: false }).limit(2000)
        .abortSignal(signal ? AbortSignal.any([signal, AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000));
      signal?.throwIfAborted();
      if (error) break;
      for (const record of data ?? []) if (typeof record.website === 'string' && Array.isArray(record.inns)) hints.push({
        key: record.company_key, website: record.website, facts: String(record.facts ?? ''), observedAt: record.observed_at,
        inns: record.inns.filter((inn): inn is string => typeof inn === 'string'),
        ownerInns: Array.isArray(record.owner_inns) ? record.owner_inns.filter((inn): inn is string => typeof inn === 'string') : [],
      });
    } catch { signal?.throwIfAborted(); break; }
  }
  return hints;
}
