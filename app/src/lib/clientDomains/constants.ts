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

import type { TariffLimits } from '@/lib/tariffs';

/**
 * Domains to buy per plan. Custom/unknown plans fall back to max_domains.
 *
 * Ключи намеренно ДВУЯЗЫЧНЫЕ и параметр — string, а не TariffType: на ветке
 * Sergey enum тарифов старый ('standard'|'pro'|'custom'), на test/main после
 * рефактора — новый ('Запуск'|'Поток'|'Масштаб', LEGACY-маппинг там:
 * standard↔Запуск, pro↔Поток). Жёсткая типизация под enum ломала сборку при
 * мёрдже ветки в test (CI Semaphore, 2026-07-25). Строковый параметр с
 * двуязычной мапой компилируется и корректно работает в ОБОИХ мирах;
 * неизвестные значения по-прежнему уходят в лимиты тарифа.
 */
export const DOMAINS_REQUIRED_PER_PLAN: Record<string, number> = {
  standard: 3,
  'Запуск': 3,
  pro: 6,
  'Поток': 6,
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
  tariffType: string,
  limits: TariffLimits,
): number {
  if (tariffType in DOMAINS_REQUIRED_PER_PLAN) {
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
