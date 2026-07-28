/**
 * Пересчёт potential_pct и rank вертикалей проекта после ручной разметки
 * гипотез (accept/reject на доске, he_hypotheses.status).
 *
 * Кластеризация (stages/clustering.ts) считает эти поля один раз по всем
 * верифицированным гипотезам; здесь они подстраиваются под разметку:
 *  - если в вертикали есть принятые гипотезы — % считается только по ним;
 *  - иначе — по всем неотклонённым (proposed);
 *  - все участники отклонены → potential_pct = 0, вертикаль уходит в конец
 *    рейтинга (у всех остальных % > 0 либо больше участников).
 * Rank 1..N по проекту — как при кластеризации: % desc → больше участников →
 * ниже min тир среди участников → имя. Пишутся только изменившиеся строки.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { computeVerticalPct } from './stages/clustering';
import type { HeHypothesis, HeVertical } from './types';

export interface RecomputedVertical {
  id: string;
  potential_pct: number;
  rank: number;
}

type VerticalRow = Pick<HeVertical, 'id' | 'name' | 'potential_pct' | 'rank'>;
type HypothesisRow = Pick<HeHypothesis, 'id' | 'vertical_id' | 'tier' | 'potential_pct' | 'status'>;

export async function recomputeProjectVerticalPcts(
  supabase: SupabaseClient,
  projectId: string,
): Promise<RecomputedVertical[]> {
  const { data: verticalRows, error: vError } = await supabase
    .from('he_verticals')
    .select('id, name, potential_pct, rank')
    .eq('project_id', projectId);
  if (vError) throw new Error(`he_verticals read: ${vError.message}`);

  const { data: hypRows, error: hError } = await supabase
    .from('he_hypotheses')
    .select('id, vertical_id, tier, potential_pct, status')
    .eq('project_id', projectId);
  if (hError) throw new Error(`he_hypotheses read: ${hError.message}`);

  const verticals = (verticalRows ?? []) as VerticalRow[];
  const hypotheses = (hypRows ?? []) as HypothesisRow[];

  interface Scored {
    id: string;
    name: string;
    prevPct: number;
    prevRank: number | null;
    pct: number;
    eligibleCount: number;
    minTier: number;
  }

  const scored: Scored[] = verticals.map((v) => {
    const members = hypotheses.filter((h) => h.vertical_id === v.id);
    const accepted = members.filter((m) => m.status === 'accepted');
    // Есть принятые → рейтинг по ним; иначе — по всем неотклонённым.
    const eligible = accepted.length ? accepted : members.filter((m) => m.status !== 'rejected');
    return {
      id: v.id,
      name: v.name,
      prevPct: v.potential_pct,
      prevRank: v.rank,
      pct: eligible.length ? computeVerticalPct(eligible.map((m) => m.potential_pct)) : 0,
      eligibleCount: eligible.length,
      minTier: eligible.reduce(
        (acc, m) => Math.min(acc, Number.isFinite(m.tier) ? m.tier : Number.POSITIVE_INFINITY),
        Number.POSITIVE_INFINITY,
      ),
    };
  });

  scored.sort(
    (a, b) =>
      b.pct - a.pct ||
      b.eligibleCount - a.eligibleCount ||
      a.minTier - b.minTier ||
      a.name.localeCompare(b.name),
  );

  const refreshed: RecomputedVertical[] = scored.map((s, i) => ({
    id: s.id,
    potential_pct: s.pct,
    rank: i + 1,
  }));

  // Пишем только строки, где % или rank реально изменились.
  for (let i = 0; i < scored.length; i++) {
    const s = scored[i];
    const rank = i + 1;
    if (s.prevPct === s.pct && s.prevRank === rank) continue;
    const { error } = await supabase
      .from('he_verticals')
      .update({ potential_pct: s.pct, rank })
      .eq('id', s.id);
    if (error) throw new Error(`he_verticals update: ${error.message}`);
  }

  return refreshed;
}
