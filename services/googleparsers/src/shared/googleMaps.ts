import type { PlaceResult, ScrapeSettings, SearchTarget } from "./types";

export const DEFAULT_SETTINGS: ScrapeSettings = {
  inputLines: [],
  cities: [],
  categories: [],
  keyword: "",
  limitPerQuery: 100,
  language: "ru",
  region: "RU",
  minDelayMs: 1200,
  maxDelayMs: 2800,
  proxies: [],
  enrichContacts: true
};

export function buildGoogleMapsSearchUrl(query: string, language = "ru", region = "RU"): string {
  const encodedQuery = encodeURIComponent(query.trim()).replace(/%20/g, "+");
  const params = new URLSearchParams({
    hl: language || "ru",
    gl: (region || "RU").toUpperCase()
  });
  return `https://www.google.com/maps/search/${encodedQuery}?${params.toString()}`;
}

export function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function normalizeInputUrlOrQuery(line: string, language = "ru", region = "RU"): SearchTarget {
  const raw = line.trim();
  const isUrl = /^https?:\/\//i.test(raw);
  const query = isUrl ? extractQueryFromGoogleMapsUrl(raw) || raw : raw;
  const url = isUrl ? ensureGoogleMapsLocale(raw, language, region) : buildGoogleMapsSearchUrl(raw, language, region);

  return {
    id: stableId(`${query}|${url}`),
    query,
    city: "",
    category: "",
    url,
    sourceUrl: raw
  };
}

export function generateSearchTargets(settings: ScrapeSettings): SearchTarget[] {
  const targets = new Map<string, SearchTarget>();
  const language = settings.language || DEFAULT_SETTINGS.language;
  const region = settings.region || DEFAULT_SETTINGS.region;

  for (const line of settings.inputLines) {
    const target = normalizeInputUrlOrQuery(line, language, region);
    targets.set(target.id, target);
  }

  const keyword = settings.keyword.trim();
  const categories = keyword ? [keyword] : settings.categories;

  for (const city of settings.cities) {
    for (const category of categories) {
      const query = [category.trim(), city.trim()].filter(Boolean).join(" ");
      if (!query) continue;
      const target: SearchTarget = {
        id: stableId(`${query}|${language}|${region}`),
        query,
        city,
        category: keyword ? keyword : category,
        url: buildGoogleMapsSearchUrl(query, language, region),
        sourceUrl: "generator"
      };
      targets.set(target.id, target);
    }
  }

  return [...targets.values()];
}

export function extractQueryFromGoogleMapsUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const q = parsed.searchParams.get("q");
    if (q) return q.trim();

    const searchMatch = parsed.pathname.match(/\/maps\/search\/([^/@]+)/);
    if (searchMatch?.[1]) return decodeURIComponent(searchMatch[1].replace(/\+/g, " ")).trim();
  } catch {
    return "";
  }

  return "";
}

export function ensureGoogleMapsLocale(url: string, language = "ru", region = "RU"): string {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.get("hl")) parsed.searchParams.set("hl", language || "ru");
    if (!parsed.searchParams.get("gl")) parsed.searchParams.set("gl", (region || "RU").toUpperCase());
    return parsed.toString();
  } catch {
    return url;
  }
}

export function extractCoordinatesFromUrl(url: string): { latitude: string; longitude: string } {
  const match = url.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),/);
  if (!match) return { latitude: "", longitude: "" };
  return { latitude: match[1], longitude: match[2] };
}

export function stableId(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}
