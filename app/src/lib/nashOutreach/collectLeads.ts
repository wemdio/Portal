import * as cheerio from 'cheerio';
import type { RawSignalItem } from './types';

const FETCH_TIMEOUT = 15_000;

function withTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

// ---------------------------------------------------------------------------
// HH.ru — hiring signals (main source)
// ---------------------------------------------------------------------------

const HH_API = 'https://api.hh.ru/vacancies';
const HH_USER_AGENT = 'Portal/1.0 (NashOutreach signal collector)';

const HH_QUERIES = [
  'менеджер по продажам B2B',
  'руководитель отдела продаж',
  'SDR BDR',
  'head of sales',
  'маркетолог B2B',
  'коммерческий директор',
];

interface HHApiItem {
  id: string;
  name: string;
  alternate_url: string;
  employer: { id?: string | null; name: string; alternate_url: string | null };
  area: { name: string };
  published_at?: string;
}

interface HHApiResponse {
  found: number;
  items: HHApiItem[];
}

interface HHEmployerDetail {
  site_url?: string | null;
}

async function fetchEmployerSite(employerId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.hh.ru/employers/${employerId}`, {
      signal: withTimeout(8_000),
      headers: { 'User-Agent': HH_USER_AGENT },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as HHEmployerDetail;
    return data.site_url?.trim() || null;
  } catch {
    return null;
  }
}

async function fetchHHSignals(): Promise<RawSignalItem[]> {
  const items: RawSignalItem[] = [];
  const seenEmployers = new Set<string>();

  await Promise.allSettled(
    HH_QUERIES.map(async (query) => {
      try {
        const params = new URLSearchParams({
          text: query,
          per_page: '20',
          order_by: 'publication_time',
          period: '1',
        });
        const res = await fetch(`${HH_API}?${params}`, {
          signal: withTimeout(FETCH_TIMEOUT),
          headers: { 'User-Agent': HH_USER_AGENT },
        });
        if (!res.ok) return;
        const data = (await res.json()) as HHApiResponse;

        for (const v of data.items) {
          const empKey = v.employer.id ?? v.employer.name;
          if (seenEmployers.has(empKey)) continue;
          seenEmployers.add(empKey);

          let companySite: string | null = null;
          if (v.employer.id) {
            companySite = await fetchEmployerSite(String(v.employer.id));
          }

          items.push({
            title: `[HH.ru] ${v.employer.name} ищет: ${v.name}`,
            description: `Компания ${v.employer.name} (${v.area.name}) разместила вакансию: ${v.name}`,
            url: v.alternate_url,
            source: 'hh_ru',
            publishedAt: v.published_at,
            hh: {
              employer_id: String(v.employer.id ?? ''),
              company_name: v.employer.name,
              area: v.area.name,
              vacancy_name: v.name,
              company_site_url: companySite ?? undefined,
            },
          });
        }
      } catch { /* non-critical */ }
    }),
  );

  return items.slice(0, 80);
}

// ---------------------------------------------------------------------------
// VC.ru RSS
// ---------------------------------------------------------------------------

const VC_RSS = 'https://vc.ru/rss';
const VC_KEYWORDS = [
  'привлек', 'привлекл', 'инвестиц', 'раунд', 'seed', 'b2b', 'saas',
  'запуск', 'запустил', 'стартап', 'выручк', 'масштабир', 'серия a',
  'нанимает', 'найм', 'продаж', 'маркетинг',
];

async function fetchVcRu(): Promise<RawSignalItem[]> {
  try {
    const res = await fetch(VC_RSS, {
      signal: withTimeout(FETCH_TIMEOUT),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NashOutreach/1.0)' },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const $ = cheerio.load(xml, { xmlMode: true });
    const items: RawSignalItem[] = [];

    $('item').each((_, el) => {
      const title = $(el).find('title').text().trim();
      const link = $(el).find('link').text().trim();
      const desc = $(el).find('description').text().trim();
      const pubDate = $(el).find('pubDate').text().trim();
      const lower = `${title} ${desc}`.toLowerCase();
      if (title && link && VC_KEYWORDS.some((kw) => lower.includes(kw))) {
        items.push({
          title,
          description: desc.replace(/<[^>]*>/g, '').slice(0, 500),
          url: link,
          source: 'vc_ru',
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
// RBC RSS
// ---------------------------------------------------------------------------

const RBC_RSS = 'https://rssexport.rbc.ru/rbcnews/news/30/full.rss';
const RBC_KEYWORDS = [
  'инвестиц', 'привлек', 'стартап', 'b2b', 'раунд', 'выручк',
  'масштабир', 'расширен', 'экспанси', 'запуск', 'нанимает',
];

async function fetchRbc(): Promise<RawSignalItem[]> {
  try {
    const res = await fetch(RBC_RSS, {
      signal: withTimeout(FETCH_TIMEOUT),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NashOutreach/1.0)' },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const $ = cheerio.load(xml, { xmlMode: true });
    const items: RawSignalItem[] = [];

    $('item').each((_, el) => {
      const title = $(el).find('title').text().trim();
      const link = $(el).find('link').text().trim();
      const desc = $(el).find('description').text().trim();
      const pubDate = $(el).find('pubDate').text().trim();
      const lower = `${title} ${desc}`.toLowerCase();
      if (title && link && RBC_KEYWORDS.some((kw) => lower.includes(kw))) {
        items.push({
          title,
          description: desc.replace(/<[^>]*>/g, '').slice(0, 500),
          url: link,
          source: 'rbc',
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
// Kommersant RSS
// ---------------------------------------------------------------------------

const KOMMERSANT_RSS = 'https://www.kommersant.ru/RSS/news.xml';

async function fetchKommersant(): Promise<RawSignalItem[]> {
  try {
    const res = await fetch(KOMMERSANT_RSS, {
      signal: withTimeout(FETCH_TIMEOUT),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NashOutreach/1.0)' },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const $ = cheerio.load(xml, { xmlMode: true });
    const items: RawSignalItem[] = [];

    $('item').each((_, el) => {
      const title = $(el).find('title').text().trim();
      const link = $(el).find('link').text().trim();
      const desc = $(el).find('description').text().trim();
      const pubDate = $(el).find('pubDate').text().trim();
      const lower = `${title} ${desc}`.toLowerCase();
      if (title && link && RBC_KEYWORDS.some((kw) => lower.includes(kw))) {
        items.push({
          title,
          description: desc.replace(/<[^>]*>/g, '').slice(0, 500),
          url: link,
          source: 'kommersant',
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
// Habr.com companies RSS
// ---------------------------------------------------------------------------

const HABR_RSS = 'https://habr.com/ru/rss/flows/develop/all/?fl=ru';
const HABR_KEYWORDS = [
  'b2b', 'saas', 'продаж', 'crm', 'маркетинг', 'аутрич', 'pipeline',
  'enterprise', 'ai', 'автоматизац', 'api', 'стартап', 'запуск',
];

async function fetchHabr(): Promise<RawSignalItem[]> {
  try {
    const res = await fetch(HABR_RSS, {
      signal: withTimeout(FETCH_TIMEOUT),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NashOutreach/1.0)' },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const $ = cheerio.load(xml, { xmlMode: true });
    const items: RawSignalItem[] = [];

    $('item').each((_, el) => {
      const title = $(el).find('title').text().trim();
      const link = $(el).find('link').text().trim();
      const desc = $(el).find('description').text().trim();
      const pubDate = $(el).find('pubDate').text().trim();
      const lower = `${title} ${desc}`.toLowerCase();
      if (title && link && HABR_KEYWORDS.some((kw) => lower.includes(kw))) {
        items.push({
          title: `[Habr] ${title}`,
          description: desc.replace(/<[^>]*>/g, '').slice(0, 500),
          url: link,
          source: 'habr',
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
// Helpers
// ---------------------------------------------------------------------------

function dedup(items: RawSignalItem[]): RawSignalItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.hh?.employer_id
      ? `hh:${item.hh.employer_id}`
      : item.url || item.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function collectRawSignals(): Promise<RawSignalItem[]> {
  console.log('[nash-collect] Starting data collection from 5 sources...');
  const [hh, vc, rbc, komm, habr] = await Promise.allSettled([
    fetchHHSignals(),
    fetchVcRu(),
    fetchRbc(),
    fetchKommersant(),
    fetchHabr(),
  ]);

  const label = (r: PromiseSettledResult<RawSignalItem[]>) =>
    r.status === 'fulfilled' ? r.value.length : 0;

  console.log(
    `[nash-collect] Results: HH=${label(hh)}, VC.ru=${label(vc)}, RBC=${label(rbc)}, Kommersant=${label(komm)}, Habr=${label(habr)}`,
  );

  for (const [name, r] of [['HH', hh], ['VC.ru', vc], ['RBC', rbc], ['Kommersant', komm], ['Habr', habr]] as const) {
    if (r.status === 'rejected') console.warn(`[nash-collect] ${name} failed:`, r.reason);
  }

  const all: RawSignalItem[] = [
    ...(hh.status === 'fulfilled' ? hh.value : []),
    ...(vc.status === 'fulfilled' ? vc.value : []),
    ...(rbc.status === 'fulfilled' ? rbc.value : []),
    ...(komm.status === 'fulfilled' ? komm.value : []),
    ...(habr.status === 'fulfilled' ? habr.value : []),
  ];

  const result = dedup(all);
  console.log(`[nash-collect] Total after dedup: ${result.length}`);
  return result;
}
