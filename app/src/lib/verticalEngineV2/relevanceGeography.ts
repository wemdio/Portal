import { sliceWholeChars, stripUnstorableJsonChars } from '@/lib/jsonbSafe';
import { FEDERAL_DISTRICTS } from '@/lib/companiesSearch/regions';
import { HH_REGIONS } from '@/lib/parsers/hhArchive/regions';
import { veCollectionGeographyPlaces, type VeGeographyPlace } from './collectionGeography';
import { veCompanyIdentityKey } from './collectionIdentity';

/** Separate from industry scope: a saved project constraint cannot disappear
 * when a title is broadened or a cheap classifier admits a catalog category. */
export const VE_COLLECTION_GEOGRAPHY_RULE = [
  'MANDATORY COLLECTION GEOGRAPHY is an additional buyer requirement, independent of the legacy or structured activity rules. Never treat it as seller context or weaken it.',
  'Require affirmative company-specific evidence of an address, office, branch or operating location in the required geography. A matching registered address is evidence of location; a different registered address does not rule out a local branch. Shipping, remote services, customers, vacancies or advertising available nationwide do not establish a company location.',
  'Missing or ambiguous geographic evidence means needs_review/insufficient, never a match. Another region alone is not proof the company has no local branch. A company name, domain, registry code or general knowledge cannot establish location. Address facts establish geography only, never business activity.',
].join('\n');

/** Use actual source fields only. A vacancy's area and an INN prefix are not
 * the company's location. Keep this out of legacy keys/prompts entirely. */
export function veRelevanceGeographyFacts(rows: Array<Record<string, unknown>>): string {
  const names = new Set(['address', 'адрес', 'legal_address', 'юридический адрес', 'company_address', 'city', 'город', 'region', 'регион', 'country', 'страна']);
  const facts = rows.flatMap((row) => Object.entries(row).flatMap(([key, value]) => {
    const name = key.trim().toLowerCase();
    if (!names.has(name) || typeof value !== 'string' || !value.trim()) return [];
    // mapHhRow uses the vacancy's area as the public address column. It is
    // useful in the export, but is not proof of the employer's own location.
    if (/(?:^|\n)\s*hh\s*:/i.test(String(row.source_detail ?? '')) && ['address', 'адрес', 'city', 'город', 'region', 'регион'].includes(name)) return [];
    return [stripUnstorableJsonChars(value).trim()];
  }));
  return sliceWholeChars([...new Set(facts)].join('\n'), 0, 600);
}

/** Retain location facts before the collector merges registry and vacancy
 * addresses. One bounded projection per strongly identified recipient company;
 * these observations contain no email or activity and cannot add recipients. */
export function veRelevanceGeographySourceRows(
  recipients: Array<Record<string, unknown>>, observations: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const cell = (row: Record<string, unknown>, names: string[]) => {
    for (const [name, value] of Object.entries(row)) if (names.includes(name.trim().toLowerCase())
      && typeof value === 'string' && value.trim()) return value.trim();
    return '';
  };
  const identity = (row: Record<string, unknown>) => ({ company: cell(row, ['company', 'компания']),
    inn: cell(row, ['inn', 'инн']), website: cell(row, ['website', 'site', 'сайт']) });
  const wanted = new Map(recipients.flatMap((row) => {
    const fields = identity(row), key = veCompanyIdentityKey(fields);
    return key ? [[key, fields] as const] : [];
  }));
  const addresses = new Map<string, string>();
  for (const row of observations) {
    const key = veCompanyIdentityKey(identity(row));
    if (!key || !wanted.has(key)) continue;
    const address = veRelevanceGeographyFacts([row]);
    if (!address) continue;
    const previous = addresses.get(key) ?? '';
    addresses.set(key, veRelevanceGeographyFacts([{ address: previous }, { address }]));
  }
  return [...addresses].map(([key, address]) => ({ ...wanted.get(key)!, address,
    source_detail: 've:geography-source', _ve_geography_source: true }));
}

export interface VeGeographyEvidence { field: 'address' | 'description' | 'website_text'; quote: string }

