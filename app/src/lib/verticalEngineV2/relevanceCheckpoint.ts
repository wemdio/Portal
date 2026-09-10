import { createHash } from 'node:crypto';
import { z } from 'zod';
import { veRelevanceDecisionSchema } from './relevanceDecision';
import { veRelevanceReviewResultSchema } from './relevanceReview';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const websiteEvidenceSchema = z.object({
  // Old pending extracts predate identity verification and must be refetched.
  reader_version: z.literal(1).optional(),
  status: z.enum(['ok', 'unavailable', 'error']),
  // Keep text only while refinement is pending. Completed checks retain their
  // attempt marker, not thousands of full website extracts in every DB write.
  text: z.string().max(6000),
  url: z.string().max(1000),
  reason: z.string().max(400),
  provider_error: z.object({
    kind: z.enum(['billing', 'configuration', 'transient']),
    message: z.string().max(400),
  }).optional(),
  review_attempt: hashSchema,
  review_attempts: z.number().int().nonnegative(),
  refined: z.boolean(),
});
export const relevanceFailureCodeSchema = z.enum([
  'billing', 'configuration', 'invalid_response', 'invalid_evidence', 'timeout', 'provider', 'limit', 'missing_context',
]);
export type VeRelevanceFailureCode = z.infer<typeof relevanceFailureCodeSchema>;

const checkpointSchema = z.object({
  version: z.literal(2),
  context_hash: hashSchema,
  // Hashes cover company identity AND the original fields shown to the model.
  // Supplemental website facts use that same immutable key in website_evidence.
  // Explanations retain bounded evidence, never email addresses or raw responses.
  verdicts: z.record(hashSchema, veRelevanceDecisionSchema),
  website_evidence: z.record(hashSchema, websiteEvidenceSchema).default({}),
  // A durable reservation prevents a crash/retry from repaying the same repair.
  // Website text remains in website_evidence only until this outcome is saved.
  citation_repairs: z.record(hashSchema, z.object({
    input_hash: hashSchema,
    review_attempt: hashSchema.optional(),
    status: z.enum(['started', 'finished']),
    // Preserve provider failures separately from a single unsupported citation.
    failure_code: relevanceFailureCodeSchema.optional(),
  })).default({}),
  // pending is safe to resume; started/failed can have incurred a charge and
  // must never be repeated for the same evidence/model/context after a crash.
  semantic_reviews: z.record(hashSchema, z.object({
    company_key: hashSchema,
    proposal: veRelevanceDecisionSchema,
    status: z.enum(['pending', 'started', 'finished', 'failed']),
    result: veRelevanceReviewResultSchema.optional(),
    failure_code: relevanceFailureCodeSchema.optional(),
  })).default({}),
  semantic_review_refs: z.record(hashSchema, hashSchema).default({}),
  failures: z.array(z.object({
    batch_hash: hashSchema,
    companies: z.number().int().positive(),
    code: relevanceFailureCodeSchema,
  })).max(100),
});

export type VeRelevanceCheckpoint = z.infer<typeof checkpointSchema>;

export function relevanceHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function readRelevanceCheckpoint(value: unknown, contextHash: string): VeRelevanceCheckpoint {
  for (const candidate of (Array.isArray(value) ? value : [value]).slice(0, 3)) {
    const parsed = checkpointSchema.safeParse(candidate);
    if (parsed.success && parsed.data.context_hash === contextHash) return parsed.data;
  }
  return { version: 2, context_hash: contextHash, verdicts: {}, website_evidence: {}, citation_repairs: {},
    semantic_reviews: {}, semantic_review_refs: {}, failures: [] };
}

/** Do not swallow a failed durable write and proceed to another paid batch. */
export class VeRelevanceCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VeRelevanceCheckpointError';
  }
}
