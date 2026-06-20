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

const TOKEN_START = String.raw`(?:^|[\s,;()/\-])`;
const TOKEN_END = String.raw`(?=$|[\s,;()/\-])`;
const locationToken = (value: string) => `${TOKEN_START}(?:${value})${TOKEN_END}`;

const US_STATE_CODES = String.raw`(?:al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)`;
const US_STATE_NAMES = String.raw`(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia)`;
// Curated, US-dominant major cities so bare "San Francisco" / "Austin" locations
// (common on Greenhouse/Lever, which often omit state & country) still resolve to
// the US. Deliberately EXCLUDES internationally-ambiguous names (london, birmingham,
// manchester, cambridge, richmond) — those must qualify with a state/country to
// count, so we keep precision over recall.
const US_MAJOR_CITIES = String.raw`(?:san francisco|los angeles|new york city|nyc|brooklyn|manhattan|silicon valley|bay area|seattle|austin|denver|atlanta|chicago|philadelphia|phoenix|dallas|houston|san diego|san jose|las vegas|miami|minneapolis|pittsburgh|salt lake city|nashville|raleigh|durham|charlotte|tampa|orlando|sacramento|san antonio|indianapolis|kansas city|st\. louis|saint louis|cincinnati|cleveland|detroit|milwaukee|boston|portland|columbus|washington)`;

const CA_PROVINCES = String.raw`(?:alberta|british columbia|manitoba|new brunswick|newfoundland and labrador|nova scotia|ontario|prince edward island|quebec|saskatchewan|yukon|northwest territories|nunavut|ab|bc|mb|nb|nl|ns|nt|nu|on|pe|qc|sk|yt)`;
const AU_STATES = String.raw`(?:new south wales|queensland|south australia|tasmania|victoria|western australia|australian capital territory|northern territory|nsw|qld|sa|tas|vic|wa|act|nt)`;

// Country matching is best-effort: Ashby returns a structured country, Greenhouse
// usually includes it in the location string, Lever often omits it.
export const ATS_COUNTRIES: AtsCountry[] = [
  // US: explicit country names PLUS the very common "City, ST" format (state
  // codes), otherwise "New York, NY" / "San Francisco, CA" get dropped.
  {
    code: 'us',
    label: 'США',
    match:
      'united states|\\busa?\\b|u\\.s\\.a?\\.?|,\\s*(?:al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)\\b',
  },
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

const COUNTRY_MATCH_OVERRIDES: Record<string, string> = {
  us: [
    'united states(?: of america)?',
    locationToken(String.raw`u\.?s\.?a?\.?`),
    `,\\s*${US_STATE_CODES}\\b`,
    `\\b${US_STATE_NAMES}\\b`,
    `\\b${US_MAJOR_CITIES}\\b`,
  ].join('|'),
  gb: [
    'united kingdom',
    locationToken(String.raw`u\.?k\.?|gb|gbr`),
    'england|scotland|wales|northern ireland|london|manchester|birmingham|edinburgh',
  ].join('|'),
  ca: [
    'canada',
    String.raw`\bCA[-/](?:${CA_PROVINCES})\b`,
    `\\b${CA_PROVINCES}\\b`,
    'toronto|vancouver|montreal|montrÃ©al|ottawa|calgary',
  ].join('|'),
  de: ['germany|deutschland', locationToken('de|deu'), 'berlin|munich|mÃ¼nchen|hamburg|frankfurt|cologne|kÃ¶ln'].join('|'),
  fr: ['france', locationToken('fr|fra'), 'paris|lyon|marseille|toulouse'].join('|'),
  nl: ['netherlands|holland|nederland', locationToken('nl|nld'), 'amsterdam|rotterdam|utrecht|eindhoven'].join('|'),
  ie: ['ireland', locationToken('ie|irl'), 'dublin|cork|galway|limerick'].join('|'),
  es: ['spain|espaÃ±a', locationToken('es|esp'), 'madrid|barcelona|valencia|seville|sevilla'].join('|'),
  au: ['australia', locationToken('au|aus'), `\\b${AU_STATES}\\b`, 'sydney|melbourne|brisbane|perth|adelaide|canberra'].join('|'),
  sg: ['singapore', locationToken('sg|sgp')].join('|'),
};

for (const country of ATS_COUNTRIES) {
  country.match = COUNTRY_MATCH_OVERRIDES[country.code] ?? country.match;
}

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

const B2B_ROLE_EXPANSION = [
  'b2b',
  'business development',
  'account executive',
  'sales development',
  'business development representative',
  'sales manager',
  'sales lead',
  'sales executive',
  'enterprise sales',
  'partnerships? manager',
  'partnerships? director',
  '(?:manager|director|vp|head|lead),?\\s+(?:of\\s+)?partnerships?',
  'channel sales',
  'commercial relationship manager',
  'commercial account',
  'sdr',
  'bdr',
];

const B2B_ROLE_EXPANSION_EXTRA = [
  '\\bae\\b',
  'account director',
  'account manager',
  'revenue development',
  'revenue development representative',
  'sales representative',
  'sales consultant',
  'commercial account',
  'commercial account director',
  'commercial account executive',
  'client partner',
  'partner sales',
  'partner manager',
  'rdr',
  'go[-\\s]?to[-\\s]?market',
  'gtm',
];

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
    .flatMap((s) => {
      const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return /\bb2b\b/i.test(s) ? [escaped, ...B2B_ROLE_EXPANSION, ...B2B_ROLE_EXPANSION_EXTRA] : [escaped];
    });
  if (parts.length === 0) return /.*/;
  return new RegExp(parts.join('|'), 'i');
}
