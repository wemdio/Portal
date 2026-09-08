import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

const CHECKPOINT_FAILURE = 'AI classification failed after retries: AI checkpoint unavailable';

export type QualificationAiReservation =
  | { state: 'cached'; rawResponse: string }
  | { state: 'reserved'; leaseToken: string }
  | { state: 'busy' }
  | { state: 'exhausted' };

/** Successful RAW output is reparsed and guarded on every replay. */
export interface QualificationAiCheckpointStore {
  reserve(input: { fingerprint: string; budgetFingerprint: string }): Promise<QualificationAiReservation>;
  complete(input: { fingerprint: string; leaseToken: string; rawResponse: string }): Promise<void>;
  release(input: { fingerprint: string; leaseToken: string; errorCode: string }): Promise<void>;
}

export function qualificationAiFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Bound to the proven owner and exact inbound reply, never a lead address alone. */
export function createQualificationAiCheckpointStore(
  db: Pick<SupabaseClient, 'rpc'>,
  scope: { accountId: string; replyId: string; projectId?: string | null },
): QualificationAiCheckpointStore {
  if (!scope.accountId?.trim() || !scope.replyId?.trim()) {
    throw new Error(`${CHECKPOINT_FAILURE}: missing account or reply scope`);
  }
  const scopeKey = qualificationAiFingerprint([
    'instantly-qualification-v1', scope.accountId, scope.replyId, scope.projectId ?? null,
  ]);
  const scopedKey = (fingerprint: string): string => qualificationAiFingerprint([scopeKey, fingerprint]);
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    try {
      const { data, error } = await db.rpc(name, args);
      if (error || !data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('invalid checkpoint RPC response');
      }
      return data as Record<string, unknown>;
    } catch {
      // Do not leak raw prompts, credentials, database details or model output.
      throw new Error(`${CHECKPOINT_FAILURE}: durable accounting could not be confirmed`);
    }
  };
  return {
    async reserve({ fingerprint, budgetFingerprint }) {
      const result = await call('reserve_instantly_qualification_ai', {
        p_checkpoint_key: scopedKey(fingerprint),
        p_budget_key: scopedKey(budgetFingerprint),
      });
      if (result.state === 'cached' && typeof result.raw_response === 'string') {
        return { state: 'cached', rawResponse: result.raw_response };
      }
      if (result.state === 'reserved' && typeof result.lease_token === 'string') {
        return { state: 'reserved', leaseToken: result.lease_token };
      }
      if (result.state === 'busy' || result.state === 'exhausted') return { state: result.state };
      throw new Error(`${CHECKPOINT_FAILURE}: unrecognized reservation`);
    },
    async complete({ fingerprint, leaseToken, rawResponse }) {
      const result = await call('finish_instantly_qualification_ai', {
        p_checkpoint_key: scopedKey(fingerprint), p_lease_token: leaseToken,
        p_raw_response: rawResponse, p_error_code: null,
      });
      if (result.state !== 'saved') throw new Error(`${CHECKPOINT_FAILURE}: completion lease lost`);
    },
    async release({ fingerprint, leaseToken, errorCode }) {
      const result = await call('finish_instantly_qualification_ai', {
        p_checkpoint_key: scopedKey(fingerprint), p_lease_token: leaseToken,
        p_raw_response: null, p_error_code: errorCode,
      });
      if (result.state !== 'released') throw new Error(`${CHECKPOINT_FAILURE}: release lease lost`);
    },
  };
}
