import { heCompanySiteIdentity } from './collectionIdentity';
import { ENG_COUNTRIES, ENG_COUNTRY_US, normalizeEngCountry } from './engCountries';
import { heEngRegistryRecordValid } from './engRegistryIdentity';
import type { HeEngRegistryProvider } from './engPublicRegistryTypes';

// Same actual-address rule as the existing Maps country gate. Kept local so
// this proof reader does not import catalogCursor and its database clients.
const US_STATE_CODES = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';
function verifiedUsMapsAddress(address: string): boolean {
  return new RegExp(`\\b(?:${US_STATE_CODES})\\s+\\d{5}(?:-\\d{4})?\\b`).test(address) || /,\s*(?:united states|usa)\s*$/i.test(address);
}

export type HeEngCountrySource = 'pdl' | 'funded' | 'eng_hiring' | 'google_maps' | 'company_website' | 'public_registry';

export interface HeEngOfficialPostalAddress {
  streetAddress: string;
  addressLocality: string;
  postalCode: string;
  addressCountry: string;
  addressRegion?: string;
}

/** Server-origin metadata, never a CSV column or a client's country selection. */
export interface HeEngSourceCountryProof {
  version: 1;
  source: HeEngCountrySource;
  country: string;
  sourceCountry: string;
  sourceCountryCode?: string;
  sourceName: string;
  sourceWebsite: string;
  sourceAddress?: string;
  sourceId?: string;
  /** Only company_website: the final safe-read page and its own Organization. */
  sourcePage?: string;
  sourceOrganizationWebsite?: string;
  sourcePostalAddress?: HeEngOfficialPostalAddress;
  registryProvider?: HeEngRegistryProvider;
}

export interface HeEngCountryRow {
  company?: unknown;
  website?: unknown;
  _eng_source_country?: unknown;
}

/** null is a persistent conflict, not permission to choose the first country. */
export type HeEngSourceCountryRegistry = Record<string, HeEngSourceCountryProof | null>;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nameKey(value: unknown): string {
  // Keep legal forms and all name words: no parent/subsidiary or alias inference.
  return text(value).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? '';
}

function siteKey(value: unknown): string {
  const raw = text(value);
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return '';
    // Exact host, including tenant/subdomain. Scheme, www and path are cosmetic.
    return heCompanySiteIdentity(raw)?.host ?? '';
  } catch {
    return '';
  }
}

export function heEngSourceCountryKey(row: HeEngCountryRow): string | null {
  const name = nameKey(row.company);
  const site = siteKey(row.website);
  return name && site ? JSON.stringify([name, site]) : null;
}

function sourceCountry(raw: unknown): string | null {
  const value = text(raw);
  return normalizeEngCountry(value) ??
    ENG_COUNTRIES.find((country) => country.iso2.toLowerCase() === value.toLowerCase())?.value ?? null;
}

function verifiedProof(row: HeEngCountryRow, raw: unknown): HeEngSourceCountryProof | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const proof = raw as Partial<HeEngSourceCountryProof>;
  if (proof.version !== 1 || !['pdl', 'funded', 'eng_hiring', 'google_maps', 'company_website', 'public_registry'].includes(String(proof.source))) return null;
  const key = heEngSourceCountryKey(row);
  if (!key || key !== heEngSourceCountryKey({ company: proof.sourceName, website: proof.sourceWebsite })) return null;
  const country = sourceCountry(proof.sourceCountry);
  if (!country || country !== proof.country) return null;
  if (proof.sourceCountryCode !== undefined && sourceCountry(proof.sourceCountryCode) !== country) return null;
  if (proof.source === 'google_maps' && (country !== ENG_COUNTRY_US || !verifiedUsMapsAddress(text(proof.sourceAddress)))) return null;
  if (proof.source === 'public_registry' && (proof.registryProvider === 'companies_house' ||
      text(proof.sourceAddress).length < 5 ||
      !heEngRegistryRecordValid(proof.registryProvider, proof.sourceId, country, proof.sourcePage))) return null;
  if (proof.source === 'company_website') {
    const address = proof.sourcePostalAddress;
    const host = siteKey(row.website);
    if (!host || !text(proof.sourcePage).startsWith('https://') || siteKey(proof.sourcePage) !== host || siteKey(proof.sourceOrganizationWebsite) !== host ||
        !address || typeof address !== 'object' || Array.isArray(address) ||
        text(address.streetAddress).length < 5 || text(address.addressLocality).length < 2 ||
        text(address.postalCode).length < 3 || !/[\p{L}\p{N}]/u.test(text(address.postalCode)) ||
        /^(?:n\/?a|none|unknown|null|not available|not applicable)$/i.test(text(address.postalCode)) ||
        sourceCountry(address.addressCountry) !== country ||
        [address.streetAddress, address.addressLocality, address.addressRegion, address.postalCode, address.addressCountry]
          .map(text).filter(Boolean).join(', ') !== text(proof.sourceAddress)) return null;
  }
  return {
    version: 1, source: proof.source as HeEngCountrySource, country,
    sourceCountry: text(proof.sourceCountry), sourceName: text(proof.sourceName), sourceWebsite: text(proof.sourceWebsite),
    ...(proof.sourceCountryCode !== undefined ? { sourceCountryCode: text(proof.sourceCountryCode) } : {}),
    ...(proof.sourceAddress !== undefined ? { sourceAddress: text(proof.sourceAddress) } : {}),
    ...(proof.sourceId !== undefined ? { sourceId: text(proof.sourceId) } : {}),
    ...(proof.source === 'public_registry' ? { registryProvider: proof.registryProvider!, sourcePage: text(proof.sourcePage) } : {}),
    ...(proof.source === 'company_website' ? {
      sourcePage: text(proof.sourcePage), sourceOrganizationWebsite: text(proof.sourceOrganizationWebsite),
      sourcePostalAddress: {
        streetAddress: text(proof.sourcePostalAddress!.streetAddress), addressLocality: text(proof.sourcePostalAddress!.addressLocality),
        postalCode: text(proof.sourcePostalAddress!.postalCode), addressCountry: text(proof.sourcePostalAddress!.addressCountry),
        ...(text(proof.sourcePostalAddress!.addressRegion) ? { addressRegion: text(proof.sourcePostalAddress!.addressRegion) } : {}),
      },
    } : {}),
  };
}

