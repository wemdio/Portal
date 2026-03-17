import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { serperSearchDetailed } from '@/lib/parsers/serperSearch';

const SOCIAL_LIMIT = 15; // max contacts to enrich per job
const QUERY_DELAY_MS = 500;

/** Domain patterns -> profile_links key */
const DOMAIN_TO_KEY: Array<{ pattern: RegExp; key: string }> = [
  { pattern: /linkedin\.com/i, key: 'linkedin' },
  { pattern: /vk\.com/i, key: 'vk' },
  { pattern: /t\.me\/|telegram\.(me|dog)/i, key: 'telegram' },
  { pattern: /facebook\.com|fb\.com/i, key: 'facebook' },
  { pattern: /twitter\.com|x\.com/i, key: 'twitter' },
  { pattern: /ok\.ru/i, key: 'ok' },
  { pattern: /habr\.com/i, key: 'habr' },
  { pattern: /instagram\.com/i, key: 'instagram' },
];

function hasSerperKey(): boolean {
  return (process.env.SERPER_API_KEY ?? '').trim().length > 0;
}

function normalizeProfileUrl(url: string, key: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    let href = u.href;
    if (key === 'telegram' && href.includes('t.me/')) {
      const m = href.match(/t\.me\/([a-zA-Z0-9_]+)/);
      if (m) href = `https://t.me/${m[1]}`;
    }
    return href;
  } catch {
    return url;
  }
}

function extractProfileLinks(results: Array<{ link: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const r of results) {
    const link = (r.link ?? '').trim();
    if (!link) continue;
    for (const { pattern, key } of DOMAIN_TO_KEY) {
      if (out[key]) continue;
      if (!pattern.test(link)) continue;
      const normalized = normalizeProfileUrl(link, key);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out[key] = normalized;
      break;
    }
  }
  return out;
}

/**
 * For each contact (prioritize those without email/phone), search Serper for "ФИО" "Company"
 * and collect social profile URLs from results; update company_contacts.profile_links.
 */
export async function runSocialProfileEnrichment(
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
    .select('id, company_id, full_name')
    .eq('user_id', userId)
    .in('company_id', companyIds)
    .order('score', { ascending: false })
    .limit(SOCIAL_LIMIT * 2);

  if (!contacts?.length) return { processed: 0, linksFound: 0 };

  const { data: companies } = await supabaseAdmin
    .from('companies')
    .select('id, name, short_name')
    .in('id', [...new Set((contacts as Array<{ company_id: string }>).map((c) => c.company_id))]);

  const companyMap = new Map(
    (companies ?? []).map((c) => [
      String((c as { id?: unknown }).id),
      (c as { id: string; name: string; short_name: string | null }),
    ]),
  );

  const toProcess = (contacts as Array<{ id: string; company_id: string; full_name: string }>).slice(0, SOCIAL_LIMIT);
  let linksFound = 0;

  for (const contact of toProcess) {
    const company = companyMap.get(contact.company_id);
    const companyName = company?.short_name || company?.name || '';
    if (!companyName.trim()) continue;

    const query = `"${contact.full_name.replace(/"/g, ' ')}" "${companyName.replace(/"/g, ' ')}"`;
    try {
      const { results } = await serperSearchDetailed(query, { num: 15, gl: 'ru', hl: 'ru' });
      const links = extractProfileLinks(results.map((r) => ({ link: r.link ?? '' })));
      if (Object.keys(links).length === 0) {
        await new Promise((r) => setTimeout(r, QUERY_DELAY_MS));
        continue;
      }

      const { data: row } = await supabaseAdmin
        .from('company_contacts')
        .select('profile_links')
        .eq('id', contact.id)
        .eq('user_id', userId)
        .single<{ profile_links: Record<string, string> | null }>();

      const existing = (row?.profile_links && typeof row.profile_links === 'object' ? row.profile_links : {}) as Record<string, string>;
      const merged = { ...existing };
      for (const [k, v] of Object.entries(links)) {
        if (v && !merged[k]) {
          merged[k] = v;
          linksFound++;
        }
      }

      await supabaseAdmin
        .from('company_contacts')
        .update({ profile_links: merged })
        .eq('id', contact.id)
        .eq('user_id', userId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Not enough credits') || msg.includes('401') || msg.includes('403')) {
        console.warn('[cis-leads] socialProfileEnrichment: API credits exhausted');
        break;
      }
    }

    await new Promise((r) => setTimeout(r, QUERY_DELAY_MS));
  }

  return { processed: toProcess.length, linksFound };
}
