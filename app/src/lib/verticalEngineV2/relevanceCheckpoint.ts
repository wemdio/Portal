import { createHash } from 'node:crypto';
import { z } from 'zod';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const relevanceFailureCodeSchema = z.enum([
  'billing', 'invalid_response', 'timeout', 'provider', 'limit', 'missing_context',
]);
export type VeRelevanceFailureCode = z.infer<typeof relevanceFailureCodeSchema>;

const checkpointSchema = z.object({
  version: z.literal(1),
  context_hash: hashSchema,
  // Hashes cover company identity AND the exact fields shown to the model.
  // No email addresses, company names or raw provider responses are stored here.
  verdicts: z.record(hashSchema, z.enum(['relevant', 'irrelevant'])),
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
  return { version: 1, context_hash: contextHash, verdicts: {}, failures: [] };
}

/** Do not swallow a failed durable write and proceed to another paid batch. */
export class VeRelevanceCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VeRelevanceCheckpointError';
  }
}
