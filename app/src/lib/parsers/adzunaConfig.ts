// Config + filters for the Adzuna ("whole market") parser, shared by the client
// form and the server runner.

export interface AdzunaCountry {
  code: string; // Adzuna country code (path segment in the API)
  label: string;
}

// Adzuna supports a fixed set of country endpoints; these are the ones we expose.
export const ADZUNA_COUNTRIES: AdzunaCountry[] = [
  { code: 'us', label: 'США' },
  { code: 'gb', label: 'Великобритания' },
  { code: 'ca', label: 'Канада' },
  { code: 'au', label: 'Австралия' },
  { code: 'de', label: 'Германия' },
  { code: 'fr', label: 'Франция' },
  { code: 'nl', label: 'Нидерланды' },
  { code: 'es', label: 'Испания' },
  { code: 'it', label: 'Италия' },
  { code: 'pl', label: 'Польша' },
  { code: 'sg', label: 'Сингапур' },
  { code: 'in', label: 'Индия' },
];

export const ADZUNA_COUNTRY_CODES = ADZUNA_COUNTRIES.map((c) => c.code);

export interface AdzunaRecencyOption {
  days: number;
  label: string;
}

export const ADZUNA_RECENCY_OPTIONS: AdzunaRecencyOption[] = [
  { days: 7, label: 'За 7 дней' },
  { days: 30, label: 'За 30 дней' },
  { days: 90, label: 'За 90 дней' },
  { days: 0, label: 'Без ограничения' },
];

// Staffing / recruiting agencies and job-aggregator noise: on Adzuna they post
// on behalf of other companies, so they're not real outreach targets. Matched
// against the company name (case-insensitive).
export const ADZUNA_EXCLUDE_RE =
  /\b(robert half|aston carter|randstad|adecco|insight global|teksystems|kforce|robert walters|michael page|pagegroup|page group|hays\b|manpower|kelly services|kelly\b|allegis|cybercoders|jobot|lensa|w3global|motion recruitment|beacon hill|apex systems|collabera|judge group|addison group|\bvaco\b|korn ferry|spencer stuart|staffing|recruiting|recruitment|recruiters|talent solutions|talent acquisition|headhunter|placement)\b/i;

export function isExcludedCompany(name: string): boolean {
  return ADZUNA_EXCLUDE_RE.test(String(name ?? ''));
}
