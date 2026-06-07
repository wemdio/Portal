// Real, source-backed filters for the ATS parser. ATS boards expose three
// dependable signals per posting — job title, location, and posted date — so the
// tool is configured by role keywords, country, and recency (no invented
// "niche" taxonomy; ATS have none). Shared by the client form and the runner.

export interface AtsCountry {
  code: string;
  label: string;
  /** RegExp source (case-insensitive) matched against the job location text. */
  match: string;
}

// Country matching is best-effort: Ashby returns a structured country, Greenhouse
// usually includes it in the location string, Lever often omits it.
export const ATS_COUNTRIES: AtsCountry[] = [
  { code: 'us', label: 'США', match: 'united states|\\bu\\.?s\\.?a\\.?|\\busa\\b|\\bus\\b' },
  { code: 'gb', label: 'Великобритания', match: 'united kingdom|\\bu\\.?k\\.?\\b|england|scotland|wales|london|manchester' },
  { code: 'ca', label: 'Канада', match: 'canada|toronto|vancouver|montreal|ontario' },
  { code: 'de', label: 'Германия', match: 'germany|deutschland|berlin|munich|münchen|hamburg' },
  { code: 'fr', label: 'Франция', match: 'france|paris' },
  { code: 'nl', label: 'Нидерланды', match: 'netherlands|amsterdam|holland' },
  { code: 'ie', label: 'Ирландия', match: 'ireland|dublin' },
  { code: 'es', label: 'Испания', match: 'spain|madrid|barcelona' },
  { code: 'au', label: 'Австралия', match: 'australia|sydney|melbourne' },
  { code: 'sg', label: 'Сингапур', match: 'singapore' },
  { code: 'remote', label: 'Remote', match: 'remote|anywhere|distributed' },
];

const COUNTRY_BY_CODE = new Map<string, AtsCountry>(ATS_COUNTRIES.map((c) => [c.code, c]));

export interface AtsRecencyOption {
  days: number;
  label: string;
}

export const ATS_RECENCY_OPTIONS: AtsRecencyOption[] = [
  { days: 7, label: 'За 7 дней' },
  { days: 30, label: 'За 30 дней' },
  { days: 90, label: 'За 90 дней' },
  { days: 0, label: 'Без ограничения' },
];

export const ATS_COUNTRY_CODES = ATS_COUNTRIES.map((c) => c.code);

/** Compile a RegExp matching a job location against selected country codes (null = no geo filter). */
export function buildCountryRegex(codes?: string[] | null): RegExp | null {
  if (!codes || codes.length === 0) return null;
  const sources = codes
    .map((c) => COUNTRY_BY_CODE.get(c)?.match)
    .filter((s): s is string => Boolean(s));
  if (sources.length === 0) return null;
  return new RegExp(sources.join('|'), 'i');
}

/** Compile a RegExp from comma/semicolon/newline-separated role keywords (escaped). */
export function buildRolesRegex(roles?: string | null): RegExp {
  const parts = (roles ?? '')
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (parts.length === 0) return /.*/;
  return new RegExp(parts.join('|'), 'i');
}
