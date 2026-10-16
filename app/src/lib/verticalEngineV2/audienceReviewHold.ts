import { relevanceHash, VeRelevanceCheckpointError } from './relevanceCheckpoint';
import { veRelevanceCompanyKey } from './relevanceReserve';

/** A source-only correction must not buy another review of its old reserve.
 * Store identity hashes, not contacts. New companies retain normal follow-ups;
 * an explicitly requested saved review may still use the complete reserve. */
export function veAudienceReviewHold(rows: Array<Record<string, unknown>>): string[] {
  return [...new Set(rows.map((row) => relevanceHash(veRelevanceCompanyKey(row))))];
}

export function veAutomaticAudienceReviewRows<T extends Record<string, unknown>>(rows: T[], hold: unknown): T[] {
  if (hold === undefined) return rows;
  if (!Array.isArray(hold) || hold.some((key) => typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key))) {
    throw new VeRelevanceCheckpointError('Invalid source refresh review hold');
  }
  const held = new Set(hold as string[]);
  return rows.filter((row) => !held.has(relevanceHash(veRelevanceCompanyKey(row))));
}
