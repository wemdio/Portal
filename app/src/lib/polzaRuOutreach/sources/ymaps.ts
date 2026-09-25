/**
 * Яндекс Карты: новая точка сети, впервые увиденная в окне свежести, при том
 * что у сети есть точки старше окна. Повод «рост» с датой первого появления.
 * Каталог стоит с 28.08.2026 (прокси) — до починки свежих находок будет мало.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeDomain } from '../company';
import type { Signal } from '../types';

export interface YmapsCandidate {
  networkId: string;
  companyName: string;
  domain: string;
  signal: Signal;
}

export async function loadYmapsNewBranches(db: SupabaseClient, freshnessDays: number, limit: number): Promise<YmapsCandidate[]> {
  const since = new Date(Date.now() - freshnessDays * 86_400_000).toISOString();
  const { data, error } = await db.rpc('polza_ru_ymaps_new_branches', { p_since: since, p_limit: limit });
  if (error) throw new Error(`Яндекс Карты: ${error.message}`);
  const out: YmapsCandidate[] = [];
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const domain = normalizeDomain(String(r.website ?? ''));
    if (!domain) continue;
    const address = [r.city, r.address].filter((x) => typeof x === 'string' && x.trim()).join(', ');
    out.push({
      networkId: String(r.network_id),
      companyName: String(r.network_name ?? r.name ?? domain),
      domain,
      signal: {
        type: 'new_office', source: 'ymaps', title: address || 'новая точка сети', date: r.first_seen_at ? String(r.first_seen_at) : null,
        url: r.card_url ? String(r.card_url) : null, quote: null, level: 'B', meta: { network_id: r.network_id },
      },
    });
  }
  return out;
}
