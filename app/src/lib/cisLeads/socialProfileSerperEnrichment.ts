import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { findLinkedInByNameAndCompany, hasLinkFinderKey } from '@/lib/cisLeads/linkFinderClient';
import {
  extractCompanyAliases as extractAliasesFromLayer,
  normalizeCompanyNameForSearch as normalizeCompanyFromLayer,
  transliterate as transliterateFromLayer,
} from '@/lib/cisLeads/identityNormalize';
import { resolveChannelCandidate } from '@/lib/cisLeads/channelResolver';
import { getCompanyIdsForJob, chunkArray, IN_CHUNK_SIZE } from '@/lib/cisLeads/batchedQuery';

const SOCIAL_LIMIT = 40;
const VERIFY_TIMEOUT_MS = 6_000;
const SERPER_API_URL = 'https://google.serper.dev/search';
const _LINKEDIN_AUTO_ACCEPT_SCORE = 70;
const LINKEDIN_REVIEW_SCORE = 50;
const LINKEDIN_MAX_ITEMS_PER_QUERY = 5;
const LINKEDIN_MAX_QUERIES = 8;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LINKEDIN_CACHE = new Map<string, LinkedInResult | null>();

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

export function normalizeCompanyNameForSearch(companyName: string): string {
  return normalizeCompanyFromLayer(companyName);
}

export function extractCompanyAliases(companyName: string): string[] {
  return extractAliasesFromLayer(companyName);
}

const _TRANSLIT_MAP: Record<string, string> = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e',
  'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm',
  'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
  'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch',
  'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
};

