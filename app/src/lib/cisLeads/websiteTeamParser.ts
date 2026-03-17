import 'server-only';

import * as cheerio from 'cheerio';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { guessLprRoleFromPost } from '@/lib/cisLeads/lprRole';
import { hasFioStructure } from '@/lib/cisLeads/fioStructure';

const FETCH_TIMEOUT_MS = 8_000;
const SITE_BATCH_LIMIT = 30;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const TEAM_PATHS = [
  '/team', '/команда', '/management', '/руководство',
  '/about', '/о-нас', '/о-компании', '/company',
  '/about-us', '/about-company', '/o-kompanii', '/o-nas',
  '/contacts', '/контакты', '/kontakty',
];

interface ParsedPerson {
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/;

async function fetchHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('text/html') && !ct.includes('xhtml')) return null;
    const text = await res.text();
    return text.length > 200 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractPeopleFromJsonLd(html: string): ParsedPerson[] {
  const $ = cheerio.load(html);
  const people: ParsedPerson[] = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).text()) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const node = item as Record<string, unknown>;
        const type = String(node['@type'] ?? '');
        if (!/(Person|Employee)/i.test(type)) continue;
        const name = String(node['name'] ?? '').trim();
        if (!name || !hasFioStructure(name)) continue;
        people.push({
          name,
          title: String(node['jobTitle'] ?? node['role'] ?? '').trim() || null,
          email: typeof node['email'] === 'string' ? node['email'].trim() : null,
          phone: typeof node['telephone'] === 'string' ? node['telephone'].trim() : null,
        });
      }
    } catch { /* ignore */ }
  });

  return people;
}

function extractPeopleFromHtml(html: string): ParsedPerson[] {
  const $ = cheerio.load(html);
  const people: ParsedPerson[] = [];
  const seen = new Set<string>();

  const teamSelectors = [
    '[class*="team"] [class*="member"], [class*="team"] [class*="person"], [class*="team"] [class*="card"]',
    '[class*="staff"] [class*="member"], [class*="staff"] [class*="person"]',
    '[class*="management"] [class*="item"], [class*="руковод"] [class*="item"]',
    '[class*="person"], [class*="employee"]',
  ];

  for (const selector of teamSelectors) {
    $(selector).each((_, el) => {
      const block = $(el);
      const text = block.text().replace(/\s+/g, ' ').trim();
      if (text.length < 5 || text.length > 500) return;

      const nameMatch = text.match(/([А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)?)/);
      if (!nameMatch) return;
      const name = nameMatch[1]!.trim();
      if (!hasFioStructure(name)) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);

      const rest = text.replace(name, '').trim();
      const emailMatch = rest.match(EMAIL_RE);
      const phoneMatch = rest.match(PHONE_RE);

      let title: string | null = null;
      const titleCandidates = rest
        .replace(EMAIL_RE, '')
        .replace(PHONE_RE, '')
        .replace(/[,;|•·—–-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (titleCandidates.length > 2 && titleCandidates.length < 120) {
        title = titleCandidates;
      }

      people.push({
        name,
        title,
        email: emailMatch?.[0]?.toLowerCase() ?? null,
        phone: phoneMatch?.[0]?.replace(/[\s()-]/g, '') ?? null,
      });
    });

    if (people.length > 0) break;
  }

  return people;
}

async function parseTeamPages(siteUrl: string): Promise<ParsedPerson[]> {
  let origin: string;
  try {
    origin = new URL(siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`).origin;
  } catch {
    return [];
  }

  const allPeople: ParsedPerson[] = [];
  const seenNames = new Set<string>();

  for (const path of TEAM_PATHS) {
    if (allPeople.length >= 10) break;
    const url = `${origin}${path}`;
    const html = await fetchHtml(url);
    if (!html) continue;

    const fromJsonLd = extractPeopleFromJsonLd(html);
    const fromHtml = extractPeopleFromHtml(html);
    const combined = [...fromJsonLd, ...fromHtml];

    for (const p of combined) {
      const key = p.name.toLowerCase();
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      allPeople.push(p);
    }

    if (allPeople.length > 0) break;
  }

  return allPeople;
}

export async function runWebsiteTeamEnrichment(jobId: string, userId: string): Promise<{ processed: number; contactsFound: number }> {
  if (!supabaseAdmin) return { processed: 0, contactsFound: 0 };

  const { data: leads } = await supabaseAdmin
    .from('raw_leads')
    .select('company_id')
    .eq('import_job_id', jobId)
    .eq('user_id', userId)
    .not('company_id', 'is', null)
    .limit(10000);

  const companyIds = Array.from(new Set((leads ?? []).map((r) => String((r as { company_id?: unknown }).company_id ?? '')).filter(Boolean)));
  if (companyIds.length === 0) return { processed: 0, contactsFound: 0 };

  const { data: companiesWithSite } = await supabaseAdmin
    .from('companies')
    .select('id, name, site')
    .in('id', companyIds)
    .not('site', 'is', null)
    .limit(SITE_BATCH_LIMIT);

  const toProcess = (companiesWithSite ?? []) as Array<{ id: string; name: string; site: string | null }>;
  if (toProcess.length === 0) return { processed: 0, contactsFound: 0 };

  let processed = 0;
  let contactsFound = 0;

  for (const company of toProcess) {
    if (!company.site) continue;

    try {
      const people = await parseTeamPages(company.site);

      for (const person of people.slice(0, 5)) {
        const role = guessLprRoleFromPost(person.title);
        const { error } = await supabaseAdmin
          .from('company_contacts')
          .upsert(
            {
              user_id: userId,
              company_id: company.id,
              source: 'website_team',
              full_name: person.name,
              first_name: null,
              last_name: null,
              title: person.title,
              role_guess: role,
              channel_phone: person.phone,
              channel_tg_username: null,
              channel_email: person.email,
              source_url: company.site,
              score: 50,
              confidence: 0.45,
            },
            { onConflict: 'user_id,company_id,full_name' },
          );
        if (!error) contactsFound++;
      }

      processed++;
    } catch (e) {
      console.error(`[cis-leads] websiteTeamEnrichment failed for ${company.site}:`, e instanceof Error ? e.message : e);
    }
  }

  return { processed, contactsFound };
}
