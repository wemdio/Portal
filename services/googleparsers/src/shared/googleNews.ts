import type { NewsDateRange, NewsScrapeSettings, NewsTarget } from "./types";

export const DEFAULT_NEWS_QUERIES = [
  '"registration is open" "conference" "New York"',
  '"early bird registration" "conference" "New York"',
  '"annual conference" "association" "New York"',
  '"sponsorship opportunities" "conference" "New York"',
  '"call for sponsors" "conference" "New York"',
  '"exhibitor registration" "trade show" "New York"',
  '"tickets are now available" "business conference" "New York"',
  '"Cvent" "conference" "New York"',
  '"Eventbrite" "summit" "New York"'
];

export const DEFAULT_NEWS_SETTINGS: NewsScrapeSettings = {
  queries: DEFAULT_NEWS_QUERIES,
  pagesLimit: 1,
  country: "US",
  language: "en",
  dateRange: "any",
  minDelayMs: 1200,
  maxDelayMs: 2800,
  proxies: []
};

export function splitNewsQueries(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function buildGoogleNewsSearchUrl(
  query: string,
  language = DEFAULT_NEWS_SETTINGS.language,
  country = DEFAULT_NEWS_SETTINGS.country,
  dateRange: NewsDateRange = DEFAULT_NEWS_SETTINGS.dateRange,
  page = 1
): string {
  const params = new URLSearchParams({
    q: query.trim(),
    tbm: "nws",
    hl: language || DEFAULT_NEWS_SETTINGS.language,
    gl: (country || DEFAULT_NEWS_SETTINGS.country).toUpperCase()
  });

  const tbs = dateRangeToTbs(dateRange);
  if (tbs) params.set("tbs", tbs);

  if (page > 1) {
    params.set("start", String((page - 1) * 10));
  }

  return `https://www.google.com/search?${params.toString()}`;
}

export function buildGoogleNewsRssUrl(
  query: string,
  language = DEFAULT_NEWS_SETTINGS.language,
  country = DEFAULT_NEWS_SETTINGS.country,
  dateRange: NewsDateRange = DEFAULT_NEWS_SETTINGS.dateRange
): string {
  const normalizedCountry = (country || DEFAULT_NEWS_SETTINGS.country).toUpperCase();
  const normalizedLanguage = language || DEFAULT_NEWS_SETTINGS.language;
  const params = new URLSearchParams({
    q: withRssDateRange(query.trim(), dateRange),
    hl: `${normalizedLanguage}-${normalizedCountry}`,
    gl: normalizedCountry,
    ceid: `${normalizedCountry}:${normalizedLanguage}`
  });

  return `https://news.google.com/rss/search?${params.toString()}`;
}

export function generateNewsTargets(settings: NewsScrapeSettings): NewsTarget[] {
  const targets: NewsTarget[] = [];
  const pagesLimit = Math.max(1, Math.min(10, Number(settings.pagesLimit) || DEFAULT_NEWS_SETTINGS.pagesLimit));
  const language = settings.language || DEFAULT_NEWS_SETTINGS.language;
  const country = settings.country || DEFAULT_NEWS_SETTINGS.country;
  const dateRange = settings.dateRange || DEFAULT_NEWS_SETTINGS.dateRange;

  settings.queries
    .map((query) => query.trim())
    .filter(Boolean)
    .forEach((query, queryIndex) => {
      for (let page = 1; page <= pagesLimit; page += 1) {
        const url = buildGoogleNewsSearchUrl(query, language, country, dateRange, page);
        targets.push({
          id: stableId(`${queryIndex}|${query}|${page}|${language}|${country}|${dateRange}`),
          query,
          page,
          url,
          sourceUrl: query
        });
      }
    });

  return targets;
}

export function dateRangeToTbs(dateRange: NewsDateRange): string {
  const map: Record<NewsDateRange, string> = {
    any: "",
    hour: "qdr:h",
    day: "qdr:d",
    week: "qdr:w",
    month: "qdr:m",
    year: "qdr:y"
  };
  return map[dateRange] ?? "";
}

function withRssDateRange(query: string, dateRange: NewsDateRange): string {
  const map: Record<NewsDateRange, string> = {
    any: "",
    hour: "when:1h",
    day: "when:1d",
    week: "when:7d",
    month: "when:30d",
    year: "when:365d"
  };
  const suffix = map[dateRange] ?? "";
  return [query, suffix].filter(Boolean).join(" ");
}

function stableId(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}
