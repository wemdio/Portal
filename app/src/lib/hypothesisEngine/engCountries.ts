/**
 * СТРАНЫ СБОРА ENG-ПРОЕКТА — справочник и разбор (решение владельца
 * 16.10.2026; план docs/handoff/2026-10-16-eng-countries/implementation-plan.md,
 * §1A и F1). Чистый модуль без импортов: его тянет и браузер (выбор стран на
 * шаге 1), и воркер (замок сборки, sourcePlanCountryGate.ts).
 *
 * Значение — написание каталога компаний (`pdl_companies.country`, нижний
 * регистр); только такие значения каталог матчит точно. Список снят с прода
 * 16.10.2026 (docs/handoff/2026-10-16-eng-countries/catalog-countries.tsv,
 * 249 значений) и генерируется заново при каждой перезаливке каталога — тогда
 * же, когда сбрасываются закладки (catalogCursor.ts). Подпись — английское
 * имя Intl.DisplayNames, iso2 — код ISO (так же, нижним регистром, хранит
 * страну фид вакансий, eng_hiring_cache.country_code).
 *
 * Хранение — `he_projects.brief.collect_countries: string[]`, отсортированный
 * список без повторов. Ключа нет или он пуст — поведение прежнее байт в байт.
 */

export interface EngCountry {
  /** Написание каталога: 'ireland', 'united kingdom'. */
  value: string;
  /** Английское имя для экрана: 'Ireland', 'United Kingdom'. */
  label: string;
  /** ISO 3166-1 alpha-2, нижний регистр: 'ie', 'gb'. */
  iso2: string;
}

