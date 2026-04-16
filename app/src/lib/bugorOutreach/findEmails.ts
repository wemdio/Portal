import * as cheerio from 'cheerio';
import * as dns from 'dns';
import { scrapeEmails } from '@/lib/enrich/emailScraper';

const FETCH_TIMEOUT = 12_000;
const CONCURRENCY = 5;
const MAX_EMAILS_PER_LEAD = 3;

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// Hard junk: technical / automated addresses that are NEVER a real contact.
// Keep this minimal — data shows role-based addresses like support@, hr@, billing@
// are real working channels for small Russian B2B companies.
const JUNK_PREFIXES = [
  'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply',
  'mailer-daemon', 'mailer_daemon', 'postmaster', 'hostmaster',
  'unsubscribe', 'subscribe', 'abuse', 'bounce', 'spam',
  'notifications', 'newsletter', 'updates', 'automated', 'system',
  'webmaster', 'daemon', 'root', 'devnull', 'null',
];

// Free / public email providers — acceptable if found on company website
// (many Russian SMBs use yandex/mail.ru as primary corporate contact),
// but ranked lower than own-domain and other-corporate addresses.
const FREE_PROVIDERS = new Set([
  'gmail.com', 'yandex.ru', 'yandex.com', 'ya.ru', 'mail.ru', 'bk.ru',
  'list.ru', 'inbox.ru', 'internet.ru', 'rambler.ru', 'outlook.com',
  'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'protonmail.com',
  'yahoo.com', 'fastmail.com',
]);

const PLACEHOLDER_EMAILS = new Set([
  'your@email.com', 'name@example.com', 'email@domain.com',
  'test@test.com', 'user@example.com', 'example@example.com',
  'email@example.com', 'name@company.com', 'user@company.com',
  'your@domain.com', 'mail@example.com', 'you@example.com',
]);

const PLACEHOLDER_LOCAL_PARTS = new Set([
  'your', 'yourname', 'youremail', 'your-email', 'your_email',
  'name', 'username', 'user', 'test', 'example', 'email',
  'changeme', 'placeholder', 'sample', 'demo',
]);

const JOB_BOARD_DOMAINS = new Set([
  'hh.ru', 'zarplata.ru', 'headhunter.ru', 'superjob.ru', 'rabota.ru',
  'trudvsem.ru', 'avito.ru', 'job.ru', 'rabota.mail.ru', 'career.habr.com',
  'djinni.co', 'linkedin.com', 'indeed.com', 'glassdoor.com', 'monster.com',
  'geekjob.ru', 'careerspace.app', 'finder.vc', 'remote-job.ru',
]);

function isJunkEmail(email: string): boolean {
  const lower = email.toLowerCase();
  if (PLACEHOLDER_EMAILS.has(lower)) return true;

  const [local, domain] = lower.split('@');
  if (!local || !domain) return true;

  if (PLACEHOLDER_LOCAL_PARTS.has(local)) return true;

  if (JOB_BOARD_DOMAINS.has(domain) || [...JOB_BOARD_DOMAINS].some((jb) => domain.endsWith(`.${jb}`))) {
    return true;
  }

  return JUNK_PREFIXES.some((p) => local === p || local.startsWith(`${p}+`) || local.startsWith(`${p}.`));
}

