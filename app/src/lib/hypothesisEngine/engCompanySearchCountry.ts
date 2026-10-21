import { heCompanySiteIdentity } from './collectionIdentity';
import { ENG_COUNTRIES, normalizeEngCountry } from './engCountries';

/** Evidence from the company's own structured postal address, never SERP targeting. */
export interface HeEngOfficialCountryEvidence {
  kind: 'jsonld_postal_address';
  country: string;
  sourceCountry: string;
  companyWebsite: string;
  pageUrl: string;
  sourceAddress: string;
  sourceOrganizationWebsite: string;
  sourcePostalAddress: {
    streetAddress: string;
    addressLocality: string;
    postalCode: string;
    addressCountry: string;
    addressRegion?: string;
  };
}

/** The same own-business types must be understood by identity, country and size readers. */
export const HE_ENG_OWN_ORGANIZATION_TYPES = new Set(['Organization', 'Corporation', 'LocalBusiness', 'FinancialService',
  'BankOrCreditUnion', 'InsuranceAgency', 'ProfessionalService', 'LegalService', 'AccountingService',
  'MedicalOrganization', 'Dentist', 'Hospital', 'Physician', 'MedicalClinic']);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) : '';
}

function types(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === 'string')
    .map(item => item.replace(/^https?:\/\/schema\.org\//, ''));
}

function countryValue(raw: unknown): { country: string; raw: string } | null {
  const country = record(raw);
  const values = country ? [country.name, country.alternateName, country.identifier] : [raw];
  for (const value of values) {
    const name = text(value);
    const normalized = normalizeEngCountry(name) ?? ENG_COUNTRIES.find(c => c.iso2 === name.toLowerCase())?.value;
    if (normalized) return { country: normalized, raw: name };
  }
  return null;
}

function publicUrl(value: string, base?: string): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.port &&
      heCompanySiteIdentity(url.href) ? url : null;
  } catch { return null; }
}

/**
 * Pure parser; caller must fetch pageUrl using the safe official-site reader and
 * ensure its FINAL URL is still pageUrl. A search snippet, TLD, footer country
 * word, unrelated organization, or market-served claim is never a location proof.
 */
export function extractHeEngOfficialCountryEvidence(input: {
  companyWebsite: string; pageUrl: string; html: string; allowedCountries: readonly string[];
}): HeEngOfficialCountryEvidence | null {
  const company = publicUrl(input.companyWebsite);
  const page = publicUrl(input.pageUrl);
  const companyHost = company && heCompanySiteIdentity(company.href)?.host;
  if (!company || !page || !companyHost || heCompanySiteIdentity(page.href)?.host !== companyHost ||
      input.html.length > 2_000_000 || !input.allowedCountries.length) return null;
  const allowed = new Set<string>();
  for (const raw of input.allowedCountries) {
    const value = normalizeEngCountry(raw);
    if (!value) return null;
    allowed.add(value);
  }
  const scripts = input.html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi);
  const candidates: HeEngOfficialCountryEvidence[] = [];
  let visited = 0;
  const walk = (value: unknown, depth: number): void => {
    if (depth > 12 || ++visited > 2000) return;
    if (Array.isArray(value)) { for (const child of value.slice(0, 200)) walk(child, depth + 1); return; }
    const org = record(value);
    if (!org) return;
    if (types(org['@type']).some(type => HE_ENG_OWN_ORGANIZATION_TYPES.has(type))) {
      // url identifies an organization. A page-local #organization @id alone
      // does not: third-party organizations commonly get local identifiers too.
      const ownUrl = publicUrl(text(org.url), page.href);
      if (ownUrl && heCompanySiteIdentity(ownUrl.href)?.host === companyHost) {
        const addresses = Array.isArray(org.address) ? org.address.slice(0, 30) : [org.address];
        for (const rawAddress of addresses) {
          const address = record(rawAddress);
          if (!address || !types(address['@type']).includes('PostalAddress')) continue;
          const country = countryValue(address.addressCountry);
          const street = text(address.streetAddress);
          const locality = text(address.addressLocality);
          const postcode = text(address.postalCode);
          // Country alone (including areaServed) cannot prove local presence.
          if (!country || !allowed.has(country.country) || street.length < 5 || locality.length < 2 ||
              postcode.length < 3 || !/[\p{L}\p{N}]/u.test(postcode) ||
              /^(?:n\/?a|none|unknown|null|not available|not applicable)$/i.test(postcode)) continue;
          candidates.push({ kind: 'jsonld_postal_address', country: country.country, sourceCountry: country.raw,
            companyWebsite: company.origin, pageUrl: page.href, sourceOrganizationWebsite: ownUrl.href,
            sourcePostalAddress: { streetAddress: street, addressLocality: locality, postalCode: postcode,
              addressCountry: country.raw, ...(text(address.addressRegion) ? { addressRegion: text(address.addressRegion) } : {}) },
            sourceAddress: [street, locality, text(address.addressRegion), postcode, country.raw].filter(Boolean).join(', ') });
        }
      }
    }
    for (const [key, child] of Object.entries(org)) {
      if (key !== '@context') walk(child, depth + 1);
    }
  };
  for (const script of scripts) {
    if (!/\btype\s*=\s*(["'])application\/ld\+json\1/i.test(script[1]) || script[2].length > 256_000) continue;
    try { walk(JSON.parse(script[2]), 0); } catch { /* Invalid structured data proves no country. */ }
  }
  // Several proven permitted offices are legitimate; this is an allowed
  // presence, never an invented headquarters location.
  return candidates.sort((a, b) => a.country.localeCompare(b.country) || a.sourceAddress.localeCompare(b.sourceAddress))[0] ?? null;
}
