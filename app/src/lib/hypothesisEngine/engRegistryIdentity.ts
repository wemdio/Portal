import type { HeEngRegistryProvider } from './engPublicRegistryTypes';

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
    default: return false;
  }
}
