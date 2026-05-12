/**
 * Merge rule: autofill never overwrites user-entered content.
 *
 * - Text fields: replace only if the current value is empty/whitespace.
 * - social_proof: per-entry. Never flip an existing has=true back to false;
 *   never overwrite an existing comment.
 * - Disallowed fields are not touched because the mapper drops them upstream,
 *   but mergePatchEmptyOnly itself only writes keys present in the patch.
 */

import { SOCIAL_PROOF_KEYS } from '../constants';
import type {
  ClientBriefFields,
  ClientBriefSocialProof,
  ClientBriefSocialProofKey,
} from '../types';

function isEmptyText(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

function deepCloneSocialProof(
  sp: ClientBriefFields['social_proof'],
): ClientBriefFields['social_proof'] {
  const out = {} as ClientBriefFields['social_proof'];
  for (const key of SOCIAL_PROOF_KEYS as readonly ClientBriefSocialProofKey[]) {
    const entry = sp[key];
    out[key] = entry
      ? { has: !!entry.has, comment: typeof entry.comment === 'string' ? entry.comment : '' }
      : { has: false, comment: '' };
  }
  return out;
}

export function mergePatchEmptyOnly(
  current: ClientBriefFields,
  patch: Partial<ClientBriefFields>,
): ClientBriefFields {
  const next: ClientBriefFields = {
    ...current,
    social_proof: deepCloneSocialProof(current.social_proof),
  };

  const currentRecord = current as unknown as Record<string, unknown>;
  const nextRecord = next as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'social_proof') continue;
    if (typeof value !== 'string') continue;
    if (!isEmptyText(value) && isEmptyText(currentRecord[key])) {
      nextRecord[key] = value;
    }
  }

  if (patch.social_proof) {
    for (const key of SOCIAL_PROOF_KEYS as readonly ClientBriefSocialProofKey[]) {
      const candidate = (patch.social_proof as Partial<Record<ClientBriefSocialProofKey, ClientBriefSocialProof>>)[key];
      if (!candidate) continue;
      const existing = next.social_proof[key];
      if (existing.has) {
        // User already claimed this proof — never demote, never overwrite.
        continue;
      }
      if (candidate.has) {
        next.social_proof[key] = {
          has: true,
          comment: typeof candidate.comment === 'string' ? candidate.comment : '',
        };
      }
    }
  }

  return next;
}
