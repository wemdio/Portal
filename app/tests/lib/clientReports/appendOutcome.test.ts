/** @jest-environment node */

import { partialAppendOutcome, selectAcceptedItems } from '@/lib/clientReports/appendOutcome';

describe('selectAcceptedItems', () => {
  const items = ['first', 'second', 'third'];

  it('returns only provider-confirmed positions for an exact partial result', () => {
    expect(selectAcceptedItems(items, {
      accepted: 1,
      identityComplete: true,
      acceptedIndexes: [1],
    })).toEqual(['second']);
  });

  it('returns null instead of guessing identities from an aggregate-only result', () => {
    expect(selectAcceptedItems(items, {
      accepted: 1,
      identityComplete: false,
      acceptedIndexes: null,
    })).toBeNull();
  });

  it('rejects inconsistent exact identities before callers mark rows routed', () => {
    expect(() => selectAcceptedItems(items, {
      accepted: 2,
      identityComplete: true,
      acceptedIndexes: [1, 1],
    })).toThrow(/identity/i);
  });

  it('reads a structured partial result without treating arbitrary errors as one', () => {
    const partial = {
      accepted: 1, identityComplete: true, acceptedIndexes: [0],
    };
    expect(partialAppendOutcome({ partialResult: partial })).toEqual(partial);
    expect(partialAppendOutcome(new Error('timeout'))).toBeNull();
  });
});