function transliterate(text: string): string {
  return transliterateFromLayer(text);
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

export function computeLinkedInCandidateScore(
  item: SerperOrganicItem,
  personName: string,
  companyAliases: string[],
  title?: string | null,
): number {
  const link = String(item.link ?? '').trim().toLowerCase();
  const text = `${item.title ?? ''} ${item.snippet ?? ''}`.toLowerCase();
  const nameParts = personName.toLowerCase().split(/\s+/).filter((p) => p.length > 2);
  const translitParts = nameParts.map(transliterate).filter((p) => p.length > 2);
  const companyWords = companyAliases
    .flatMap((c) => c.toLowerCase().split(/[\s"«»()]+/))
    .filter((w) => w.length > 2);
  const titleWords = (title ?? '').toLowerCase().split(/[\s,;/]+/).filter((w) => w.length > 3);

  let score = 0;
  if (link.includes('/in/')) score += 10;
  if (nameParts.some((p) => text.includes(p)) || translitParts.some((p) => text.includes(p))) score += 40;
  if (companyWords.some((w) => text.includes(w))) score += 30;
  if (titleWords.some((w) => text.includes(w))) score += 15;
  if (link.includes('/company/') || link.includes('/jobs/') || link.includes('/posts/')) score -= 20;
  if (link.includes('/pub/')) score -= 10;
  return Math.max(0, Math.min(100, score));
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

export function buildLinkedInQueries(name: string, company: string, title: string | null): string[] {
  const parts = name.split(/\s+/).filter((p) => p.length > 1);
  const latinParts = parts.map(transliterate).join(' ');
  const hasCyrillic = /[а-яё]/i.test(name);
  const companyAliases = extractCompanyAliases(company);
  const primaryCompany = companyAliases[1] || companyAliases[0] || company;
  const shortName = parts.length > 1 ? `${parts[0]} ${parts[1]}` : name;
  const queries: string[] = [];

  if (hasCyrillic && latinParts.trim()) {
    queries.push(`site:linkedin.com/in ("${name}" OR "${latinParts}") "${primaryCompany}"`);
  } else {
    queries.push(`site:linkedin.com/in "${name}" "${primaryCompany}"`);
  }

  for (const alias of companyAliases.slice(0, 3)) {
    queries.push(`site:linkedin.com/in "${name}" "${alias}"`);
    queries.push(`site:linkedin.com/in "${shortName}" "${alias}"`);
  }

  if (hasCyrillic && latinParts.trim()) queries.push(`site:linkedin.com "${latinParts}" "${primaryCompany}"`);
  queries.push(`site:linkedin.com "${name}"`);
  if (title) {
    const titleShort = title.split(/[,;]/)[0]?.trim() ?? '';
    if (titleShort.length > 3) {
      queries.push(`site:linkedin.com "${name}" "${titleShort}"`);
    }
  }

  return Array.from(new Set(queries)).slice(0, LINKEDIN_MAX_QUERIES);
}

type LinkedInCandidate = { url: string; score: number; query?: string; title?: string; snippet?: string };
type LinkedInResult = { url: string; source: 'linkfinder' | 'serper'; score: number; candidates: LinkedInCandidate[] };

async function findLinkedInProfile(
  personName: string,
  companyName: string,
  title: string | null,
): Promise<LinkedInResult | null> {
  const cacheKey = `${personName.toLowerCase().trim()}|${normalizeCompanyNameForSearch(companyName).toLowerCase()}`;
  if (LINKEDIN_CACHE.has(cacheKey)) return LINKEDIN_CACHE.get(cacheKey) ?? null;

  if (hasLinkFinderKey()) {
    try {
      const url = await findLinkedInByNameAndCompany(personName, companyName);
      if (url) {
        const out = {
          url,
          source: 'linkfinder' as const,
          score: 95,
          candidates: [{ url, score: 95 }],
        };
        LINKEDIN_CACHE.set(cacheKey, out);
        return out;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('402') || msg.includes('403') || msg.includes('429')) throw e;
    }
  }

  const companyAliases = extractCompanyAliases(companyName);
  let best: LinkedInResult | null = null;
  const candidateMap = new Map<string, LinkedInCandidate>();
  const queries = buildLinkedInQueries(personName, companyName, title);

  for (const query of queries) {
    try {
      const items = await serperSearch(query);
      if (items.length === 0) continue;
      const topItems = items.slice(0, LINKEDIN_MAX_ITEMS_PER_QUERY);
      for (const item of topItems) {
        const profileUrl = extractProfileUrl([item], LI_NETWORK);
        if (!profileUrl) continue;
        const score = computeLinkedInCandidateScore(item, personName, companyAliases, title);
        const prev = candidateMap.get(profileUrl);
        if (!prev || score > prev.score) {
          candidateMap.set(profileUrl, {
            url: profileUrl,
            score,
            query,
            title: item.title,
            snippet: item.snippet,
          });
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('402') || msg.includes('403') || msg.includes('429')) throw e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const ranked = Array.from(candidateMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  if (ranked.length > 0) {
    const top = ranked[0]!;
    best = { url: top.url, source: 'serper', score: top.score, candidates: ranked };
  }
  LINKEDIN_CACHE.set(cacheKey, best);
  return best;
}

async function findSocialProfilesViaSerper(
  personName: string,
  companyName: string,
  title: string | null,
): Promise<{ links: SocialLinks; linkedinSource?: string }> {
  const links: SocialLinks = {};
  let linkedinSource: string | undefined;

  try {
    const result = await findLinkedInProfile(personName, companyName, title);
    if (result && result.score >= LINKEDIN_REVIEW_SCORE) {
      links.linkedin = result.url;
      linkedinSource = result.source === 'linkfinder' ? 'LinkFinder AI' : 'Google (Serper) + HTTP верификация';
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('402') || msg.includes('403') || msg.includes('429')) return { links };
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

  return { links, linkedinSource };
}

export async function runSocialProfileSerperEnrichment(
  jobId: string,
  userId: string,
): Promise<{ processed: number; linksFound: number }> {
  if (!supabaseAdmin || (!getSerperKey() && !hasLinkFinderKey())) return { processed: 0, linksFound: 0 };

  const companyIds = await getCompanyIdsForJob(supabaseAdmin, jobId, userId);
  if (companyIds.length === 0) return { processed: 0, linksFound: 0 };

  const contacts: Array<Record<string, unknown>> = [];
  for (const chunk of chunkArray(companyIds, IN_CHUNK_SIZE)) {
    if (contacts.length >= SOCIAL_LIMIT * 2) break;
    const { data } = await supabaseAdmin
      .from('company_contacts')
      .select('id, company_id, full_name, title, profile_links, source_details, channel_tg_username, channel_tg_user_id, wa_registered')
      .eq('user_id', userId)
      .in('company_id', chunk)
      .order('score', { ascending: false })
      .limit(SOCIAL_LIMIT * 2 - contacts.length);
    if (data) contacts.push(...data);
  }

  if (!contacts?.length) return { processed: 0, linksFound: 0 };

  const withoutProfiles = (contacts as Array<{
    id: string;
    company_id: string;
    full_name: string;
    title: string | null;
    profile_links: Record<string, string> | null;
    source_details: Record<string, string> | null;
    channel_tg_username: string | null;
    channel_tg_user_id: number | null;
    wa_registered: boolean | null;
  }>)
    .filter((c) => !c.profile_links || Object.keys(c.profile_links).length === 0)
    .slice(0, SOCIAL_LIMIT);

  if (withoutProfiles.length === 0) return { processed: 0, linksFound: 0 };

  const profileCompanyIds = [...new Set(withoutProfiles.map((c) => c.company_id))];
  const companiesForProfiles: Array<{ id: string; name: string; short_name: string | null }> = [];
  for (const chunk of chunkArray(profileCompanyIds, IN_CHUNK_SIZE)) {
    const { data } = await supabaseAdmin
      .from('companies')
      .select('id, name, short_name')
      .in('id', chunk);
    if (data) companiesForProfiles.push(...(data as typeof companiesForProfiles));
  }

  const companyMap = new Map(
    companiesForProfiles.map((c) => [c.id, c]),
  );

  let linksFound = 0;
  let stopped = false;

  for (const contact of withoutProfiles) {
    if (stopped) break;

    const company = companyMap.get(contact.company_id);
    const companyName = company?.short_name || company?.name || '';
    if (!companyName.trim()) continue;

    try {
      const { links, linkedinSource } = await findSocialProfilesViaSerper(contact.full_name, companyName, contact.title);
      if (Object.keys(links).length === 0) continue;

      const existing = (contact.profile_links && typeof contact.profile_links === 'object' ? contact.profile_links : {}) as Record<string, string>;
      const existingDetails = (contact.source_details && typeof contact.source_details === 'object' ? contact.source_details : {}) as Record<string, string>;
      const merged = { ...existing };
      const mergedDetails = { ...existingDetails };
      for (const [k, v] of Object.entries(links)) {
        if (v && !merged[k]) {
          if (k === 'linkedin') {
            const result = await findLinkedInProfile(contact.full_name, companyName, contact.title);
            if (!result || result.score < LINKEDIN_REVIEW_SCORE) continue;
            const resolved = resolveChannelCandidate({
              channel: 'linkedin',
              score: result.score,
              hasTelegram: Boolean(contact.channel_tg_username),
              hasTelegramId: Boolean(contact.channel_tg_user_id),
              waRegistered: Boolean(contact.wa_registered),
              title: contact.title,
              evidence: {
                query_name: contact.full_name,
                query_company: companyName,
                candidate_url: result.url,
                provider: result.source,
                base_score: String(result.score),
              },
            });

            if (resolved.decision === 'review') {
              mergedDetails.linkedin_candidate_url = result.url;
              mergedDetails.linkedin_candidate_score = String(resolved.score);
              mergedDetails.linkedin_review_needed = '1';
              mergedDetails.linkedin_review_reason = resolved.reason;
              mergedDetails.linkedin_candidates_json = JSON.stringify(result.candidates ?? []);
              continue;
            }
            if (resolved.decision === 'reject') continue;
            mergedDetails.linkedin_score = String(resolved.score);
          }
          merged[k] = v;
          mergedDetails[k] = k === 'linkedin' && linkedinSource ? linkedinSource : 'Google (Serper) + HTTP верификация';
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