/** [value, label, iso2] — все 249 значений каталога, по подписи. */
const ALL: ReadonlyArray<readonly [string, string, string]> = [
  ["afghanistan", "Afghanistan", 'af'],
  ["åland islands", "Åland Islands", 'ax'],
  ["albania", "Albania", 'al'],
  ["algeria", "Algeria", 'dz'],
  ["american samoa", "American Samoa", 'as'],
  ["andorra", "Andorra", 'ad'],
  ["angola", "Angola", 'ao'],
  ["anguilla", "Anguilla", 'ai'],
  ["antigua and barbuda", "Antigua & Barbuda", 'ag'],
  ["argentina", "Argentina", 'ar'],
  ["armenia", "Armenia", 'am'],
  ["aruba", "Aruba", 'aw'],
  ["australia", "Australia", 'au'],
  ["austria", "Austria", 'at'],
  ["azerbaijan", "Azerbaijan", 'az'],
  ["bahamas", "Bahamas", 'bs'],
  ["bahrain", "Bahrain", 'bh'],
  ["bangladesh", "Bangladesh", 'bd'],
  ["barbados", "Barbados", 'bb'],
  ["belarus", "Belarus", 'by'],
  ["belgium", "Belgium", 'be'],
  ["belize", "Belize", 'bz'],
  ["benin", "Benin", 'bj'],
  ["bermuda", "Bermuda", 'bm'],
  ["bhutan", "Bhutan", 'bt'],
  ["bolivia", "Bolivia", 'bo'],
  ["bosnia and herzegovina", "Bosnia & Herzegovina", 'ba'],
  ["botswana", "Botswana", 'bw'],
  ["bouvet island", "Bouvet Island", 'bv'],
  ["brazil", "Brazil", 'br'],
  ["british indian ocean territory", "British Indian Ocean Territory", 'io'],
  ["british virgin islands", "British Virgin Islands", 'vg'],
  ["brunei", "Brunei", 'bn'],
  ["bulgaria", "Bulgaria", 'bg'],
  ["burkina faso", "Burkina Faso", 'bf'],
  ["burundi", "Burundi", 'bi'],
  ["cambodia", "Cambodia", 'kh'],
  ["cameroon", "Cameroon", 'cm'],
  ["canada", "Canada", 'ca'],
  ["cape verde", "Cape Verde", 'cv'],
  ["caribbean netherlands", "Caribbean Netherlands", 'bq'],
  ["cayman islands", "Cayman Islands", 'ky'],
  ["central african republic", "Central African Republic", 'cf'],
  ["chad", "Chad", 'td'],
  ["chile", "Chile", 'cl'],
  ["china", "China", 'cn'],
  ["christmas island", "Christmas Island", 'cx'],
  ["cocos (keeling) islands", "Cocos (Keeling) Islands", 'cc'],
  ["colombia", "Colombia", 'co'],
  ["comoros", "Comoros", 'km'],
  ["republic of the congo", "Congo - Brazzaville", 'cg'],
  ["democratic republic of the congo", "Congo - Kinshasa", 'cd'],
  ["cook islands", "Cook Islands", 'ck'],
  ["costa rica", "Costa Rica", 'cr'],
  ["côte d'ivoire", "Côte d’Ivoire", 'ci'],
  ["croatia", "Croatia", 'hr'],
  ["cuba", "Cuba", 'cu'],
  ["curaçao", "Curaçao", 'cw'],
  ["cyprus", "Cyprus", 'cy'],
  ["czechia", "Czechia", 'cz'],
  ["denmark", "Denmark", 'dk'],
  ["djibouti", "Djibouti", 'dj'],
  ["dominica", "Dominica", 'dm'],
  ["dominican republic", "Dominican Republic", 'do'],
  ["ecuador", "Ecuador", 'ec'],
  ["egypt", "Egypt", 'eg'],
  ["el salvador", "El Salvador", 'sv'],
  ["equatorial guinea", "Equatorial Guinea", 'gq'],
  ["eritrea", "Eritrea", 'er'],
  ["estonia", "Estonia", 'ee'],
  ["eswatini", "Eswatini", 'sz'],
  ["ethiopia", "Ethiopia", 'et'],
  ["falkland islands", "Falkland Islands", 'fk'],
  ["faroe islands", "Faroe Islands", 'fo'],
  ["fiji", "Fiji", 'fj'],
  ["finland", "Finland", 'fi'],
  ["france", "France", 'fr'],
  ["french guiana", "French Guiana", 'gf'],
  ["french polynesia", "French Polynesia", 'pf'],
  ["french southern territories", "French Southern Territories", 'tf'],
  ["gabon", "Gabon", 'ga'],
  ["the gambia", "Gambia", 'gm'],
  ["georgia", "Georgia", 'ge'],
  ["germany", "Germany", 'de'],
  ["ghana", "Ghana", 'gh'],
  ["gibraltar", "Gibraltar", 'gi'],
  ["greece", "Greece", 'gr'],
  ["greenland", "Greenland", 'gl'],
  ["grenada", "Grenada", 'gd'],
  ["guadeloupe", "Guadeloupe", 'gp'],
  ["guam", "Guam", 'gu'],
  ["guatemala", "Guatemala", 'gt'],
  ["guernsey", "Guernsey", 'gg'],
  ["guinea", "Guinea", 'gn'],
  ["guinea-bissau", "Guinea-Bissau", 'gw'],
  ["guyana", "Guyana", 'gy'],
  ["haiti", "Haiti", 'ht'],
  ["heard island and mcdonald islands", "Heard & McDonald Islands", 'hm'],
  ["honduras", "Honduras", 'hn'],
  ["hong kong", "Hong Kong SAR China", 'hk'],
  ["hungary", "Hungary", 'hu'],
  ["iceland", "Iceland", 'is'],
  ["india", "India", 'in'],
  ["indonesia", "Indonesia", 'id'],
  ["iran", "Iran", 'ir'],
  ["iraq", "Iraq", 'iq'],
  ["ireland", "Ireland", 'ie'],
  ["isle of man", "Isle of Man", 'im'],
  ["israel", "Israel", 'il'],
  ["italy", "Italy", 'it'],
  ["jamaica", "Jamaica", 'jm'],
  ["japan", "Japan", 'jp'],
  ["jersey", "Jersey", 'je'],
  ["jordan", "Jordan", 'jo'],
  ["kazakhstan", "Kazakhstan", 'kz'],
  ["kenya", "Kenya", 'ke'],
  ["kiribati", "Kiribati", 'ki'],
  ["kosovo", "Kosovo", 'xk'],
  ["kuwait", "Kuwait", 'kw'],
  ["kyrgyzstan", "Kyrgyzstan", 'kg'],
  ["laos", "Laos", 'la'],
  ["latvia", "Latvia", 'lv'],
  ["lebanon", "Lebanon", 'lb'],
  ["lesotho", "Lesotho", 'ls'],
  ["liberia", "Liberia", 'lr'],
  ["libya", "Libya", 'ly'],
  ["liechtenstein", "Liechtenstein", 'li'],
  ["lithuania", "Lithuania", 'lt'],
  ["luxembourg", "Luxembourg", 'lu'],
  ["macau", "Macao SAR China", 'mo'],
  ["madagascar", "Madagascar", 'mg'],
  ["malawi", "Malawi", 'mw'],
  ["malaysia", "Malaysia", 'my'],
  ["maldives", "Maldives", 'mv'],
  ["mali", "Mali", 'ml'],
  ["malta", "Malta", 'mt'],
  ["marshall islands", "Marshall Islands", 'mh'],
  ["martinique", "Martinique", 'mq'],
  ["mauritania", "Mauritania", 'mr'],
  ["mauritius", "Mauritius", 'mu'],
  ["mayotte", "Mayotte", 'yt'],
  ["mexico", "Mexico", 'mx'],
  ["micronesia", "Micronesia", 'fm'],
  ["moldova", "Moldova", 'md'],
  ["monaco", "Monaco", 'mc'],
  ["mongolia", "Mongolia", 'mn'],
  ["montenegro", "Montenegro", 'me'],
  ["montserrat", "Montserrat", 'ms'],
  ["morocco", "Morocco", 'ma'],
  ["mozambique", "Mozambique", 'mz'],
  ["myanmar", "Myanmar (Burma)", 'mm'],
  ["namibia", "Namibia", 'na'],
  ["nauru", "Nauru", 'nr'],
  ["nepal", "Nepal", 'np'],
  ["netherlands", "Netherlands", 'nl'],
  ["new caledonia", "New Caledonia", 'nc'],
  ["new zealand", "New Zealand", 'nz'],
  ["nicaragua", "Nicaragua", 'ni'],
  ["niger", "Niger", 'ne'],
  ["nigeria", "Nigeria", 'ng'],
  ["niue", "Niue", 'nu'],
  ["norfolk island", "Norfolk Island", 'nf'],
  ["north korea", "North Korea", 'kp'],
  ["north macedonia", "North Macedonia", 'mk'],
  ["northern mariana islands", "Northern Mariana Islands", 'mp'],
  ["norway", "Norway", 'no'],
  ["oman", "Oman", 'om'],
  ["pakistan", "Pakistan", 'pk'],
  ["palau", "Palau", 'pw'],
  ["palestine", "Palestinian Territories", 'ps'],
  ["panama", "Panama", 'pa'],
  ["papua new guinea", "Papua New Guinea", 'pg'],
  ["paraguay", "Paraguay", 'py'],
  ["peru", "Peru", 'pe'],
  ["philippines", "Philippines", 'ph'],
  ["pitcairn islands", "Pitcairn Islands", 'pn'],
  ["poland", "Poland", 'pl'],
  ["portugal", "Portugal", 'pt'],
  ["puerto rico", "Puerto Rico", 'pr'],
  ["qatar", "Qatar", 'qa'],
  ["réunion", "Réunion", 're'],
  ["romania", "Romania", 'ro'],
  ["russia", "Russia", 'ru'],
  ["rwanda", "Rwanda", 'rw'],
  ["samoa", "Samoa", 'ws'],
  ["san marino", "San Marino", 'sm'],
  ["são tomé and príncipe", "São Tomé & Príncipe", 'st'],
  ["saudi arabia", "Saudi Arabia", 'sa'],
  ["senegal", "Senegal", 'sn'],
  ["serbia", "Serbia", 'rs'],
  ["seychelles", "Seychelles", 'sc'],
  ["sierra leone", "Sierra Leone", 'sl'],
  ["singapore", "Singapore", 'sg'],
  ["sint maarten", "Sint Maarten", 'sx'],
  ["slovakia", "Slovakia", 'sk'],
  ["slovenia", "Slovenia", 'si'],
  ["solomon islands", "Solomon Islands", 'sb'],
  ["somalia", "Somalia", 'so'],
  ["south africa", "South Africa", 'za'],
  ["south georgia and the south sandwich islands", "South Georgia & South Sandwich Islands", 'gs'],
  ["south korea", "South Korea", 'kr'],
  ["south sudan", "South Sudan", 'ss'],
  ["spain", "Spain", 'es'],
  ["sri lanka", "Sri Lanka", 'lk'],
  ["saint barthélemy", "St. Barthélemy", 'bl'],
  ["saint helena", "St. Helena", 'sh'],
  ["saint kitts and nevis", "St. Kitts & Nevis", 'kn'],
  ["saint lucia", "St. Lucia", 'lc'],
  ["saint martin", "St. Martin", 'mf'],
  ["saint pierre and miquelon", "St. Pierre & Miquelon", 'pm'],
  ["saint vincent and the grenadines", "St. Vincent & Grenadines", 'vc'],
  ["sudan", "Sudan", 'sd'],
  ["suriname", "Suriname", 'sr'],
  ["svalbard and jan mayen", "Svalbard & Jan Mayen", 'sj'],
  ["sweden", "Sweden", 'se'],
  ["switzerland", "Switzerland", 'ch'],
  ["syria", "Syria", 'sy'],
  ["taiwan", "Taiwan", 'tw'],
  ["tajikistan", "Tajikistan", 'tj'],
  ["tanzania", "Tanzania", 'tz'],
  ["thailand", "Thailand", 'th'],
  ["timor-leste", "Timor-Leste", 'tl'],
  ["togo", "Togo", 'tg'],
  ["tokelau", "Tokelau", 'tk'],
  ["tonga", "Tonga", 'to'],
  ["trinidad and tobago", "Trinidad & Tobago", 'tt'],
  ["tunisia", "Tunisia", 'tn'],
  ["turkey", "Türkiye", 'tr'],
  ["turkmenistan", "Turkmenistan", 'tm'],
  ["turks and caicos islands", "Turks & Caicos Islands", 'tc'],
  ["tuvalu", "Tuvalu", 'tv'],
  ["united states minor outlying islands", "U.S. Outlying Islands", 'um'],
  ["u.s. virgin islands", "U.S. Virgin Islands", 'vi'],
  ["uganda", "Uganda", 'ug'],
  ["ukraine", "Ukraine", 'ua'],
  ["united arab emirates", "United Arab Emirates", 'ae'],
  ["united kingdom", "United Kingdom", 'gb'],
  ["united states", "United States", 'us'],
  ["uruguay", "Uruguay", 'uy'],
  ["uzbekistan", "Uzbekistan", 'uz'],
  ["vanuatu", "Vanuatu", 'vu'],
  ["vatican city", "Vatican City", 'va'],
  ["venezuela", "Venezuela", 've'],
  ["vietnam", "Vietnam", 'vn'],
  ["wallis and futuna", "Wallis & Futuna", 'wf'],
  ["western sahara", "Western Sahara", 'eh'],
  ["yemen", "Yemen", 'ye'],
  ["zambia", "Zambia", 'zm'],
  ["zimbabwe", "Zimbabwe", 'zw'],
];

