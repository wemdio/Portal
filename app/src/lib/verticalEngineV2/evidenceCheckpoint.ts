import { z } from 'zod';
import { canonicalJson, sha256Hex } from '@/lib/companiesDirectory/guardedImportCore';
import { VeEvidenceItemSchema, VeRuSeasonalitySchema } from './schemas';

const count = z.number().int().nonnegative();
const AcceptedHypothesisSchema = z.object({
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  title: z.string(), description: z.string(), fit_rationale: z.string(),
  evidence: z.array(VeEvidenceItemSchema), seasonality: VeRuSeasonalitySchema.nullable(),
  potential_pct: z.number().int().min(0).max(100),
});

// Bump the checkpoint version when verdict/prompt semantics change; a resumed
// stage must not silently mix decisions made by different research algorithms.
const EvidenceCheckpointSchema = z.object({
  version: z.literal(1), input_hash: z.string().regex(/^[a-f0-9]{64}$/), next_index: count,
  accepted: z.array(AcceptedHypothesisSchema), merged: count, dropped: count, evidence_dropped: count,
  usage: z.object({ tokensUsed: count, costUsd: z.number().finite().nonnegative() }),
  today_moscow: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  portfolio_profile: z.array(z.object({
    segment: z.string(), campaigns: count, clients: count, sent: count, replies: count,
    reply_pct: z.number().finite().nullable(),
  })).nullable(),
  markup_history: z.object({ accepted: z.array(z.string()), rejected: z.array(z.string()) }).nullable(),
});

export type EvidenceCheckpoint = z.infer<typeof EvidenceCheckpointSchema>;
export type AcceptedEvidenceHypothesis = z.infer<typeof AcceptedHypothesisSchema>;

export function evidenceInputHash(input: unknown): string {
  return sha256Hex(canonicalJson(input));
}

/** Never mix evidence/cost from different inputs or silently discard paid work. */
export function readEvidenceCheckpoint(value: unknown, inputHash: string, total: number): EvidenceCheckpoint | null {
  if (value === undefined) return null;
  const parsed = EvidenceCheckpointSchema.safeParse(value);
  if (!parsed.success) throw new Error('Evidence checkpoint is invalid; restart research in a new job');
  const checkpoint = parsed.data;
  if (checkpoint.input_hash !== inputHash) throw new Error('Evidence checkpoint input changed; restart research in a new job');
  if (checkpoint.next_index > total || checkpoint.accepted.length + checkpoint.merged + checkpoint.dropped !== checkpoint.next_index) {
    throw new Error('Evidence checkpoint candidate counts are inconsistent');
  }
  return checkpoint;
}
