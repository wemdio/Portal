export type ExactAppendOutcome = {
  accepted: number;
  acceptedIndexes: number[] | null;
  identityComplete: boolean;
};

export function partialAppendOutcome(error: unknown): ExactAppendOutcome | null {
  if (!error || typeof error !== 'object' || !('partialResult' in error)) return null;
  const value = (error as { partialResult?: unknown }).partialResult;
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.accepted !== 'number'
    || !Number.isSafeInteger(candidate.accepted)
    || candidate.accepted < 0
    || typeof candidate.identityComplete !== 'boolean'
    || !(candidate.acceptedIndexes === null || Array.isArray(candidate.acceptedIndexes))
  ) return null;
  return candidate as ExactAppendOutcome;
}

/**
 * Resolve accepted items only when the provider response proves every identity.
 * Callers must not infer individual routed rows from an aggregate accepted count.
 */
export function selectAcceptedItems<T>(
  items: readonly T[],
  outcome: ExactAppendOutcome,
): T[] | null {
  if (!outcome.identityComplete || outcome.acceptedIndexes === null) return null;

  const unique = new Set(outcome.acceptedIndexes);
  const valid = unique.size === outcome.acceptedIndexes.length
    && outcome.acceptedIndexes.length === outcome.accepted
    && outcome.acceptedIndexes.every(
      (index) => Number.isSafeInteger(index) && index >= 0 && index < items.length,
    );
  if (!valid) throw new Error('Append accepted identity snapshot is inconsistent');

  return outcome.acceptedIndexes.map((index) => items[index]);
}
