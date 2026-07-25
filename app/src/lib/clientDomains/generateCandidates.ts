/**
 * Generate candidate domains from a brand: brand ± affix × TLD.
 *
 * Pure function — no I/O — so the composition rules are trivially testable.
 * `offset` rotates the affix list, powering the "Показать ещё варианты"
 * button: each click asks for the next rotation instead of repeating the
 * same head of the list.
 */

import { TLD_PRIORITY } from './constants';
import type { DomainTld } from './constants';

export interface DomainCandidate {
  /** Full domain, e.g. "mycompany-hq.ru". */
  domain: string;
  tld: DomainTld;
}

/** SLD builders, in default preference order (bare brand first). */
const AFFIXES: ReadonlyArray<(brand: string) => string> = [
  (b) => b,
  (b) => `${b}-hq`,
  (b) => `${b}-team`,
  (b) => `${b}-group`,
  (b) => `${b}-pro`,
  (b) => `${b}-mail`,
  (b) => `get-${b}`,
  (b) => `${b}-agency`,
  (b) => `${b}official`,
  (b) => `${b}-hub`,
  (b) => `my-${b}`,
  (b) => `${b}-now`,
];

const SLD_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function generateCandidates(brand: string, offset = 0): DomainCandidate[] {
  const normalized = brand.trim().toLowerCase();
  if (!SLD_RE.test(normalized)) return [];

  const shift = ((offset % AFFIXES.length) + AFFIXES.length) % AFFIXES.length;
  const affixes = [...AFFIXES.slice(shift), ...AFFIXES.slice(0, shift)];

  const seen = new Set<string>();
  const candidates: DomainCandidate[] = [];

  for (const build of affixes) {
    const sld = build(normalized);
    // Skip names a registry would reject outright (length/hyphen edges).
    if (sld.length > 63 || !SLD_RE.test(sld)) continue;
    for (const tld of TLD_PRIORITY) {
      const domain = `${sld}.${tld}`;
      if (seen.has(domain)) continue;
      seen.add(domain);
      candidates.push({ domain, tld });
    }
  }

  return candidates;
}