/**
 * Юрисдикции, которые выбор стран не предлагает и запись отклоняет (решение по
 * умолчанию из соображений комплаенса; снимается одной строкой — решает
 * владелец). Уже сохранённое значение всё равно соблюдается замком сборки.
 */
export const ENG_COUNTRIES_HIDDEN: readonly string[] = Object.freeze([
  'belarus',
  'cuba',
  'iran',
  'north korea',
  'russia',
  'syria',
]);

const HIDDEN = new Set(ENG_COUNTRIES_HIDDEN);

const ALL_COUNTRIES: readonly EngCountry[] = Object.freeze(
  ALL.map(([value, label, iso2]) => Object.freeze({ value, label, iso2 })),
);

/** Предлагаемые клиенту страны (243), по подписи. */
export const ENG_COUNTRIES: readonly EngCountry[] = Object.freeze(ALL_COUNTRIES.filter((c) => !HIDDEN.has(c.value)));

export const HE_COLLECT_COUNTRIES_MAX = 50;
export const ENG_COUNTRY_US = 'united states';

const BY_VALUE: ReadonlyMap<string, EngCountry> = new Map(ALL_COUNTRIES.map((c) => [c.value, c] as const));

/**
 * Ключ сравнения ввода: NFKD без диакритики, затем правила labelKey
 * pdlCatalog.ts — регистр, «&» ↔ «and», пунктуация и пробелы не различаются.
 * «Curaçao» и «Curacao», «Côte d’Ivoire» и «Cote d'Ivoire» дают один ключ.
 */
