/** Specialist preferences are research directions, never facts about the client. */
import { z } from 'zod';

export const VE_PRIORITY_NICHES_MAX = 8;
export const VE_PRIORITY_NICHE_MAX_LENGTH = 120;
export const vePriorityNicheKey = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase();

export const VePriorityNichesSchema = z.array(z.string()).max(64).transform((items) => {
  const seen = new Set<string>();
  return items.map((item) => item.trim().replace(/\s+/g, ' ')).filter((item) => {
    const key = vePriorityNicheKey(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}).pipe(z.array(z.string().min(1).max(VE_PRIORITY_NICHE_MAX_LENGTH).regex(/[\p{L}\p{N}]/u, 'Укажите понятное название направления').refine((item) => !/[\p{Cc}\p{Cf}]/u.test(item), 'Удалите невидимые служебные символы')).max(VE_PRIORITY_NICHES_MAX));

export function readVePriorityNiches(brief: Record<string, unknown> | null | undefined): string[] {
  const parsed = VePriorityNichesSchema.safeParse(brief?.priority_niches ?? []);
  return parsed.success ? parsed.data : [];
}

export const VePriorityNicheResultSchema = z.object({
  niche: z.string().trim().min(1).max(VE_PRIORITY_NICHE_MAX_LENGTH),
  status: z.enum(['suggested', 'unavailable']),
  hypothesis_titles: z.array(z.string().trim().min(1)).max(40),
  reason: z.string().trim().min(1).max(2000),
});
export type VePriorityNicheResult = z.infer<typeof VePriorityNicheResultSchema>;
export const VePriorityNicheReportSchema = z.object({
  niches: VePriorityNichesSchema,
  results: z.array(VePriorityNicheResultSchema).max(VE_PRIORITY_NICHES_MAX),
  generated_at: z.string().datetime(),
});
export type VePriorityNicheReport = z.infer<typeof VePriorityNicheReportSchema>;

/** A stored report belongs only to the exact saved preference snapshot. */
export function readVePriorityNicheReport(brief: Record<string, unknown> | null | undefined): VePriorityNicheReport | null {
  const parsed = VePriorityNicheReportSchema.safeParse(brief?.priority_niche_results);
  if (!parsed.success) return null;
  const niches = readVePriorityNiches(brief);
  return JSON.stringify(niches) === JSON.stringify(parsed.data.niches) ? parsed.data : null;
}

export interface VePriorityEvidenceDecision {
  title: string;
  kept_title: string | null;
  reason: string;
}

/** Resolve the generation mapping against the actually saved evidence survivors. */
export function reconcileVePriorityNicheResults(
  results: readonly VePriorityNicheResult[],
  acceptedTitles: readonly string[],
  decisions: readonly VePriorityEvidenceDecision[],
): VePriorityNicheResult[] {
  const accepted = new Map(acceptedTitles.map((title) => [vePriorityNicheKey(title), title]));
  const verdicts = new Map(decisions.map((decision) => [vePriorityNicheKey(decision.title), decision]));
  return results.map((result) => {
    if (result.status === 'unavailable') return { ...result, hypothesis_titles: [] };
    const titles: string[] = [];
    const reasons: string[] = [];
    for (const title of result.hypothesis_titles) {
      const verdict = verdicts.get(vePriorityNicheKey(title));
      const resolved = accepted.get(vePriorityNicheKey(verdict?.kept_title ?? title));
      if (resolved && !titles.includes(resolved)) titles.push(resolved);
      else if (verdict?.reason) reasons.push(`${title}: ${verdict.reason}`);
    }
    return titles.length
      ? { ...result, hypothesis_titles: titles }
      : { ...result, status: 'unavailable' as const, hypothesis_titles: [], reason: reasons.join(' ').slice(0, 2000)
        || 'После проверки источников подходящая гипотеза не сохранилась. Можно добавить свою гипотезу для отдельной проверки.' };
  });
}
