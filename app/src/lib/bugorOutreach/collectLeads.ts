import * as cheerio from 'cheerio';
import type { RawNewsItem } from './types';

const FETCH_TIMEOUT = 15_000;

function withTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

// ---------------------------------------------------------------------------
// Google News RSS — multiple targeted queries
// ---------------------------------------------------------------------------

const GOOGLE_NEWS_RSS = 'https://news.google.com/rss/search';

const GOOGLE_NEWS_QUERIES = [
  'B2B SaaS "pre-seed" OR "seed round" startup 2026',
  'B2B startup "seed funding" OR "angel round" early-stage',
  'startup hiring "first sales" OR "founding SDR" OR "founding BDR"',
  'B2B SaaS startup launch announce 2026 early-stage',
  '"seed round" "$1M" OR "$2M" OR "$3M" OR "$4M" OR "$5M" B2B',
  'startup "series A" "under $10M" OR "early stage" B2B SaaS',
  'small startup hiring "head of sales" OR "SDR" B2B 2026',
];

async function fetchGoogleNewsRSS(): Promise<RawNewsItem[]> {
  const items: RawNewsItem[] = [];

  await Promise.allSettled(
    GOOGLE_NEWS_QUERIES.map(async (query) => {
      const url = `${GOOGLE_NEWS_RSS}?q=${encodeURIComponent(query)}&hl=en&gl=US&ceid=US:en`;
      try {
        const res = await fetch(url, { signal: withTimeout(FETCH_TIMEOUT) });
        if (!res.ok) return;
        const xml = await res.text();
        const $ = cheerio.load(xml, { xmlMode: true });
        $('item').each((_, el) => {
          const title = $(el).find('title').text().trim();
          const link = $(el).find('link').text().trim();
          const desc = $(el).find('description').text().trim();
          const pubDate = $(el).find('pubDate').text().trim();
          if (title && link) {
            items.push({
              title,
              description: desc || title,
              url: link,
              source: 'google_news',
              publishedAt: pubDate || undefined,
            });
          }
        });
      } catch { /* non-critical */ }
    }),
  );

  return items.slice(0, 60);
}

// ---------------------------------------------------------------------------
// TechCrunch RSS
// ---------------------------------------------------------------------------

const TECHCRUNCH_RSS = 'https://techcrunch.com/feed/';
const TC_KEYWORDS = [
  'seed', 'pre-seed', 'raise', 'raised', 'funding', 'series a',
  'launch', 'b2b', 'saas', 'startup', 'announces', 'secures',
];