export function engCountryKey(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Псевдонимы (ключи — в форме engCountryKey) → значение каталога. Надмножество
 * COUNTRY_ALIASES pdlCatalog.ts плюс частые имена, которыми страну называют
 * люди: части UK, Holland, Czech Republic, Türkiye.
 */
const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  us: 'united states',
  usa: 'united states',
  'u s': 'united states',
  'u s a': 'united states',
  'united states of america': 'united states',
  uk: 'united kingdom',
  'u k': 'united kingdom',
  'great britain': 'united kingdom',
  britain: 'united kingdom',
  england: 'united kingdom',
  scotland: 'united kingdom',
  wales: 'united kingdom',
  'northern ireland': 'united kingdom',
  uae: 'united arab emirates',
  holland: 'netherlands',
  'the netherlands': 'netherlands',
  'czech republic': 'czechia',
  turkiye: 'turkey',
  'republic of ireland': 'ireland',
});

/** Ключ → значение каталога: само значение, подпись и псевдонимы. */
const BY_KEY: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const c of ALL_COUNTRIES) {
    map.set(engCountryKey(c.value), c.value);
    map.set(engCountryKey(c.label), c.value);
  }
  for (const [alias, value] of Object.entries(ALIASES)) map.set(alias, value);
  return map;
})();

