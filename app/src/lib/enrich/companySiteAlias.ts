import { parse } from 'tldts';

/**
 * ENG: the company's own site under another domain.
 *
 * Catalog websites often redirect: abc.co.uk → abc.com after a move to .com,
 * bluebay.com → rbcbluebay.com after the parent added its name, or the apex
 * to a regional subdomain. Before this rule both ENG readers treated every
 * such redirect as a foreign site and lost the company. A different domain is
 * accepted only when it carries the same brand; parked domains, marketplaces,
 * social profiles and an acquirer under its own unrelated name stay foreign.
 *
 * Pure and deterministic: readers call it when they observe a redirect, and
 * validators call it again on stored evidence URLs with the same inputs.
 */

/** Shared hosting is not company ownership: the site boundary is the full host. */
export const COMPANY_SITE_BUILDERS = [
  'wixsite.com', 'squarespace.com', 'webflow.io', 'tilda.ws', 'weebly.com',
  'wordpress.com', 'godaddysites.com', 'myshopify.com', 'business.site',
];

/**
 * Platforms whose name can contain a company word but which never are its own
 * site, on either side: a catalog "website" of discord.gg/xyz is not a brand.
 */
const PLATFORMS = new Set([
  'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com',
  'google.com', 'bing.com', 'crunchbase.com', 'bloomberg.com', 'wikipedia.org', 'glassdoor.com',
  'indeed.com', 'sedo.com', 'dan.com', 'afternic.com', 'hugedomains.com', 'godaddy.com',
  'namecheap.com', 'wix.com', 'medium.com', 'github.com', 'apple.com', 'microsoft.com',
  'amazon.com', 'myworkdayjobs.com', 'discord.gg', 'discord.com', 'whatsapp.com', 'wa.me',
  't.me', 'telegram.me', 'telegram.org', 'linktr.ee', 'bit.ly', 'tinyurl.com', 'substack.com',
  'notion.site', 'tiktok.com', 'pinterest.com', 'reddit.com', 'yelp.com',
]);

/** Words too common in company names to identify a brand on their own. */
const GENERIC_WORDS = new Set([
  'the', 'and', 'for', 'of', 'company', 'companies', 'group', 'groups', 'holding', 'holdings',
  'global', 'international', 'worldwide', 'capital', 'management', 'managers', 'asset', 'assets',
  'investment', 'investments', 'invest', 'investors', 'investor', 'partners', 'partner', 'advisors',
  'advisers', 'advisory', 'wealth', 'fund', 'funds', 'financial', 'finance', 'bank', 'banking',
  'insurance', 'solutions', 'services', 'service', 'consulting', 'trust', 'securities', 'markets',
  'private', 'equity', 'real', 'estate', 'family', 'office', 'associates', 'mgmt', 'first', 'new',
  'north', 'south', 'east', 'west', 'american', 'america', 'europe', 'european', 'inc', 'ltd',
  'llc', 'llp', 'plc', 'gmbh', 'corp', 'corporation', 'limited', 'uk', 'us', 'usa', 'eu',
]);

/** Registrable domain, or the full host on shared hosting and IP addresses. */
export function companySiteBoundary(raw: string): string | null {
  try {
    const host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase().replace(/\.+$/, '');
    if (!host) return null;
    if (COMPANY_SITE_BUILDERS.some((builder) => host === builder || host.endsWith(`.${builder}`))) return host;
    const parsed = parse(host, { allowPrivateDomains: true });
    return parsed.isIp || !parsed.domain ? host : parsed.domain;
  } catch { return null; }
}

/** Same registrable domain: subdomains and www belong to one company site. */
export function sameCompanySiteBoundary(a: string, b: string): boolean {
  const left = companySiteBoundary(a);
  return !!left && left === companySiteBoundary(b);
}

type Brand = { registrable: string; label: string };

function brandOf(raw: string): Brand | null {
  try {
    const host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase().replace(/\.+$/, '');
    if (COMPANY_SITE_BUILDERS.some((builder) => host === builder || host.endsWith(`.${builder}`))) return null;
    const parsed = parse(host, { allowPrivateDomains: true });
    if (parsed.isIp || !parsed.domain || !parsed.domainWithoutSuffix || PLATFORMS.has(parsed.domain)) return null;
    const label = parsed.domainWithoutSuffix.replace(/[^a-z0-9]/g, '');
    return label.length >= 3 ? { registrable: parsed.domain, label } : null;
  } catch { return null; }
}

function nameWords(name: string): string[] {
  return (name.normalize('NFKD').toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((word) => word.length >= 3 && !GENERIC_WORDS.has(word));
}

export type CompanySiteAlias = 'same_name_other_zone' | 'name_inside_domain' | 'company_name_domain' | 'shared_name_word';

/**
 * Why `candidateUrl` is the same company's site as `website`, or null.
 * Same registrable domain is not an alias (callers check it first).
 */
export function companySiteAlias(candidateUrl: string, website: string, companyName: string): CompanySiteAlias | null {
  const from = brandOf(website);
  const to = brandOf(candidateUrl);
  if (!from || !to || from.registrable === to.registrable) return null;
  // abc.co.uk → abc.com
  if (from.label === to.label) return 'same_name_other_zone';
  // bluebay.com → rbcbluebay.com, and back. Short labels are too ambiguous.
  if (from.label.length >= 5 && to.label.includes(from.label)) return 'name_inside_domain';
  if (to.label.length >= 5 && from.label.includes(to.label)) return 'name_inside_domain';
  const words = nameWords(companyName);
  // «Elliott Advisors» → elliottmgmt.com
  const joined = words.join('');
  if (joined.length >= 5 && to.label.includes(joined)) return 'company_name_domain';
  // collercapital.com → collereqt.com («Coller Capital»); kbcam.com → kbc.com («KBC Asset Management»).
  if (words.some((word) => (word.length >= 5 || to.label === word || from.label === word)
    && from.label.startsWith(word) && to.label.startsWith(word))) return 'shared_name_word';
  return null;
}
