/**
 * Яндекс.Директ: компании, чья реклама встретилась в выдаче парсера
 * (yandex_direct_results, блоки topads/bottomads). Это факт «компания сейчас
 * покупает рекламу» уровня B: запрос и дата наблюдения — поля записи.
 * Органическая выдача рекламой не считается.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeDomain } from '../company';

export interface DirectHit {
  domain: string;
  keyword: string | null;
  title: string | null;
  url: string | null;
  seenAt: string;
}

export async function loadDirectHits(db: SupabaseClient, freshnessDays: number): Promise<DirectHit[]> {
  const since = new Date(Date.now() - freshnessDays * 86_400_000).toISOString();
  const byDomain = new Map<string, DirectHit>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('yandex_direct_results')
      .select('domain,keyword,title,url,created_at,source')
      .eq('source', 'direct')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`yandex_direct_results load failed: ${error.message}`);
    for (const r of data ?? []) {
      const domain = normalizeDomain(String(r.domain ?? ''));
      if (!domain || byDomain.has(domain)) continue;
      byDomain.set(domain, {
        domain,
        keyword: r.keyword ? String(r.keyword) : null,
        title: r.title ? String(r.title) : null,
        url: r.url ? String(r.url) : null,
        seenAt: String(r.created_at),
      });
    }
    if (!data || data.length < PAGE) break;
  }
  return Array.from(byDomain.values());
}
