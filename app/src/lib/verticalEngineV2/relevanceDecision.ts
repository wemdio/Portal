import { z } from 'zod';

export const veRelevanceDecisionSchema = z.object({
  version: z.literal(2),
  status: z.enum(['relevant', 'irrelevant', 'needs_review', 'error']),
  reason: z.string().min(1).max(400),
  evidence: z.array(z.object({ field: z.string().max(40), quote: z.string().min(1).max(400) })).max(3),
  context_hash: z.string().regex(/^[a-f0-9]{64}$/),
  review_attempts: z.number().int().nonnegative().optional(),
});

export type VeRelevanceDecision = z.infer<typeof veRelevanceDecisionSchema>;
export const VE_RELEVANCE_FIELD = '_ve_relevance';

/** Additive contract: old bases keep their legacy gates; present metadata must be valid. */
export function isVeRelevanceReady(row: Record<string, unknown>): boolean {
  if (!(VE_RELEVANCE_FIELD in row)) return true;
  const decision = veRelevanceDecisionSchema.safeParse(row[VE_RELEVANCE_FIELD]);
  return decision.success && decision.data.status === 'relevant' && decision.data.evidence.length > 0;
}
