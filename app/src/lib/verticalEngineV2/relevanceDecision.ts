import { z } from 'zod';

// v4 separates explicit buyer requirements from benefits offered by the seller.
// Only unresolved saved companies receive a bounded follow-up under this policy.
export const VE_RELEVANCE_WEBSITE_VERSION = 4;
/** Версия правил отбора (что проверка требует доказать), не путать с версией
 * проверки сайта. Нет поля — версия 1. Смена версии не выбрасывает оплаченные
 * вердикты: гейт один раз перепроверяет отклонённые предложения по их же
 * сохранённым цитатам, остальным неопределённым ставит отметку. */
export const VE_RELEVANCE_RULES_VERSION = 2;

export const veRelevanceDecisionSchema = z.object({
  version: z.literal(2),
  status: z.enum(['relevant', 'irrelevant', 'needs_review', 'error']),
  reason: z.string().min(1).max(400),
  evidence: z.array(z.object({ field: z.string().max(40), quote: z.string().min(1).max(400) })).max(3),
  context_hash: z.string().regex(/^[a-f0-9]{64}$/),
  review_attempts: z.number().int().nonnegative().optional(),
  /** No new paid search while existing stock is still being processed. */
  search_deferred: z.literal(true).optional(),
  /** Bounded website follow-up completed (or exhausted) under this policy. */
  website_review_version: z.union([z.literal(2), z.literal(3), z.literal(VE_RELEVANCE_WEBSITE_VERSION)]).optional(),
  /** The calibrated triage has seen this company under that policy (relevanceTriage.ts).
   * Additive and tolerant: an unknown value must never invalidate a paid checkpoint. */
  triage_version: z.number().int().positive().optional().catch(undefined),
  /** needs_review, уже проверенный по этой версии правил отбора (VE_RELEVANCE_RULES_VERSION). */
  rules_version: z.number().int().positive().optional().catch(undefined),
  /** Present only when the triage itself decided. `final`: a reject that is not re-reviewed. */
  triage: z.object({ outcome: z.enum(['admit', 'reject']), activity: z.number().min(0).max(1),
    final: z.literal(true).optional() }).optional().catch(undefined),
});

export type VeRelevanceDecision = z.infer<typeof veRelevanceDecisionSchema>;
export const VE_RELEVANCE_FIELD = '_ve_relevance';

/** Additive contract: old bases keep their legacy gates; present metadata must be valid. */
export function isVeRelevanceReady(row: Record<string, unknown>): boolean {
  if (!(VE_RELEVANCE_FIELD in row)) return true;
  const decision = veRelevanceDecisionSchema.safeParse(row[VE_RELEVANCE_FIELD]);
  return decision.success && decision.data.status === 'relevant' && decision.data.evidence.length > 0;
}
