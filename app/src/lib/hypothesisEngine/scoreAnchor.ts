/**
 * Дата-якорь potential_pct: программный матч гипотезы к сегментам датасета
 * (словарь matchSegmentLabels внутри getSegmentStats) + фактический reply%
 * сегмента против baseline → ограниченная поправка LLM-оценки. До этого
 * potential_pct был незаякоренной оценкой модели, ни разу не сверенной с
 * измеримым спросом.
 *
 * Формула (намеренно простая и документированная):
 *   datasetScore = clamp(50 × reply_pct / baseline_pct, 5, 95)
 *     сегмент ровно на baseline → 50; вдвое выше → кап 95; вдвое ниже → 25;
 *   anchored = clamp(round(0.7 × llm + 0.3 × datasetScore), 0, 95)
 *     LLM-оценка остаётся ведущей (70%), данные только подтягивают (30%).
 *
 * Якорь применяется только при честных данных: словарный матч сегмента,
 * reply_pct и baseline_pct не null (гейты объёма датасета), рынок не 'us'.
 * Никогда не бросает: любой сбой датасета → оценка LLM без изменений.
 */

import { getSegmentStats } from './datasetStats';
import type { HeMarket } from './market';

export interface HePctAnchor {
  pct: number;
  /** true — якорь применён; note — читаемое обоснование для лога. */
  applied: boolean;
  note?: string;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export async function anchorPotentialPct(
  llmPct: number,
  hypothesisTitle: string,
  market: HeMarket,
): Promise<HePctAnchor> {
  if (market === 'us') return { pct: llmPct, applied: false };
  try {
    const stats = await getSegmentStats(hypothesisTitle, [], { market });
    if (stats.reply_pct === null || stats.baseline_pct === null || stats.baseline_pct <= 0) {
      return { pct: llmPct, applied: false };
    }
    const datasetScore = clamp((50 * stats.reply_pct) / stats.baseline_pct, 5, 95);
    const anchored = clamp(Math.round(0.7 * llmPct + 0.3 * datasetScore), 0, 95);
    return {
      pct: anchored,
      applied: true,
      note: `reply ${stats.reply_pct}% vs baseline ${stats.baseline_pct}% → dataset ${Math.round(datasetScore)} (${stats.matched_segments.join(', ')})`,
    };
  } catch {
    return { pct: llmPct, applied: false };
  }
}
