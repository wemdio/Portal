/**
 * Merge the picker's checkbox state across a suggestions refresh.
 *
 * "Показать ещё варианты" replaces the offered batch; picks the user made
 * (but hasn't confirmed yet) must survive whenever the domain is still
 * offered and available. Server-confirmed selections are merged in the same
 * way. Anything no longer offered (or no longer available) is dropped.
 */

import type { SuggestedDomain } from './constants';

export function mergePickedDomains(
  prevPicks: Iterable<string>,
  confirmedSelected: Iterable<string>,
  suggested: Array<Pick<SuggestedDomain, 'domain' | 'available'>>,
): Set<string> {
  const offered = new Set(
    suggested.filter((s) => s.available).map((s) => s.domain),
  );
  return new Set(
    [...prevPicks, ...confirmedSelected].filter((d) => offered.has(d)),
  );
}
