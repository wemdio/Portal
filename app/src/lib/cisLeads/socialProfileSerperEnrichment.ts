import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { serperSearchDetailed, type SerperOrganicItem } from '@/lib/parsers/serperSearch';

const SOCIAL_LIMIT = 40;
const VERIFY_TIMEOUT_MS = 6_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function hasSerperKey(): boolean {
  return Boolean((process.env.SERPER_API_KEY ?? '').trim());
}

interface SocialNetwork {
  key: string;
  domain: string;
  pathPrefix: string;
  buildQuery: (name: string, company: string) => string;
}

const NETWORKS: SocialNetwork[] = [
  {
    key: 'linkedin',
    domain: 'linkedin.com',
    pathPrefix: '/in/',
    buildQuery: (name, company) => `site:linkedin.com/in "${name}" "${company}"`,
  },
  {
    key: 'vk',
    domain: 'vk.com',
    pathPrefix: '/',
    buildQuery: (name, company) => `site:vk.com "${name}" "${company}"`,
  },
  {
    key: 'facebook',
    domain: 'facebook.com',
    pathPrefix: '/',
    buildQuery: (name, company) => `site:facebook.com "${name}" "${company}"`,
  },
];

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

function snippetMatchesContext(
  items: SerperOrganicItem[],
  personName: string,
  companyName: string,
): boolean {
  const nameParts = personName.toLowerCase().split(/\s+/).filter((p) => p.length > 2);
  const companyLower = companyName.toLowerCase();

  for (const item of items) {
    const text = `${item.title ?? ''} ${item.snippet ?? ''}`.toLowerCase();
    const nameHit = nameParts.some((part) => text.includes(part));
    const companyHit = text.includes(companyLower) || companyLower.split(/\s+/).some((w) => w.length > 3 && text.includes(w));
    if (nameHit && companyHit) return true;
  }
  return false;
}

async function verifyUrlExists(url: string): Promise<boolean> {
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

async function findSocialProfilesViaSerper(
  personName: string,
  companyName: string,
): Promise<SocialLinks> {
  const links: SocialLinks = {};

  for (const network of NETWORKS) {
    const query = network.buildQuery(personName, companyName);
    try {
      const { results } = await serperSearchDetailed(query, { num: 10, gl: 'ru', hl: 'ru' });
      const items = results as unknown as SerperOrganicItem[];
      if (items.length === 0) continue;

      if (!snippetMatchesContext(items, personName, companyName)) continue;

      const profileUrl = extractProfileUrl(items, network);
      if (!profileUrl) continue;

      const exists = await verifyUrlExists(profileUrl);
      if (!exists) {
        console.log(`[cis-leads] socialSerper: ${network.key} URL 404 for ${personName}: ${profileUrl}`);
        continue;
      }

      links[network.key] = profileUrl;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('SERPER_API_KEY')) break;
      if (msg.includes('402') || msg.includes('403') || msg.includes('429')) {
        console.warn(`[cis-leads] socialSerper: rate-limited on ${network.key}, stopping`);
        break;
      }
      console.error(`[cis-leads] socialSerper: ${network.key} search failed for ${personName}:`, msg);
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  return links;
}

export async function runSocialProfileSerperEnrichment(
  jobId: string,
  userId: string,
): Promise<{ processed: number; linksFound: number }> {
  if (!supabaseAdmin || !hasSerperKey()) return { processed: 0, linksFound: 0 };

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
    .select('id, company_id, full_name, profile_links, source_details')
    .eq('user_id', userId)
    .in('company_id', companyIds)
    .order('score', { ascending: false })
    .limit(SOCIAL_LIMIT * 2);

  if (!contacts?.length) return { processed: 0, linksFound: 0 };

  const withoutProfiles = (contacts as Array<{ id: string; company_id: string; full_name: string; profile_links: Record<string, string> | null; source_details: Record<string, string> | null }>)
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
      const links = await findSocialProfilesViaSerper(contact.full_name, companyName);
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
      if (msg.includes('SERPER_API_KEY') || msg.includes('402') || msg.includes('403') || msg.includes('429')) {
        console.warn('[cis-leads] socialSerper: blocked/rate-limited, stopping batch');
        stopped = true;
      }
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  return { processed: withoutProfiles.length, linksFound };
}