function extractDomain(urlOrDomain: string): string | null {
  try {
    const full = urlOrDomain.startsWith('http') ? urlOrDomain : `https://${urlOrDomain}`;
    return new URL(full).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function emailMatchesDomain(email: string, companyDomain: string | null): boolean {
  if (!companyDomain) return true;
  const emailDomain = email.split('@')[1]?.toLowerCase();
  if (!emailDomain) return false;
  return emailDomain === companyDomain || emailDomain.endsWith(`.${companyDomain}`);
}

/** Role score: personal > sales/business > info/contact > hr/careers > support/help. */
function roleScore(email: string): number {
  const local = email.split('@')[0].toLowerCase();
  if (/^(support|help|care|tech|service)$/i.test(local)) return 1;
  if (/^(hr|recruitment|careers|jobs|vacancy|работа)$/i.test(local)) return 2;
  if (/^(billing|accounting|finance|buh|legal|privacy|compliance|security|order|orders|invoice|invoices)$/i.test(local)) return 2;
  if (/^(info|contact|hello|hi|hey|office|client|clients|mail|email)$/i.test(local)) return 3;
  if (/^(sales|sale|business|partnerships|partner|press|media|zakaz|manager)$/i.test(local)) return 4;
  return 5; // personal-looking name-based emails
}

/** Domain score: own corporate > other corporate > free provider. */
function domainScore(email: string, companyDomain: string | null): number {
  const d = email.split('@')[1]?.toLowerCase() ?? '';
  if (!d) return 0;
  if (companyDomain) {
    if (d === companyDomain || d.endsWith(`.${companyDomain}`)) return 100;
    // Handle sister-brand domains (e.g. 4dev-tech.ru → 4dev.su, tdglobaldent.ru → global-dent.ru)
    const companyRoot = companyDomain.split('.')[0];
    const emailRoot = d.split('.')[0];
    if (companyRoot && emailRoot && (companyRoot.includes(emailRoot) || emailRoot.includes(companyRoot))) {
      return 70;
    }
  }
  if (FREE_PROVIDERS.has(d)) return 40;
  return 50; // unrelated corporate domain — still a real business contact
}

/** Combined rank: prefer own-domain + personal/sales local parts. */
function rankEmail(email: string, companyDomain: string | null): number {
  return domainScore(email, companyDomain) * 10 + roleScore(email);
}

function dedup(emails: string[]): string[] {
  const seen = new Set<string>();
  return emails.filter((e) => {
    const lower = e.toLowerCase();
    if (seen.has(lower)) return false;
    seen.add(lower);
    return true;
  });
}

function filterAndRank(raw: string[], companyDomain: string | null): string[] {
  return dedup(raw)
    .filter((e) => !isJunkEmail(e))
    .sort((a, b) => rankEmail(b, companyDomain) - rankEmail(a, companyDomain))
    .slice(0, MAX_EMAILS_PER_LEAD);
}

// ---------------------------------------------------------------------------
// Tier 1: Scrape company website
// ---------------------------------------------------------------------------

async function tier1_scrapeWebsite(website: string): Promise<string[]> {
  try {
    const result = await scrapeEmails(website, { timeout: FETCH_TIMEOUT, maxPages: 8 });
    // Return everything the scraper found — domain-match ranking happens in filterAndRank.
    // This accepts emails on free providers (info@company → info@yandex.ru) and sister
    // brand domains (company-tech.ru → sales@company.su), which are common for Russian SMBs.
    return result.emails;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tier 2: Parse source article for email mentions
// ---------------------------------------------------------------------------

async function tier2_parseArticle(articleUrl: string): Promise<string[]> {
  try {
    const res = await fetch(articleUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BugorBot/1.0)' },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    $('script, style, nav, header, footer').remove();
    const text = $('body').text();
    const matches = text.match(EMAIL_RE) ?? [];
    return matches.filter((e) => !isJunkEmail(e));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tier 3: Google search fallback
// ---------------------------------------------------------------------------

async function tier3_googleSearch(companyName: string, domain?: string): Promise<string[]> {
  try {
    const query = domain
      ? `"${domain}" email contact`
      : `"${companyName}" email contact`;
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=5`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const matches = html.match(EMAIL_RE) ?? [];
    const domainHost = domain ? new URL(domain.startsWith('http') ? domain : `https://${domain}`).hostname.replace(/^www\./, '') : null;
    return matches.filter((e) => {
      if (isJunkEmail(e)) return false;
      if (e.endsWith('@google.com') || e.endsWith('@gmail.com') || e.endsWith('@gstatic.com')) return false;
      if (domainHost && !e.endsWith(`@${domainHost}`)) return false;
      return true;
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tier 4: Pattern generation + MX validation
// When scraping and Google fail, generate likely email patterns from
// founder_name + company domain. Only returns patterns whose domain has
// valid MX records. Instantly.ai does final deliverability verification.
// ---------------------------------------------------------------------------

const dnsResolver = new dns.promises.Resolver();
dnsResolver.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);

function normalizeName(raw: string): { first: string; last: string } | null {
  const clean = raw
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-zA-Z\s-]/g, '')
    .trim()
    .toLowerCase();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts[0].replace(/-/g, ''), last: parts[parts.length - 1].replace(/-/g, '') };
}

function generateTopPattern(first: string, last: string, domain: string): string {
  return `${first}.${last}@${domain}`;
}

async function hasMxRecords(domain: string): Promise<boolean> {
  try {
    const records = await dnsResolver.resolveMx(domain);
    return !!(records && records.length > 0);
  } catch {
    return false;
  }
}

async function tier4_patternGuess(
  founderName: string,
  domain: string,
): Promise<string[]> {
  const name = normalizeName(founderName);
  if (!name) return [];

  const hasMx = await hasMxRecords(domain);
  if (!hasMx) return [];

  const email = generateTopPattern(name.first, name.last, domain);
  console.log(`[bugor-findEmails] Tier4: Pattern guess for ${domain} (${founderName}): ${email}`);
  return [email];
}

// ---------------------------------------------------------------------------
// Main: find emails for a batch of leads
// ---------------------------------------------------------------------------

export interface FindEmailsInput {
  id: string;
  company_name: string;
  website: string | null;
  founder_name: string | null;
  source_url: string | null;
}

export interface FindEmailsResult {
  id: string;
  emails: string[];
  tier: number;
}

function isJobBoardUrl(url: string): boolean {
  try {
    const hostname = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
    return JOB_BOARD_DOMAINS.has(hostname) || [...JOB_BOARD_DOMAINS].some((jb) => hostname.endsWith(`.${jb}`));
  } catch {
    return false;
  }
}

async function findForOne(lead: FindEmailsInput): Promise<FindEmailsResult> {
  const companyDomain = lead.website ? extractDomain(lead.website) : null;

  // Tier 1: company website — accept anything found, rank by domain proximity.
  // This catches cases like info@yandex.ru on a Russian SMB site, or sister-brand
  // addresses like sale@4dev.su on the 4dev-tech.ru website.
  if (lead.website) {
    const emails = await tier1_scrapeWebsite(lead.website);
    const ranked = filterAndRank(emails, companyDomain);
    if (ranked.length > 0) return { id: lead.id, emails: ranked, tier: 1 };
  }

  // Tier 2: source article — skip job board pages (they contain job board emails, not company emails)
  if (lead.source_url && !isJobBoardUrl(lead.source_url)) {
    const emails = await tier2_parseArticle(lead.source_url);
    // Prefer same-domain matches when available, otherwise fall back to all article emails.
    const onDomain = companyDomain ? emails.filter((e) => emailMatchesDomain(e, companyDomain)) : emails;
    const ranked = filterAndRank(onDomain.length > 0 ? onDomain : emails, companyDomain);
    if (ranked.length > 0) return { id: lead.id, emails: ranked, tier: 2 };
  }

  // Tier 3: Google search — already domain-filtered inside
  const emails = await tier3_googleSearch(lead.company_name, companyDomain ?? undefined);
  const ranked = filterAndRank(emails, companyDomain);
  if (ranked.length > 0) return { id: lead.id, emails: ranked, tier: 3 };

  // Tier 4: Pattern guess from founder name + MX-validated domain
  if (lead.founder_name && companyDomain) {
    const guessed = await tier4_patternGuess(lead.founder_name, companyDomain);
    if (guessed.length > 0) {
      return { id: lead.id, emails: guessed.slice(0, MAX_EMAILS_PER_LEAD), tier: 4 };
    }
  }

  return { id: lead.id, emails: [], tier: 0 };
}

export async function findEmailsForLeads(leads: FindEmailsInput[]): Promise<FindEmailsResult[]> {
  const results: FindEmailsResult[] = [];
  const tierCounts = { 1: 0, 2: 0, 3: 0, 4: 0, miss: 0 };

  for (let i = 0; i < leads.length; i += CONCURRENCY) {
    const batch = leads.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(batch.map(findForOne));

    for (const r of batchResults) {
      if (r.status === 'fulfilled') {
        results.push(r.value);
        if (r.value.tier === 0) tierCounts.miss++;
        else tierCounts[r.value.tier as 1 | 2 | 3 | 4]++;
      }
    }
  }

  console.log(
    `[bugor-findEmails] Results: Tier1=${tierCounts[1]}, Tier2=${tierCounts[2]}, Tier3=${tierCounts[3]}, Tier4(pattern)=${tierCounts[4]}, NoEmail=${tierCounts.miss}`,
  );
  return results;
}