const normalized = (value: string) => value.toLowerCase().replace(/ё/g, 'е').replace(/[‐‑–—]/g, '-').replace(/\s+/g, ' ').trim();
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (value: string, pattern: string) => new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${pattern})(?=$|[^\\p{L}\\p{N}])`, 'u').test(value);
function placeNamePattern(name: string): string {
  return normalized(name).replace(/^г\.\s*/, '').split(/\s+/).map((word) => {
    if (word === 'область') return 'обл(?:асть|асти|астью|\\.)?';
    if (word === 'край') return 'кра(?:й|я|е|ю|ем)';
    if (word === 'республика') return 'республик(?:а|и|е|у|ой)';
    if (/ая$/.test(word)) return escaped(word.slice(0, -2)) + '(?:ая|ой|ую|ою)';
    if (/ый$/.test(word)) return escaped(word.slice(0, -2)) + '(?:ый|ого|ом|ому|ым)';
    return escaped(word);
  }).join('\\s+');
}

function placeMention(quote: string, place: VeGeographyPlace): boolean {
  const value = normalized(quote);
  if (place.regionCode === '50') return mentions(value, 'московск(?:ая|ой|ую|ою)\\s+обл(?:асть|асти|астью|\\.)?|подмосков(?:ье|ья|ьи)|moscow\\s+(?:region|oblast|province)|(?:region|oblast|province)\\s+of\\s+moscow');
  if (place.name === 'Москва') {
    const city = value.replace(/moscow\s+(?:region|oblast|province)|(?:region|oblast|province)\s+of\s+moscow/g, '');
    return mentions(city, 'москв(?:а|е|ы|у|ой)|moscow|msk|мск');
  }
  if (place.kind === 'country' && place.name === 'Россия') {
    if (mentions(value, 'росси(?:я|и|ю|ей)|российск(?:ая|ой|ую)\\s+федераци(?:я|и|ю|ей)|рф|russia|russian\\s+federation')) return true;
    // Reuse the existing bounded dictionaries; no geocoding or paid lookup.
    return FEDERAL_DISTRICTS.some((district) => district.regions.some((region) => placeMention(value,
      { name: region.name.replace(/^г\.\s*/, ''), kind: 'region', regionCode: region.code })))
      || HH_REGIONS.some((region) => region.group === 'Города России'
        && placeMention(value, { name: region.name, kind: 'city', hhArea: region.id }));
  }
  if (mentions(value, placeNamePattern(place.name))) return true;
  if (place.kind === 'region') {
    const withoutRepublic = place.name.replace(/^Республика\s+/i, '').replace(/\s+Республика$/i, '');
    if (withoutRepublic !== place.name && mentions(value, placeNamePattern(withoutRepublic))) return true;
  }
  // City inflections are complete words: Новосибирске may match, but
  // Новосибирская область or Московский проспект must not establish a city.
  if (place.kind === 'city' || ['77', '78', '92'].includes(place.regionCode ?? '')) {
    const name = normalized(place.name);
    const pattern = /ь$/.test(name) ? escaped(name.slice(0, -1)) + '(?:ь|и|ью)'
      : /а$/.test(name) ? escaped(name.slice(0, -1)) + '(?:а|е|ы|у|ой)'
        : escaped(name) + '(?:а|е|у|ом)?';
    if (mentions(value, pattern)) return true;
  }
  const entry = HH_REGIONS.find((region) => region.id === place.hhArea || normalized(region.name) === normalized(place.name));
  return !!entry?.aliases?.some((alias) => alias.length >= 3 && mentions(value, escaped(normalized(alias))));
}

/** A verdict must carry a real location citation, not just a confident label.
 * Semantic meaning is checked by the existing independent review, not a new
 * model call. Missing citations withhold admission without buying a retry. */
export function hasVeGeographyEvidence(required: string, evidence: VeGeographyEvidence[] | undefined,
  company: { address?: string; evidence: Array<{ field: string; quote: string }> }): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
  const places = veCollectionGeographyPlaces(required);
  return !!evidence?.length && evidence.every((item) => {
    const quote = normalize(item.quote);
    if (quote.length < 2 || !/\p{L}/u.test(quote)) return false;
    const values = item.field === 'address' ? [company.address ?? '']
      : company.evidence.filter((fact) => fact.field === item.field).map((fact) => fact.quote);
    return values.some((value) => normalize(value).includes(quote));
  }) && (!places || evidence.some((item) => places.some((place) => placeMention(item.quote, place))));
}
