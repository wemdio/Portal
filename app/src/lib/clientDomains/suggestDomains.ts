/**
 * Orchestration for the domain picker: brand → candidates → reg.ru
 * availability check → 2N offers with a soft TLD mix.
 *
 * Composition rule (per product decision): fill ~2/3 of the offer with
 * available .ru, then .online, then top up with .tech/.site; when .ru runs
 * short the remaining zones make up the difference. If fewer than 2N domains
 * are available overall, return what we have — the UI shows them and offers
 * "Показать ещё варианты".
 *
 * Only available domains are returned/stored: offering an unchecked or taken
 * domain would risk the client picking something the manager can't buy.
 */

import { checkDomainsAvailable } from '@/lib/regru/client';
import { generateCandidates } from './generateCandidates';
import type { DomainCandidate } from './generateCandidates';
import { RU_SHARE, SUGGESTIONS_MULTIPLIER, TLD_PRIORITY } from './constants';
import type { DomainTld, SuggestedDomain } from './constants';

export type CheckAvailabilityFn = (dnames: string[]) => Promise<Record<string, boolean>>;

export interface SuggestDomainsOptions {
  /** How many domains the client must ultimately pick (N). */
  requiredCount: number;
  /** Affix rotation for "Показать ещё варианты" (0 = default set). */
  offset?: number;
  /** Injectable for tests; defaults to the real reg.ru batch check. */
  checkAvailability?: CheckAvailabilityFn;
  /** Injectable clock for tests. */
  now?: Date;
}

export async function suggestDomains(
  brand: string,
  options: SuggestDomainsOptions,
): Promise<SuggestedDomain[]> {
  const {
    requiredCount,
    offset = 0,
    checkAvailability = checkDomainsAvailable,
    now = new Date(),
  } = options;

  const target = Math.max(1, requiredCount) * SUGGESTIONS_MULTIPLIER;
  const candidates = generateCandidates(brand, offset);
  if (candidates.length === 0) return [];

  // ONE batch request for the whole candidate list — the reg.ru account is
  // limited to 1200 requests/hour, per-domain calls would burn through it.
  const availability = await checkAvailability(candidates.map((c) => c.domain));
  const available = candidates.filter((c) => availability[c.domain] === true);

  const byTld = new Map<DomainTld, DomainCandidate[]>();
  for (const c of available) {
    const list = byTld.get(c.tld) ?? [];
    list.push(c);
    byTld.set(c.tld, list);
  }

  const picked: DomainCandidate[] = [];
  const take = (tld: DomainTld, n: number) => {
    const list = byTld.get(tld);
    if (!list) return;
    while (picked.length < target && n > 0 && list.length > 0) {
      picked.push(list.shift()!);
      n -= 1;
    }
  };

  // Pass 1: .ru up to the share target, then the other zones in priority.
  take('ru', Math.ceil(target * RU_SHARE));
  for (const tld of TLD_PRIORITY) {
    if (tld === 'ru') continue;
    take(tld, target - picked.length);
  }
  // Pass 2: some zone ran dry — top up from whatever is left, .ru first.
  for (const tld of TLD_PRIORITY) {
    take(tld, target - picked.length);
  }

  const checkedAt = now.toISOString();
  return picked.map((c) => ({
    domain: c.domain,
    tld: c.tld,
    available: true,
    checked_at: checkedAt,
  }));
}
