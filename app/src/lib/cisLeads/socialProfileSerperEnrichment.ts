import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';

const SOCIAL_LIMIT = 40;
const VERIFY_TIMEOUT_MS = 6_000;
const SERPER_API_URL = 'https://google.serper.dev/search';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function getSerperKey(): string {
  return (process.env.SERPER_API_KEY ?? '').trim();
}

interface SerperOrganicItem {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
}

async function serperSearch(query: string): Promise<SerperOrganicItem[]> {
  const apiKey = getSerperKey();
  if (!apiKey) return [];

  const res = await fetch(SERPER_API_URL, {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: 10, gl: 'ru', hl: 'ru' }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Serper API ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { organic?: SerperOrganicItem[] };
  return (data.organic ?? []).filter(
    (item): item is SerperOrganicItem => item != null && typeof item === 'object' && typeof item.link === 'string',
  );
}

interface SocialNetwork {
  key: string;
  domain: string;
  pathPrefix: string;
  buildQuery: (name: string, company: string) => string;
}

const VK_NETWORK: SocialNetwork = {
  key: 'vk',
  domain: 'vk.com',
  pathPrefix: '/',
  buildQuery: (name, company) => `site:vk.com "${name}" "${company}"`,
};

const FB_NETWORK: SocialNetwork = {
  key: 'facebook',
  domain: 'facebook.com',
  pathPrefix: '/',
  buildQuery: (name, company) => `site:facebook.com "${name}" "${company}"`,
};

const NON_LINKEDIN_NETWORKS = [VK_NETWORK, FB_NETWORK];

function extractProfileUrl(items: SerperOrganicItem[], network: SocialNetwork): string | null {
  for (const item of items) {
    const link = item.link?.trim();
    if (!link) continue;
    try {
      const url = new URL(link);
      const host = url.hostname.replace(/^www\./, '').toLowerCase();
      if (!host.endsWith(network.domain)) continue;
      if (network.key === 'linkedin' && !url.pathname.startsWith('/in/')) continue;
      if (network.key === 'vk' && (url.pathname === '/' || url.pathname.startsWith('/wall'))) continue;
      return cleanProfileUrl(link);
    } catch { /* skip invalid URLs */ }
  }
  return null;
}

function cleanProfileUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return url;
  }
}

const TRANSLIT_MAP: Record<string, string> = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e',
  'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
  'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
  'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
  'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
};

function transliterate(text: string): string {
  return text.toLowerCase().split('').map((ch) => TRANSLIT_MAP[ch] ?? ch).join('');
}