/** Only call at a trusted provider-row ingress, before any constructor enrichment. */
export function withHeEngSourceCountry<T extends HeEngCountryRow>(
  row: T,
  input: {
    source: HeEngCountrySource;
    sourceName: unknown;
    sourceWebsite: unknown;
    country?: unknown;
    countryCode?: unknown;
    address?: unknown;
    id?: unknown;
    page?: string;
    organizationWebsite?: string;
    postalAddress?: HeEngOfficialPostalAddress;
    registryProvider?: HeEngRegistryProvider;
  },
): T {
  const { _eng_source_country: _discarded, ...clean } = row;
  const raw = input.source === 'google_maps' ? ENG_COUNTRY_US : text(input.country) || text(input.countryCode);
  const country = sourceCountry(raw);
  if (!country) return clean as T;
  const proof: HeEngSourceCountryProof = {
    version: 1, source: input.source, country, sourceCountry: raw,
    sourceName: text(input.sourceName), sourceWebsite: text(input.sourceWebsite),
    ...(text(input.countryCode) ? { sourceCountryCode: text(input.countryCode) } : {}),
    ...(input.source === 'google_maps' ? { sourceAddress: text(input.address) } : {}),
    ...(input.source === 'public_registry' ? {
      sourceAddress: text(input.address), sourcePage: text(input.page), registryProvider: input.registryProvider,
    } : {}),
    ...(input.source === 'company_website' ? {
      sourceAddress: text(input.address), sourcePage: text(input.page),
      sourceOrganizationWebsite: text(input.organizationWebsite), sourcePostalAddress: input.postalAddress,
    } : {}),
    ...(text(input.id) ? { sourceId: text(input.id) } : {}),
  };
  return verifiedProof(clean, proof) ? { ...clean, _eng_source_country: proof } as T : clean as T;
}

export function readHeEngSourceCountry(row: HeEngCountryRow): HeEngSourceCountryProof | null {
  return verifiedProof(row, row._eng_source_country);
}

/** Embedded server proof remains independently checkable after collect-info cleanup. */
export function heEngCompanyCountryProofValid(
  row: HeEngCountryRow, raw: unknown, countries: readonly string[],
): boolean {
  const proof = verifiedProof(row, raw);
  if (!proof || !countries.includes(proof.country)) return false;
  if (row._eng_source_country !== undefined) {
    const marker = readHeEngSourceCountry(row);
    if (!marker || JSON.stringify(marker) !== JSON.stringify(proof)) return false;
  }
  return true;
}

export function heEngSourceCountry(row: HeEngCountryRow, countries: readonly string[]): {
  status: 'confirmed' | 'outside' | 'unknown' | 'conflict';
  country: string | null;
  proof?: HeEngSourceCountryProof;
} {
  const proof = readHeEngSourceCountry(row);
  if (proof) return { status: countries.includes(proof.country) ? 'confirmed' : 'outside', country: proof.country, proof };
  const marker = row._eng_source_country;
  const conflict = marker && typeof marker === 'object' && !Array.isArray(marker) &&
    (marker as { conflict?: unknown }).conflict === true &&
    (marker as { companyKey?: unknown }).companyKey === heEngSourceCountryKey(row);
  return { status: conflict ? 'conflict' : 'unknown', country: null };
}

/** Build before dedup so contradictory source countries cannot disappear in a merge. */
export function collectHeEngSourceCountries(
  rows: readonly HeEngCountryRow[], previous: HeEngSourceCountryRegistry = {},
): HeEngSourceCountryRegistry {
  const registry: HeEngSourceCountryRegistry = { ...previous };
  for (const row of rows) {
    const key = heEngSourceCountryKey(row);
    const proof = readHeEngSourceCountry(row);
    if (!key || !proof) continue;
    if (Object.hasOwn(registry, key)) {
      if (registry[key] === null || registry[key]?.country !== proof.country) registry[key] = null;
    } else registry[key] = proof;
  }
  return registry;
}

/** Constructor/client metadata is ignored; only exact server-registry matches restore it. */
export function restoreHeEngSourceCountries<T extends HeEngCountryRow>(
  rows: readonly T[], registry: HeEngSourceCountryRegistry,
): T[] {
  return rows.map((row) => {
    const { _eng_source_country: _discarded, ...clean } = row;
    const key = heEngSourceCountryKey(row);
    if (!key || !Object.hasOwn(registry, key)) return clean as T;
    const proof = registry[key];
    if (proof === null) return { ...clean, _eng_source_country: { version: 1, conflict: true, companyKey: key } } as T;
    return verifiedProof(clean, proof) ? { ...clean, _eng_source_country: proof } as T : clean as T;
  });
}
