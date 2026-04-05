import * as cheerio from 'cheerio';
import * as dns from 'dns';
import { scrapeEmails } from '@/lib/enrich/emailScraper';

const FETCH_TIMEOUT = 12_000;
const CONCURRENCY = 5;
const MAX_EMAILS_PER_LEAD = 3;

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

const JUNK_PREFIXES = [
  'noreply', 'no-reply', 'no_reply', 'donotreply', 'mailer-daemon',
  'unsubscribe', 'support', 'help', 'abuse', 'postmaster', 'webmaster',
  'privacy', 'legal', 'compliance', 'newsletter', 'notifications',
  'updates', 'feedback', 'automated', 'system', 'admin',
  'billing', 'security', 'accounting', 'hr', 'recruitment', 'careers',
  'jobs', 'spam', 'bounce', 'returns', 'orders', 'invoices', 'receipts',
];

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

function isJunkEmail(email: string): boolean {
  const lower = email.toLowerCase();
  if (PLACEHOLDER_EMAILS.has(lower)) return true;

  const local = lower.split('@')[0];
  if (PLACEHOLDER_LOCAL_PARTS.has(local)) return true;

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

function rankEmail(email: string): number {
  const local = email.split('@')[0].toLowerCase();
  if (/^(info|contact|hello|hi|hey)$/i.test(local)) return 1;
  if (/^(sales|business|partnerships|press|media)$/i.test(local)) return 2;
  return 3; // personal-looking emails rank highest
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

function filterAndRank(raw: string[]): string[] {
  return dedup(raw)
    .filter((e) => !isJunkEmail(e))
    .sort((a, b) => rankEmail(b) - rankEmail(a))
    .slice(0, MAX_EMAILS_PER_LEAD);
}

// ---------------------------------------------------------------------------
// Tier 1: Scrape company website
// ---------------------------------------------------------------------------

async function tier1_scrapeWebsite(website: string): Promise<string[]> {
  try {
    const result = await scrapeEmails(website, { timeout: FETCH_TIMEOUT, maxPages: 6 });
    const companyDomain = extractDomain(website);
    return result.emails.filter((e) => emailMatchesDomain(e, companyDomain));
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

async function findForOne(lead: FindEmailsInput): Promise<FindEmailsResult> {
  const companyDomain = lead.website ? extractDomain(lead.website) : null;

  // Tier 1: company website — strict domain match
  if (lead.website) {
    const emails = await tier1_scrapeWebsite(lead.website);
    const ranked = filterAndRank(emails);
    if (ranked.length > 0) return { id: lead.id, emails: ranked, tier: 1 };
  }

  // Tier 2: source article — prefer company domain, fallback to any
  if (lead.source_url) {
    const emails = await tier2_parseArticle(lead.source_url);
    const onDomain = companyDomain ? emails.filter((e) => emailMatchesDomain(e, companyDomain)) : emails;
    const ranked = filterAndRank(onDomain.length > 0 ? onDomain : emails);
    if (ranked.length > 0) return { id: lead.id, emails: ranked, tier: 2 };
  }

  // Tier 3: Google search — already domain-filtered inside
  const emails = await tier3_googleSearch(lead.company_name, companyDomain ?? undefined);
  const ranked = filterAndRank(emails);
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