async function fetchTechCrunchRSS(): Promise<RawNewsItem[]> {
  try {
    const res = await fetch(TECHCRUNCH_RSS, { signal: withTimeout(FETCH_TIMEOUT) });
    if (!res.ok) return [];
    const xml = await res.text();
    const $ = cheerio.load(xml, { xmlMode: true });
    const items: RawNewsItem[] = [];

    $('item').each((_, el) => {
      const title = $(el).find('title').text().trim();
      const link = $(el).find('link').text().trim();
      const desc = $(el).find('description').text().trim();
      const pubDate = $(el).find('pubDate').text().trim();
      const lower = `${title} ${desc}`.toLowerCase();
      if (title && link && TC_KEYWORDS.some((kw) => lower.includes(kw))) {
        items.push({
          title,
          description: desc.replace(/<[^>]*>/g, '').slice(0, 500),
          url: link,
          source: 'techcrunch',
          publishedAt: pubDate || undefined,
        });
      }
    });

    return items.slice(0, 30);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// VentureBeat + EU-Startups RSS
// ---------------------------------------------------------------------------

const EXTRA_RSS_FEEDS: Array<{ url: string; source: RawNewsItem['source']; keywords: string[] }> = [
  {
    url: 'https://www.eu-startups.com/feed/',
    source: 'google_news',
    keywords: ['seed', 'pre-seed', 'raise', 'raised', 'funding', 'b2b', 'saas', 'launch'],
  },
];

async function fetchExtraRSSFeeds(): Promise<RawNewsItem[]> {
  const items: RawNewsItem[] = [];

  await Promise.allSettled(
    EXTRA_RSS_FEEDS.map(async ({ url, source, keywords }) => {
      try {
        const res = await fetch(url, { signal: withTimeout(FETCH_TIMEOUT) });
        if (!res.ok) return;
        const xml = await res.text();
        const $ = cheerio.load(xml, { xmlMode: true });

        $('item').each((_, el) => {
          const title = $(el).find('title').text().trim();
          const link = $(el).find('link').text().trim();
          const desc = $(el).find('description').text().trim();
          const pubDate = $(el).find('pubDate').text().trim();
          const lower = `${title} ${desc}`.toLowerCase();
          if (title && link && keywords.some((kw) => lower.includes(kw))) {
            items.push({
              title,
              description: desc.replace(/<[^>]*>/g, '').slice(0, 500),
              url: link,
              source,
              publishedAt: pubDate || undefined,
            });
          }
        });
      } catch { /* non-critical */ }
    }),
  );

  return items.slice(0, 30);
}

// ---------------------------------------------------------------------------
// Product Hunt RSS
// ---------------------------------------------------------------------------

const PH_RSS = 'https://www.producthunt.com/feed';
const PH_KEYWORDS = ['b2b', 'saas', 'sales', 'crm', 'outbound', 'pipeline', 'enterprise', 'ai agent', 'startup', 'automation', 'api'];

async function fetchProductHunt(): Promise<RawNewsItem[]> {
  try {
    const res = await fetch(PH_RSS, {
      signal: withTimeout(FETCH_TIMEOUT),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BugorBot/1.0)' },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const $ = cheerio.load(xml, { xmlMode: true });
    const items: RawNewsItem[] = [];

    $('item').each((_, el) => {
      const title = $(el).find('title').text().trim();
      const link = $(el).find('link').text().trim();
      const desc = $(el).find('description').text().trim();
      const pubDate = $(el).find('pubDate').text().trim();
      const lower = `${title} ${desc}`.toLowerCase();
      if (title && link && PH_KEYWORDS.some((kw) => lower.includes(kw))) {
        items.push({
          title: `[Product Hunt] ${title}`,
          description: desc.replace(/<[^>]*>/g, '').slice(0, 500),
          url: link,
          source: 'google_news',
          publishedAt: pubDate || undefined,
        });
      }
    });

    return items.slice(0, 15);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// BetaList — newly launched startups (very early stage)
// ---------------------------------------------------------------------------

const BETALIST_RSS = 'https://betalist.com/feed';
const BETALIST_KEYWORDS = ['b2b', 'saas', 'sales', 'crm', 'outbound', 'pipeline', 'enterprise', 'ai', 'startup', 'automation', 'api', 'platform', 'tool', 'analytics', 'marketing'];

async function fetchBetaList(): Promise<RawNewsItem[]> {
  try {
    const res = await fetch(BETALIST_RSS, {
      signal: withTimeout(FETCH_TIMEOUT),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BugorBot/1.0)' },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const $ = cheerio.load(xml, { xmlMode: true });
    const items: RawNewsItem[] = [];

    $('item').each((_, el) => {
      const title = $(el).find('title').text().trim();
      const link = $(el).find('link').text().trim();
      const desc = $(el).find('description').text().trim();
      const pubDate = $(el).find('pubDate').text().trim();
      const lower = `${title} ${desc}`.toLowerCase();
      if (title && link && BETALIST_KEYWORDS.some((kw) => lower.includes(kw))) {
        items.push({
          title: `[BetaList] ${title}`,
          description: desc.replace(/<[^>]*>/g, '').slice(0, 500),
          url: link,
          source: 'google_news',
          publishedAt: pubDate || undefined,
        });
      }
    });

    return items.slice(0, 20);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// IndieHackers — bootstrapped / early-stage B2B
// ---------------------------------------------------------------------------

const IH_RSS = 'https://www.indiehackers.com/feed.xml';
const IH_KEYWORDS = ['b2b', 'saas', 'mrr', 'arr', 'revenue', 'sales', 'outbound', 'cold email', 'launch', 'startup', 'customers', 'enterprise'];

async function fetchIndieHackers(): Promise<RawNewsItem[]> {
  try {
    const res = await fetch(IH_RSS, {
      signal: withTimeout(FETCH_TIMEOUT),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BugorBot/1.0)' },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const $ = cheerio.load(xml, { xmlMode: true });
    const items: RawNewsItem[] = [];

    $('item').each((_, el) => {
      const title = $(el).find('title').text().trim();
      const link = $(el).find('link').text().trim();
      const desc = $(el).find('description').text().trim();
      const pubDate = $(el).find('pubDate').text().trim();
      const lower = `${title} ${desc}`.toLowerCase();
      if (title && link && IH_KEYWORDS.some((kw) => lower.includes(kw))) {
        items.push({
          title: `[IndieHackers] ${title}`,
          description: desc.replace(/<[^>]*>/g, '').slice(0, 500),
          url: link,
          source: 'google_news',
          publishedAt: pubDate || undefined,
        });
      }
    });

    return items.slice(0, 20);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Hacker News — Show HN (B2B / SaaS)
// ---------------------------------------------------------------------------

const HN_API = 'https://hn.algolia.com/api/v1/search_by_date';

interface HNHit {
  title?: string;
  url?: string;
  story_url?: string;
  objectID?: string;
  created_at?: string;
}

const HN_KEYWORDS = ['b2b', 'saas', 'startup', 'sales', 'outbound', 'crm', 'pipeline', 'launch', 'hiring'];

async function fetchHackerNews(): Promise<RawNewsItem[]> {
  try {
    const url = `${HN_API}?tags=show_hn&hitsPerPage=50`;
    const res = await fetch(url, { signal: withTimeout(FETCH_TIMEOUT) });
    if (!res.ok) return [];
    const data = (await res.json()) as { hits?: HNHit[] };
    const items: RawNewsItem[] = [];

    for (const hit of data.hits ?? []) {
      const title = hit.title ?? '';
      const lower = title.toLowerCase();
      if (!HN_KEYWORDS.some((kw) => lower.includes(kw))) continue;
      const link = hit.url || hit.story_url || `https://news.ycombinator.com/item?id=${hit.objectID}`;
      items.push({
        title,
        description: title,
        url: link,
        source: 'hackernews',
        publishedAt: hit.created_at ?? undefined,
      });
    }

    return items.slice(0, 15);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// YC Directory — Algolia API (latest batch B2B companies)
// ---------------------------------------------------------------------------

const YC_ALGOLIA_APP_ID = '45BWZJ1SGC';
const YC_COMPANIES_PAGE = 'https://www.ycombinator.com/companies';

interface YCCompany {
  name?: string;
  slug?: string;
  website?: string;
  one_liner?: string;
  long_description?: string;
  batch?: string;
  industry?: string;
  subindustry?: string;
  tags?: string[];
  team_size?: number;
  isHiring?: boolean;
  launched_at?: number;
}

async function getYCAlgoliaKey(): Promise<string | null> {
  try {
    const res = await fetch(YC_COMPANIES_PAGE, {
      signal: withTimeout(FETCH_TIMEOUT),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BugorBot/1.0)' },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/AlgoliaOpts\s*=\s*\{"app":"[^"]+","key":"([^"]+)"/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function fetchYCDirectory(): Promise<RawNewsItem[]> {
  try {
    const algoliaKey = await getYCAlgoliaKey();
    if (!algoliaKey) {
      console.warn('[bugor-collect] Could not extract YC Algolia key');
      return [];
    }

    const searchUrl = `https://${YC_ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/YCCompany_By_Launch_Date_production`;
    const params = new URLSearchParams({
      query: '',
      hitsPerPage: '30',
      facetFilters: JSON.stringify([['industry:B2B']]),
    });

    const res = await fetch(`${searchUrl}?${params}`, {
      signal: withTimeout(FETCH_TIMEOUT),
      headers: {
        'X-Algolia-Application-Id': YC_ALGOLIA_APP_ID,
        'X-Algolia-API-Key': algoliaKey,
      },
    });

    if (!res.ok) return [];
    const data = (await res.json()) as { hits?: YCCompany[] };
    const items: RawNewsItem[] = [];

    for (const c of data.hits ?? []) {
      const name = c.name ?? '';
      if (!name) continue;
      const batch = c.batch ?? '';
      const desc = c.one_liner ?? '';
      const longDesc = (c.long_description ?? '').slice(0, 400);
      const tags = (c.tags ?? []).join(', ');
      const hiring = c.isHiring ? ' (HIRING)' : '';

      items.push({
        title: `${name} (YC ${batch})${hiring} — ${desc}`,
        description: `${name}: ${desc}. Batch: ${batch}. Tags: ${tags}. ${longDesc}`,
        url: c.website || `https://www.ycombinator.com/companies/${c.slug}`,
        source: 'yc_directory',
      });
    }

    return items;
  } catch (err) {
    console.warn('[bugor-collect] YC Algolia failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dedup(items: RawNewsItem[]): RawNewsItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.url || item.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function collectRawLeads(): Promise<RawNewsItem[]> {
  console.log('[bugor-collect] Starting data collection from 8 sources...');
  const [google, tc, extraRss, ph, beta, ih, hn, yc] = await Promise.allSettled([
    fetchGoogleNewsRSS(),
    fetchTechCrunchRSS(),
    fetchExtraRSSFeeds(),
    fetchProductHunt(),
    fetchBetaList(),
    fetchIndieHackers(),
    fetchHackerNews(),
    fetchYCDirectory(),
  ]);

  const label = (r: PromiseSettledResult<RawNewsItem[]>) =>
    r.status === 'fulfilled' ? r.value.length : 0;

  console.log(
    `[bugor-collect] Results: Google=${label(google)}, TC=${label(tc)}, ExtraRSS=${label(extraRss)}, PH=${label(ph)}, BetaList=${label(beta)}, IndieHackers=${label(ih)}, HN=${label(hn)}, YC=${label(yc)}`,
  );

  for (const [name, r] of [['Google', google], ['TC', tc], ['ExtraRSS', extraRss], ['PH', ph], ['BetaList', beta], ['IndieHackers', ih], ['HN', hn], ['YC', yc]] as const) {
    if (r.status === 'rejected') console.warn(`[bugor-collect] ${name} failed:`, r.reason);
  }

  const all: RawNewsItem[] = [
    ...(google.status === 'fulfilled' ? google.value : []),
    ...(tc.status === 'fulfilled' ? tc.value : []),
    ...(extraRss.status === 'fulfilled' ? extraRss.value : []),
    ...(ph.status === 'fulfilled' ? ph.value : []),
    ...(beta.status === 'fulfilled' ? beta.value : []),
    ...(ih.status === 'fulfilled' ? ih.value : []),
    ...(hn.status === 'fulfilled' ? hn.value : []),
    ...(yc.status === 'fulfilled' ? yc.value : []),
  ];

  const result = dedup(all);
  console.log(`[bugor-collect] Total after dedup: ${result.length}`);
  return result;
}
