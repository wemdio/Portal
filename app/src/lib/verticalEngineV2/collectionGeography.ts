import { FEDERAL_DISTRICTS } from '@/lib/companiesSearch/regions';
import { HH_REGIONS } from '@/lib/parsers/hhArchive/regions';
import type { VeSourcePlan } from './prompts/sourcePlan';

/** Missing = legacy; required:null = explicitly frozen without a restriction.
 * A later brief edit must never change the audience of an existing base. */
export interface VeCollectionGeography { version: 1; required: string | null }

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const clean = (value: string) => value.trim().replace(/\s+/g, ' ');
const key = (value: string) => clean(value).toLocaleLowerCase('ru').replace(/ё/g, 'е')
  .replace(/^(?:г\.\s*|г\s+|город\s+)/u, '').replace(/\s+обл\.?$/u, ' область');
const EMPTY = /^(?:[-—–_.\s]+|нет|не знаю|не указано|неизвестно|n\/?a|без ограничений|нет ограничений|весь мир|worldwide|global)$/iu;

export function readVeCollectionGeography(value: unknown): VeCollectionGeography | null {
  if (value === undefined || value === null) return null;
  const input = record(value);
  if (input.version !== 1 || (input.required !== null && (typeof input.required !== 'string'
    || !clean(input.required) || clean(input.required) !== input.required))) throw new Error('Invalid collection geography checkpoint');
  return { version: 1, required: input.required as string | null };
}

export function veCollectionGeographyFromBrief(brief: unknown): VeCollectionGeography {
  const value = record(record(record(brief).client_brief).icp).geo;
  if (value !== undefined && value !== null && typeof value !== 'string') throw new Error('Invalid client brief geography');
  // A brief can list places on separate lines. Preserve that union before
  // collapsing whitespace, otherwise "Москва\nМО" becomes an unknown place.
  const text = typeof value === 'string' ? value : '';
  const required = clean(text);
  return { version: 1, required: !required || EMPTY.test(required) ? null
    : text.split(/[\r\n]+/u).map(clean).filter(Boolean).join(', ') };
}

export interface VeGeographyPlace {
  name: string; kind: 'country' | 'region' | 'city'; regionCode?: string; hhArea?: string;
}
const places = new Map<string, VeGeographyPlace>();
for (const region of FEDERAL_DISTRICTS.flatMap((district) => district.regions)) {
  const name = region.name.replace(/^г\.\s*/u, '');
  const hh = HH_REGIONS.find((item) => key(item.name) === key(name));
  places.set(key(name), { name, kind: 'region', regionCode: region.code, ...(hh ? { hhArea: hh.id } : {}) });
}
for (const hh of HH_REGIONS) {
  const name = hh.id === '113' ? 'Россия' : hh.name;
  const existing = places.get(key(name));
  const place: VeGeographyPlace = existing ? { ...existing, hhArea: hh.id }
    : { name, kind: ['Россия', 'СНГ'].includes(hh.group) ? 'country' : hh.group === 'Регионы России' ? 'region' : 'city', hhArea: hh.id };
  for (const alias of [name, hh.name, ...(hh.aliases ?? [])]) places.set(key(alias), place);
}
for (const [alias, name] of [['мск', 'Москва'], ['мо', 'Московская область'], ['подмосковье', 'Московская область'],
  ['ло', 'Ленинградская область'], ['российская федерация', 'Россия'], ['вся рф', 'Россия'], ['по всей россии', 'Россия']] as const)
  places.set(alias, places.get(key(name))!);

/** Only a completely recognized positive list is converted to source IDs.
 * Never extract Moscow from "РФ кроме Москвы" or expand Kazan to Tatarstan. */
export function veCollectionGeographyPlaces(required: string): VeGeographyPlace[] | null {
  const value = key(required).replace(/^(?:только|only)\s+/u, '');
  const exact = places.get(value);
  if (exact) return [{ ...exact }];
  const parts = value.split(/\s*(?:[,;+/\n]|\s+(?:и|или|and|or)\s+)\s*/iu).map(key).filter(Boolean);
  if (!parts.length || parts.some((part) => !places.has(part))) return null;
  return [...new Map(parts.map((part) => { const place = places.get(part)!; return [place.name, { ...place }] as const; })).values()];
}