/** Ввод → значение каталога; неизвестная или скрытая страна — null. */
export function normalizeEngCountry(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = engCountryKey(raw);
  if (!key) return null;
  const value = BY_KEY.get(key) ?? null;
  return value && !HIDDEN.has(value) ? value : null;
}

/** Без повторов, по алфавиту значения: один набор — один хеш плана и закладок. */
export function canonicalEngCountries(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export type HeCollectCountriesParse =
  | { ok: true; countries: string[] }
  | { ok: false; error: 'not_array' | 'too_many' | 'unknown'; input?: string };

/**
 * Ввод клиента или staff (тело запроса) — строго: незнакомое значение не
 * выбрасывается молча, а отклоняется. null и [] — «без ограничения» ([]).
 */
export function parseHeCollectCountries(raw: unknown): HeCollectCountriesParse {
  if (raw === null) return { ok: true, countries: [] };
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) return { ok: false, error: 'not_array' };
  const out: string[] = [];
  for (const item of raw as string[]) {
    if (!item.trim()) continue;
    const value = normalizeEngCountry(item);
    if (!value) return { ok: false, error: 'unknown', input: item.trim().slice(0, 80) };
    out.push(value);
  }
  const countries = canonicalEngCountries(out);
  if (countries.length > HE_COLLECT_COUNTRIES_MAX) return { ok: false, error: 'too_many' };
  return { ok: true, countries };
}

export function heCollectCountriesErrorText(e: Extract<HeCollectCountriesParse, { ok: false }>): string {
  switch (e.error) {
    case 'unknown':
      return `Unknown country: "${e.input ?? ''}". Choose countries from the list.`;
    case 'too_many':
      return `Choose up to ${HE_COLLECT_COUNTRIES_MAX} countries.`;
    default:
      return 'collect_countries must be a list of country names.';
  }
}

/** Значение-заглушка испорченного списка: не совпадает ни с одной страной. */
export const HE_COLLECT_COUNTRIES_INVALID = '__invalid__';

/**
 * Сохранённый список — FAIL-CLOSED (§1A): что лежит в jsonb, то и соблюдается.
 *  - нет ключа, null или [] — ограничения нет;
 *  - непустой массив — КАЖДАЯ строка остаётся (trim + нижний регистр), даже если
 *    справочник её больше не знает; такие — ещё и в `unavailable`;
 *  - ключ есть, но не массив или без единой строки — `['__invalid__']`: замок,
 *    который не пропускает ничего (метка не резолвится, срез мёртв).
 */
export function readHeCollectCountries(raw: unknown): { countries: string[]; unavailable: string[] } {
  if (raw === undefined || raw === null) return { countries: [], unavailable: [] };
  if (!Array.isArray(raw)) return { countries: [HE_COLLECT_COUNTRIES_INVALID], unavailable: [] };
  if (raw.length === 0) return { countries: [], unavailable: [] };
  const strings = raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (strings.length === 0) return { countries: [HE_COLLECT_COUNTRIES_INVALID], unavailable: [] };
  const countries = canonicalEngCountries(strings);
  return { countries, unavailable: countries.filter((c) => !BY_VALUE.has(c)) };
}

/** Подпись страны; незнакомое значение — словами с заглавной. */
export function engCountryLabel(value: string): string {
  return BY_VALUE.get(value)?.label ?? value.replace(/(^|\s)(\p{L})/gu, (_, s: string, ch: string) => s + ch.toUpperCase());
}

/** ISO-код страны каталога или null. */
export function engCountryIso2(value: string): string | null {
  return BY_VALUE.get(value)?.iso2 ?? null;
}
