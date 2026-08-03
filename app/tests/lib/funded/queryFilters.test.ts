/** @jest-environment node */

import { applyFundedFilters } from '@/lib/funded/queryFilters';

// Chainable fake recording every filter call (postgrest builders return `this`).
function fakeQuery() {
  const calls: [string, ...unknown[]][] = [];
  const q: Record<string, unknown> = {};
  for (const m of ['in', 'or', 'gte', 'ilike']) {
    q[m] = (...args: unknown[]) => { calls.push([m, ...args]); return q; };
  }
  return { q, calls };
}

describe('applyFundedFilters', () => {
  it('applies list filters only when present', () => {
    const { q, calls } = fakeQuery();
    applyFundedFilters(q as never, { source: ['yc'], industry: ['b2b', 'fintech'] });
    expect(calls).toEqual([
      ['in', 'source', ['yc']],
      ['in', 'industry', ['b2b', 'fintech']],
    ]);
  });

  it('mirrors the search-route funding filters exactly (parity count vs search)', () => {
    const { q, calls } = fakeQuery();
    applyFundedFilters(q as never, { hasFunding: true, minFunding: 100000, fundedSince: '2024-08-02' });
    expect(calls).toEqual([
      ['or', 'last_funding_date.not.is.null,last_funding_usd.not.is.null,total_funding_usd.not.is.null'],
      ['or', 'last_funding_usd.gte.100000,total_funding_usd.gte.100000'],
      ['gte', 'last_funding_date', '2024-08-02'],
    ]);
  });

  it('sanitizes ilike wildcards out of the name filter', () => {
    const { q, calls } = fakeQuery();
    applyFundedFilters(q as never, { name: 'ac%e_' });
    expect(calls).toEqual([['ilike', 'name', '%ace%']]);
  });

  it('applies nothing for empty filters', () => {
    const { q, calls } = fakeQuery();
    applyFundedFilters(q as never, {});
    expect(calls).toEqual([]);
  });
});
