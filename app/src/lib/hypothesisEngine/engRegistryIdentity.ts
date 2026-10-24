import { ENG_COUNTRIES } from './engCountries';
import type { HeEngRegistryProvider } from './engPublicRegistryTypes';

/** ISO 17442: an LEI is 18 characters plus two check digits, valid when mod 97 equals 1. */
function validLei(id: string): boolean {
  if (!/^[A-Z0-9]{18}\d{2}$/.test(id)) return false;
  let remainder = 0;
  for (const char of id) {
    const digits = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}
function engCountry(country: unknown): boolean {
  return typeof country === 'string' && ENG_COUNTRIES.some(item => item.value === country);
}

/** Fixed public record URLs: neither a search result nor a selected country is proof. */
export function heEngRegistryRecordValid(provider: unknown, id: unknown, country: unknown, page: unknown): provider is HeEngRegistryProvider {
  if (typeof id !== 'string' || typeof page !== 'string' || !id || id.length > 30) return false;
  let url: URL;
  try { url = new URL(page); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
  switch (provider) {
    case 'brreg': return country === 'norway' && /^\d{9}$/.test(id) &&
      url.href === `https://data.brreg.no/enhetsregisteret/api/enheter/${id}`;
    case 'france': return country === 'france' && /^\d{9}$/.test(id) &&
      url.href === `https://annuaire-entreprises.data.gouv.fr/entreprise/${id}`;
    case 'fdic': return country === 'united states' && /^\d{1,10}$/.test(id) &&
      url.href === `https://banks.data.fdic.gov/bankfind-suite/bankfind/details/${id}`;
    case 'nppes': return country === 'united states' && /^\d{10}$/.test(id) &&
      url.href === `https://npiregistry.cms.hhs.gov/provider-view/${id}`;
    case 'fmcsa': return country === 'united states' && /^\d{1,10}$/.test(id) &&
      url.hostname === 'safer.fmcsa.dot.gov' && url.pathname === '/query.asp' &&
      [...url.searchParams].length === 3 && url.searchParams.get('query_type') === 'queryCarrierSnapshot' &&
      url.searchParams.get('query_param') === 'USDOT' && url.searchParams.get('query_string') === id;
    case 'companies_house': return country === 'united kingdom' && /^[A-Z0-9]{8}$/.test(id) &&
      url.href === `https://find-and-update.company-information.service.gov.uk/company/${id}`;
    // Global sources: the country comes from the record itself (GLEIF headquarters,
    // or the OpenStreetMap country boundary containing the premises).
    case 'gleif': return engCountry(country) && validLei(id) && url.href === `https://api.gleif.org/api/v1/lei-records/${id}`;
    case 'osm': return engCountry(country) && /^(?:node|way|relation)\/\d{1,15}$/.test(id) &&
      url.href === `https://www.openstreetmap.org/${id}`;
    default: return false;
  }
}