function snippetMatchesContext(
  items: SerperOrganicItem[],
  personName: string,
  companyName: string,
  title?: string | null,
): boolean {
  const nameParts = personName.toLowerCase().split(/\s+/).filter((p) => p.length > 2);
  const translitParts = nameParts.map(transliterate).filter((p) => p.length > 2);
  const companyWords = companyName.toLowerCase().split(/[\s"«»()]+/).filter((w) => w.length > 2);
  const titleWords = (title ?? '').toLowerCase().split(/[\s,;/]+/).filter((w) => w.length > 3);

  for (const item of items) {
    const text = `${item.title ?? ''} ${item.snippet ?? ''}`.toLowerCase();
    const nameHit = nameParts.some((part) => text.includes(part))
      || translitParts.some((part) => text.includes(part));
    if (!nameHit) continue;

    const companyHit = companyWords.some((w) => text.includes(w));
    if (companyHit) return true;

    const titleHit = titleWords.some((w) => text.includes(w));
    if (titleHit) return true;
  }
  return false;
}

async function verifyUrlReachable(url: string): Promise<boolean> {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (host.endsWith('linkedin.com')) return true;
  } catch { /* */ }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
      redirect: 'follow',
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

type SocialLinks = Record<string, string>;

const LI_NETWORK: SocialNetwork = {
  key: 'linkedin',
  domain: 'linkedin.com',
  pathPrefix: '/in/',
  buildQuery: () => '',
};

function buildLinkedInQueries(name: string, company: string, title: string | null): string[] {
  const parts = name.split(/\s+/).filter((p) => p.length > 1);
  const latinParts = parts.map(transliterate).join(' ');
  const hasCyrillic = /[а-яё]/i.test(name);
  const queries: string[] = [];

  if (hasCyrillic && latinParts.trim()) {
    queries.push(`site:linkedin.com/in ("${name}" OR "${latinParts}") "${company}"`);
  } else {
    queries.push(`site:linkedin.com/in "${name}" "${company}"`);
  }

  if (hasCyrillic && latinParts.trim()) {
    queries.push(`site:linkedin.com "${latinParts}" "${company}"`);
  }

  queries.push(`site:linkedin.com "${name}"`);

  if (title) {
    const titleShort = title.split(/[,;]/)[0]?.trim() ?? '';
    if (titleShort.length > 3) {
      queries.push(`site:linkedin.com "${name}" "${titleShort}"`);
    }
  }

  return queries;
}

async function findLinkedInProfile(
  personName: string,
  companyName: string,
  title: string | null,
): Promise<string | null> {
  const queries = buildLinkedInQueries(personName, companyName, title);

  for (const query of queries) {
    try {
      const items = await serperSearch(query);
      if (items.length === 0) continue;

      const profileUrl = extractProfileUrl(items, LI_NETWORK);
      if (!profileUrl) continue;

      if (snippetMatchesContext(items, personName, companyName, title)) {
        return profileUrl;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('402') || msg.includes('403') || msg.includes('429')) throw e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function findSocialProfilesViaSerper(
  personName: string,
  companyName: string,
  title: string | null,
): Promise<SocialLinks> {
  const links: SocialLinks = {};

  try {
    const linkedinUrl = await findLinkedInProfile(personName, companyName, title);
    if (linkedinUrl) links.linkedin = linkedinUrl;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('402') || msg.includes('403') || msg.includes('429')) return links;
  }

  for (const network of NON_LINKEDIN_NETWORKS) {
    const query = network.buildQuery(personName, companyName);
    try {
      const items = await serperSearch(query);
      if (items.length === 0) continue;

      if (!snippetMatchesContext(items, personName, companyName)) continue;

      const profileUrl = extractProfileUrl(items, network);
      if (!profileUrl) continue;

      const exists = await verifyUrlReachable(profileUrl);
      if (!exists) continue;

      links[network.key] = profileUrl;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('402') || msg.includes('403') || msg.includes('429')) break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  return links;
}

export async function runSocialProfileSerperEnrichment(
  jobId: string,
  userId: string,
): Promise<{ processed: number; linksFound: number }> {
  if (!supabaseAdmin || !getSerperKey()) return { processed: 0, linksFound: 0 };

  const { data: leadRows } = await supabaseAdmin
    .from('raw_leads')
    .select('company_id')
    .eq('import_job_id', jobId)
    .eq('user_id', userId)
    .not('company_id', 'is', null)
    .limit(10000);

  const companyIds = Array.from(
    new Set((leadRows ?? []).map((r) => String((r as { company_id?: unknown }).company_id ?? '')).filter(Boolean)),
  );
  if (companyIds.length === 0) return { processed: 0, linksFound: 0 };

  const { data: contacts } = await supabaseAdmin
    .from('company_contacts')
    .select('id, company_id, full_name, title, profile_links, source_details')
    .eq('user_id', userId)
    .in('company_id', companyIds)
    .order('score', { ascending: false })
    .limit(SOCIAL_LIMIT * 2);

  if (!contacts?.length) return { processed: 0, linksFound: 0 };

  const withoutProfiles = (contacts as Array<{ id: string; company_id: string; full_name: string; title: string | null; profile_links: Record<string, string> | null; source_details: Record<string, string> | null }>)
    .filter((c) => !c.profile_links || Object.keys(c.profile_links).length === 0)
    .slice(0, SOCIAL_LIMIT);

  if (withoutProfiles.length === 0) return { processed: 0, linksFound: 0 };

  const { data: companies } = await supabaseAdmin
    .from('companies')
    .select('id, name, short_name')
    .in('id', [...new Set(withoutProfiles.map((c) => c.company_id))]);

  const companyMap = new Map(
    (companies ?? []).map((c) => [
      String((c as { id?: unknown }).id),
      (c as { id: string; name: string; short_name: string | null }),
    ]),
  );

  let linksFound = 0;
  let stopped = false;

  for (const contact of withoutProfiles) {
    if (stopped) break;

    const company = companyMap.get(contact.company_id);
    const companyName = company?.short_name || company?.name || '';
    if (!companyName.trim()) continue;

    try {
      const links = await findSocialProfilesViaSerper(contact.full_name, companyName, contact.title);
      if (Object.keys(links).length === 0) continue;

      const existing = (contact.profile_links && typeof contact.profile_links === 'object' ? contact.profile_links : {}) as Record<string, string>;
      const existingDetails = (contact.source_details && typeof contact.source_details === 'object' ? contact.source_details : {}) as Record<string, string>;
      const merged = { ...existing };
      const mergedDetails = { ...existingDetails };
      for (const [k, v] of Object.entries(links)) {
        if (v && !merged[k]) {
          merged[k] = v;
          mergedDetails[k] = 'Google (Serper) + HTTP верификация';
          linksFound++;
        }
      }

      await supabaseAdmin
        .from('company_contacts')
        .update({ profile_links: merged, source_details: mergedDetails })
        .eq('id', contact.id)
        .eq('user_id', userId);

      console.log(`[cis-leads] socialSerper: ${contact.full_name} → ${Object.keys(links).join(', ')}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('402') || msg.includes('403') || msg.includes('429')) {
        console.warn('[cis-leads] socialSerper: blocked/rate-limited, stopping batch');
        stopped = true;
      }
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  return { processed: withoutProfiles.length, linksFound };
}
