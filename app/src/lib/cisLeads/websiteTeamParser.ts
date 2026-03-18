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

interface SiteContacts {
  phones: string[];
  emails: string[];
  whatsapp: string[];
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/;
const WA_LINK_RE = /(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?\+?(\d{10,15})/gi;

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

function extractSiteContacts(html: string): SiteContacts {
  const $ = cheerio.load(html);
  const phones = new Set<string>();
  const emails = new Set<string>();
  const whatsapp = new Set<string>();

  $('a[href^="tel:"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const digits = href.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) phones.add(digits);
  });

  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const email = href.replace(/^mailto:/i, '').split('?')[0]?.trim().toLowerCase();
    if (email && EMAIL_RE.test(email)) emails.add(email);
  });

  $('a[href*="wa.me"], a[href*="whatsapp.com"]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const m = href.match(/(\d{10,15})/);
    if (m) whatsapp.add(m[1]!);
  });

  const bodyText = $('body').text();
  let waMatch: RegExpExecArray | null;
  while ((waMatch = WA_LINK_RE.exec(bodyText)) !== null) {
    whatsapp.add(waMatch[1]!);
  }

  const metaDesc = $('meta[name="description"]').attr('content') ?? '';
  const emailFromMeta = metaDesc.match(EMAIL_RE);
  if (emailFromMeta) emails.add(emailFromMeta[0]!.toLowerCase());
  const phoneFromMeta = metaDesc.match(PHONE_RE);
  if (phoneFromMeta) phones.add(phoneFromMeta[0]!.replace(/[\s()-]/g, ''));

  return {
    phones: [...phones],
    emails: [...emails],
    whatsapp: [...whatsapp],
  };
}

async function parseTeamPages(siteUrl: string): Promise<{ people: ParsedPerson[]; siteContacts: SiteContacts }> {
  let origin: string;
  try {
    origin = new URL(siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`).origin;
  } catch {
    return { people: [], siteContacts: { phones: [], emails: [], whatsapp: [] } };
  }

  const allPeople: ParsedPerson[] = [];
  const seenNames = new Set<string>();
  const mergedContacts: SiteContacts = { phones: [], emails: [], whatsapp: [] };
  const seenPhones = new Set<string>();
  const seenEmails = new Set<string>();
  const seenWa = new Set<string>();

  for (const path of TEAM_PATHS) {
    if (allPeople.length >= 10) break;
    const url = `${origin}${path}`;
    const html = await fetchHtml(url);
    if (!html) continue;

    const sc = extractSiteContacts(html);
    for (const ph of sc.phones) { if (!seenPhones.has(ph)) { seenPhones.add(ph); mergedContacts.phones.push(ph); } }
    for (const em of sc.emails) { if (!seenEmails.has(em)) { seenEmails.add(em); mergedContacts.emails.push(em); } }
    for (const wa of sc.whatsapp) { if (!seenWa.has(wa)) { seenWa.add(wa); mergedContacts.whatsapp.push(wa); } }

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

  return { people: allPeople, siteContacts: mergedContacts };
}

/** Normalized key for matching site person to existing company_contact (same logic as API dedupe). */
function contactNameKey(fullName: string): string {
  const raw = String(fullName ?? '').trim().toLowerCase();
  if (!raw || !hasFioStructure(fullName)) return '';
  const parts = raw.split(/\s+/).filter(Boolean);
  const withoutPatronymic = parts.filter((p) => {
    const s = p.replace(/[.,]/g, '');
    return !(
      s.endsWith('вич') || s.endsWith('вна') || s.endsWith('ична') || s.endsWith('оглы') || s.endsWith('кызы')
    );
  });
  const normalized = (withoutPatronymic.length ? withoutPatronymic : parts).slice(0, 3).sort().join(' ');
  return normalized;
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
      const { people, siteContacts } = await parseTeamPages(company.site);

      if (siteContacts.phones.length > 0 || siteContacts.emails.length > 0) {
        const companyUpdate: Record<string, string> = {};
        if (siteContacts.phones[0]) companyUpdate.phone = siteContacts.phones[0];
        if (siteContacts.emails[0]) companyUpdate.email = siteContacts.emails[0];
        if (Object.keys(companyUpdate).length > 0) {
          await supabaseAdmin
            .from('companies')
            .update(companyUpdate)
            .eq('id', company.id)
            .is('phone', null);
        }
      }

      const { data: existingContacts } = await supabaseAdmin
        .from('company_contacts')
        .select('id, full_name, channel_phone, channel_email')
        .eq('user_id', userId)
        .eq('company_id', company.id);

      const keyToContact = new Map<string, { id: string; full_name: string; channel_phone: string | null; channel_email: string | null }>();
      for (const c of (existingContacts ?? []) as Array<{ id: string; full_name: string; channel_phone: string | null; channel_email: string | null }>) {
        const key = contactNameKey(c.full_name);
        if (key && !keyToContact.has(key)) keyToContact.set(key, c);
      }

      for (const person of people.slice(0, 5)) {
        const key = contactNameKey(person.name);
        const existing = key ? keyToContact.get(key) : undefined;

        if (existing && (person.phone || person.email)) {
          const update: Record<string, string | null> = {};
          if (person.phone && !existing.channel_phone) update.channel_phone = person.phone;
          if (person.email && !existing.channel_email) update.channel_email = person.email;
          if (Object.keys(update).length > 0) {
            const { error } = await supabaseAdmin
              .from('company_contacts')
              .update(update)
              .eq('id', existing.id)
              .eq('user_id', userId);
            if (!error) contactsFound++;
          }
          continue;
        }

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