/** Enforce known source filters after every source-policy rewrite. Unknown
 * prose remains an explicit condition for the existing planner and relevance
 * gate; it is never guessed from a few matching words. No sources, queries or
 * candidate limits are added. Source addresses remain candidate evidence only. */
export function applyVeCollectionGeographyToPlan(plan: VeSourcePlan, geography?: VeCollectionGeography | null): VeSourcePlan {
  const required = readVeCollectionGeography(geography)?.required;
  if (!required) return plan;
  const scope = veCollectionGeographyPlaces(required);
  const regionCodes = scope?.every((place) => !!place.regionCode) ? scope.map((place) => place.regionCode!) : null;
  const hhAreas = scope?.every((place) => !!place.hhArea) ? scope.map((place) => place.hhArea!) : null;
  return { ...plan, tasks: plan.tasks.map((task) => {
    if (task.source === 'companies_directory' && task.directory_filters && regionCodes) return { ...task,
      directory_filters: { ...task.directory_filters, regionCodes: [...new Set(regionCodes)] } };
    if (task.source === 'hh_live' && task.hh_query && hhAreas) return { ...task,
      hh_query: { ...task.hh_query, area: hhAreas.length === 1 ? hhAreas[0] : [...new Set(hhAreas)] } };
    if ((task.source === 'yandex_maps' || task.source === 'google_maps') && task.maps_query) return { ...task,
      maps_query: { ...task.maps_query, geo: scope?.map((place) => place.name).join(', ') ?? required,
        collection_geography: { version: 1 as const, required } } };
    return task;
  }) };
}

/** Resolve the entire union against actual catalog labels. A combined catalog
 * region ("Москва и Московская область") is safe only when both were requested.
 * Fuzzy/model mapping cannot drop one half or expand a city to its region. */
export function veCollectionGeographyCatalogScope(required: string, rows: Array<Record<string, unknown>>): {
  countries?: string[]; cities?: string[];
} | null {
  const countries = [...new Set(rows.map((row) => String(row.country ?? '').trim()).filter(Boolean))];
  const locations = [...new Set(rows.flatMap((row) => [row.region, row.city])
    .filter((value): value is string => typeof value === 'string' && !!value.trim()).map((value) => value.trim()))];
  const known = veCollectionGeographyPlaces(required);
  // Dictionary labels can themselves contain commas or "and" (for example
  // Trinidad and Tobago). A literal complete match is not a prose inference.
  if (!known) {
    const exactCountry = countries.find((name) => key(name) === key(required));
    if (exactCountry) return { countries: [exactCountry] };
    const exactPlace = locations.find((name) => key(name) === key(required));
    if (exactPlace) return { cities: [exactPlace] };
  }
  const tokens = known?.map((place) => place.name) ?? clean(required).replace(/^(?:только|only)\s+/iu, '')
    .split(/\s*(?:[,;+/\n]|\s+(?:и|или|and|or)\s+)\s*/iu).filter(Boolean);
  if (!tokens.length) return null;
  const countryMatches = tokens.map((token) => countries.find((name) => key(name) === key(token)));
  if (countryMatches.every((value): value is string => !!value)) return { countries: [...new Set(countryMatches)] };
  // Mixed country/city OR cannot be represented by the catalog's AND filters.
  if (countryMatches.some(Boolean)) return null;
  const wanted = new Set(tokens.map(key));
  const covered = new Set<string>();
  const cities = locations.filter((value) => {
    const parts = veCollectionGeographyPlaces(value)?.map((place) => key(place.name)) ?? [key(value)];
    if (!parts.length || parts.some((name) => !wanted.has(name))) return false;
    for (const name of parts) covered.add(name);
    return true;
  });
  return cities.length && [...wanted].every((name) => covered.has(name)) ? { cities } : null;
}
