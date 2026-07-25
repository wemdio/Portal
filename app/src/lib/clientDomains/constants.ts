/**
 * Configuration for the client domain-picking onboarding step.
 *
 * The client is offered SUGGESTIONS_MULTIPLIER × N available domains and
 * picks N of them (N depends on the tariff). The manager then buys and
 * configures the chosen domains manually — purchase/DNS/mailboxes are NOT
 * automated here.
 *
 * TLD mix is a soft recommendation (~2/3 .ru, then .online, topped up with
 * .tech/.site) — the client may pick any N of the offered domains.
 */

import type { TariffLimits, TariffType } from '@/lib/tariffs';

/** Domains to buy per plan. Custom/unknown plans fall back to max_domains. */
export const DOMAINS_REQUIRED_PER_PLAN: Record<'standard' | 'pro', number> = {
  standard: 3,
  pro: 6,
};

/** How many variants we offer per required domain (offer 2N, client picks N). */
export const SUGGESTIONS_MULTIPLIER = 2;

/** TLDs in descending preference for generation, checking and UI sorting. */
export const TLD_PRIORITY = ['ru', 'online', 'tech', 'site'] as const;

export type DomainTld = (typeof TLD_PRIORITY)[number];

/** Share of the offer we try to fill with .ru before other zones. */
export const RU_SHARE = 2 / 3;

/** Fallback when neither the plan map nor tariff limits yield a number. */
const FALLBACK_REQUIRED = 3;

export function getRequiredDomainCount(
  tariffType: TariffType,
  limits: TariffLimits,
): number {
  if (tariffType === 'standard' || tariffType === 'pro') {
    return DOMAINS_REQUIRED_PER_PLAN[tariffType];
  }
  const fromLimits = Number(limits.max_domains);
  return Number.isFinite(fromLimits) && fromLimits > 0
    ? Math.floor(fromLimits)
    : FALLBACK_REQUIRED;
}

/** One offered domain as stored in client_domain_selections.suggested. */
export interface SuggestedDomain {
  domain: string;
  tld: DomainTld;
  available: boolean;
  checked_at: string;
}
