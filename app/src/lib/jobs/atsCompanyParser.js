// ATS company-lead parser.
//
// Same idea as adzunaCompanyParser / the HH fleet scripts: turn job postings
// into company leads, where an open role is the buying signal. The difference:
// ATS boards are first-party (the company's own careers page), so the careers
// URL — and, after enrichment, the real domain — comes straight from the source.
//
// Company-token lists come from the open-source kalil0321/ats-scrapers dataset
// (MIT). Role taxonomy is shared with adzunaCompanyParser so the signal is
// identical across EU/US sources.

// Role taxonomy + company-name normalization, inlined so this module is
// self-contained (kept identical to adzunaCompanyParser so the buying-signal
// definition matches across EU/US sources).
const LEGAL_SUFFIX_RE =
  /\b(ltd|limited|inc|llc|gmbh|ag|plc|corp|corporation|company|co|bv|nv|oy|ab|aps|pte|pty|sarl|sas|sa|spa|srl)\b\.?/gi;

const MARKETING_RE =
  /\b(marketing|marketer|growth|demand generation|lead generation|performance|digital marketing|product marketing|brand|content|seo|sem|ppc|paid social|crm|lifecycle|field marketing|go[-\s]?to[-\s]?market|gtm)\b/i;

const B2B_SALES_RE =
  /\b(b2b|business development|account executive|sales development|business development representative|sales manager|sales lead|sales executive|enterprise sales|partnerships?|channel sales|commercial manager|revenue manager|sdr|bdr)\b/i;

const SUPPORTED_ATS = ['greenhouse', 'lever', 'ashby', 'workable', 'bamboohr', 'recruitee'];

const CSV_HEADERS = [
  'company',
  'domain',
  'ats',
  'slug',
  'country',
  'cities',
  'roles_found',
  'job_count',
  'job_titles',
  'job_urls',
  'careers_url',
  'latest_posted_at',
];

function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function joinLocationParts(parts) {
  return uniq(parts).join(', ');
}

function uniq(values) {
  return [...new Set(values.map(normalizeWhitespace).filter(Boolean))];
}

function normalizeCompanyName(value) {
  return normalizeWhitespace(value).replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

function companyDedupKey(value) {
  return normalizeCompanyName(value)
    .toLowerCase()
    .replace(LEGAL_SUFFIX_RE, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function roleTagsForTitle(title) {
  const tags = [];
  if (B2B_SALES_RE.test(title)) tags.push('b2b_sales');
  if (MARKETING_RE.test(title)) tags.push('marketing');
  return tags;
}

// Accepts an ISO string or epoch-ms (Lever uses epoch-ms). Returns ISO or ''.
function toIso(value) {
  if (value == null || value === '') return '';
  const isEpoch = typeof value === 'number' || /^\d{10,}$/.test(String(value));
  const date = isEpoch ? new Date(Number(value)) : new Date(value);
  return Number.isNaN(date.getTime()) ? normalizeWhitespace(value) : date.toISOString();
}

function careersUrl(ats, slug) {
  if (!slug) return '';
  if (ats === 'greenhouse') return `https://job-boards.greenhouse.io/${slug}`;
  if (ats === 'lever') return `https://jobs.lever.co/${slug}`;
  if (ats === 'ashby') return `https://jobs.ashbyhq.com/${slug}`;
  if (ats === 'workable') return `https://apply.workable.com/${slug}`;
  if (ats === 'bamboohr') return `https://${slug}.bamboohr.com/careers`;
  if (ats === 'recruitee') return `https://${slug}.recruitee.com`;
  return '';
}

const ATS_BASE_HOSTS = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'bamboohr.com', 'recruitee.com'];
// Multi-level public suffixes we care about, so registrableDomain keeps 3 labels.
const TWO_LEVEL_TLDS = new Set([
  'co.uk', 'com.au', 'co.jp', 'com.br', 'co.nz', 'com.sg', 'co.in', 'com.mx', 'co.za',
]);

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function isAtsHost(host) {
  return ATS_BASE_HOSTS.some((base) => host === base || host.endsWith(`.${base}`));
}

function registrableDomain(host) {
  const parts = String(host).toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  return TWO_LEVEL_TLDS.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

// Free, network-free domain: when a posting URL is on the company's own careers
// host (not the ATS host), that host IS the company domain. Many Greenhouse
// boards expose absolute_url on the customer's domain (e.g. augury.com).
function domainFromJobUrls(jobUrls) {
  for (const url of jobUrls || []) {
    const host = hostFromUrl(url);
    if (host && !isAtsHost(host)) return registrableDomain(host);
  }
  return '';
}

function postingsUrl(ats, slug) {
  const safe = encodeURIComponent(slug);
  if (ats === 'greenhouse') return `https://boards-api.greenhouse.io/v1/boards/${safe}/jobs`;
  if (ats === 'lever') return `https://api.lever.co/v0/postings/${safe}?mode=json`;
  if (ats === 'ashby') return `https://api.ashbyhq.com/posting-api/job-board/${safe}`;
  if (ats === 'workable') return `https://apply.workable.com/api/v1/widget/accounts/${safe}`;
  if (ats === 'bamboohr') return `https://${slug}.bamboohr.com/careers/list`;
  if (ats === 'recruitee') return `https://${slug}.recruitee.com/api/offers`;
  throw new Error(`Unsupported ATS: ${ats}`);
}

function extractJobs(ats, payload) {
  if (ats === 'lever') return Array.isArray(payload) ? payload : [];
  if (ats === 'workable') return Array.isArray(payload?.jobs) ? payload.jobs : [];
  if (ats === 'bamboohr') return Array.isArray(payload?.result) ? payload.result : [];
  if (ats === 'recruitee') return Array.isArray(payload?.offers) ? payload.offers : [];
  return Array.isArray(payload?.jobs) ? payload.jobs : [];
}

function baseJob({ ats, slug, company, title, location, country, url, posted_at }) {
  const cleanCompany = normalizeCompanyName(company);
  const cleanTitle = normalizeWhitespace(title);
  if (!cleanCompany || !cleanTitle) return null;

  return {
    ats,
    slug: normalizeWhitespace(slug),
    company: cleanCompany,
    company_key: companyDedupKey(cleanCompany),
    title: cleanTitle,
    location: normalizeWhitespace(location),
    country: normalizeWhitespace(country),
    url: normalizeWhitespace(url),
    posted_at: toIso(posted_at),
    roles: roleTagsForTitle(cleanTitle),
  };
}

function normalizeGreenhouseJob(job, { slug, companyName } = {}) {
  return baseJob({
    ats: 'greenhouse',
    slug,
    company: job?.company_name || companyName,
    title: job?.title,
    location: job?.location?.name,
    country: '',
    url: job?.absolute_url,
    posted_at: job?.updated_at || job?.first_published,
  });
}

function normalizeLeverJob(job, { slug, companyName } = {}) {
  const categories = job?.categories || {};
  const location =
    categories.location ||
    (Array.isArray(categories.allLocations) ? categories.allLocations.join(', ') : '');
  return baseJob({
    ats: 'lever',
    slug,
    company: companyName,
    title: job?.text,
    location,
    country: job?.country,
    url: job?.hostedUrl || job?.applyUrl,
    posted_at: job?.createdAt,
  });
}

function normalizeAshbyJob(job, { slug, companyName } = {}) {
  return baseJob({
    ats: 'ashby',
    slug,
    company: companyName,
    title: job?.title,
    location: job?.location,
    country: job?.address?.postalAddress?.addressCountry,
    url: job?.jobUrl || job?.applyUrl,
    posted_at: job?.publishedAt,
  });
}

function normalizeWorkableJob(job, { slug, companyName } = {}) {
  const firstLocation = Array.isArray(job?.locations) ? job.locations[0] : null;
  const location = firstLocation
    ? joinLocationParts([firstLocation.city, firstLocation.region, firstLocation.country])
    : joinLocationParts([job?.city, job?.state, job?.country]);
  const shortcode = normalizeWhitespace(job?.shortcode);
  return baseJob({
    ats: 'workable',
    slug,
    company: companyName,
    title: job?.title,
    location,
    country: firstLocation?.country || job?.country,
    url: job?.url || job?.shortlink || job?.application_url || (slug && shortcode ? `https://apply.workable.com/${slug}/j/${shortcode}` : ''),
    posted_at: job?.published_on || job?.created_at,
  });
}

function normalizeBamboohrJob(job, { slug, companyName } = {}) {
  const location = job?.location || {};
  const atsLocation = job?.atsLocation || {};
  const country = location.addressCountry || location.country || atsLocation.country;
  return baseJob({
    ats: 'bamboohr',
    slug,
    company: companyName,
    title: job?.jobOpeningName,
    location: joinLocationParts([
      location.city || atsLocation.city,
      location.state || atsLocation.state || atsLocation.province,
      country,
    ]),
    country,
    url: job?.jobOpeningShareUrl || (slug && job?.id ? `https://${slug}.bamboohr.com/careers/${job.id}` : ''),
    posted_at: job?.datePosted,
  });
}

function normalizeRecruiteeJob(job, { slug, companyName } = {}) {
  const jobURL =
    job?.careers_url ||
    (job?.careers_apply_url ? String(job.careers_apply_url).replace(/\/c\/new\/?$/, '') : '') ||
    (slug && job?.slug ? `https://${slug}.recruitee.com/o/${job.slug}` : '');
  return baseJob({
    ats: 'recruitee',
    slug,
    company: job?.company_name || companyName,
    title: job?.title,
    location: job?.location || joinLocationParts([job?.city, job?.state_name || job?.state, job?.country]),
    country: job?.country,
    url: jobURL,
    posted_at: job?.published_at || job?.created_at,
  });
}

function normalizeJob(ats, job, ctx = {}) {
  if (ats === 'greenhouse') return normalizeGreenhouseJob(job, ctx);
  if (ats === 'lever') return normalizeLeverJob(job, ctx);
  if (ats === 'ashby') return normalizeAshbyJob(job, ctx);
  if (ats === 'workable') return normalizeWorkableJob(job, ctx);
  if (ats === 'bamboohr') return normalizeBamboohrJob(job, ctx);
  if (ats === 'recruitee') return normalizeRecruiteeJob(job, ctx);
  return null;
}

function slugFromUrl(url) {
  const match = String(url).replace(/\/+$/, '').match(/([^/]+)$/);
  return match ? match[1] : '';
}

// Parses the per-ATS `name,slug,url` company CSVs from kalil0321/ats-scrapers.
// Tolerates the legacy two-column `name,url` form and company names with commas
// (url and slug never contain commas, so we pop from the right).
function parseCompanyCsv(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^\s*name\s*,/i.test(line)) continue; // header
    const parts = line.split(',');
    if (parts.length < 2) continue;

    const url = normalizeWhitespace(parts.pop());
    let slug;
    let name;
    const tail = parts[parts.length - 1]?.trim() ?? '';
    if (parts.length >= 2 && /^[a-z0-9][a-z0-9._-]*$/.test(tail)) {
      slug = tail;
      name = normalizeWhitespace(parts.slice(0, -1).join(','));
    } else {
      name = normalizeWhitespace(parts.join(','));
      slug = slugFromUrl(url);
    }
    if (!slug) continue;
    out.push({ name, slug, url });
  }
  return out;
}

function buildCompanyLeads(jobs) {
  const byCompany = new Map();

  for (const job of jobs) {
    if (!job) continue;
    const key = `${job.ats}:${job.slug || job.company_key}`;
    const existing =
      byCompany.get(key) ??
      {
        company: job.company,
        domain: '',
        ats: job.ats,
        slug: job.slug,
        country: job.country,
        cities: [],
        roles_found: [],
        job_count: 0,
        job_titles: [],
        job_urls: [],
        careers_url: careersUrl(job.ats, job.slug),
        latest_posted_at: '',
      };

    existing.job_count += 1;
    existing.cities = uniq([...existing.cities, job.location]);
    existing.roles_found = uniq([...existing.roles_found, ...job.roles]).sort();
    existing.job_titles = uniq([...existing.job_titles, job.title]);
    existing.job_urls = uniq([...existing.job_urls, job.url]);
    if (!existing.country && job.country) existing.country = job.country;
    if (job.posted_at && (!existing.latest_posted_at || job.posted_at > existing.latest_posted_at)) {
      existing.latest_posted_at = job.posted_at;
    }

    byCompany.set(key, existing);
  }

  return [...byCompany.values()].sort((a, b) => {
    if (b.job_count !== a.job_count) return b.job_count - a.job_count;
    return a.company.localeCompare(b.company);
  });
}

// Picks the best domain from Clearbit autocomplete suggestions: prefer an exact
// name match (after suffix/punctuation normalization). A non-exact top
// suggestion is too risky for lead export quality.
function pickDomainFromSuggestions(name, suggestions) {
  if (!Array.isArray(suggestions) || suggestions.length === 0) return '';
  const key = companyDedupKey(name);
  const exact = suggestions.find((s) => companyDedupKey(s?.name || '') === key);
  return normalizeWhitespace(exact?.domain);
}

function escapeCsv(value) {
  const raw = Array.isArray(value) ? value.join('; ') : value;
  const str = String(raw ?? '');
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function exportCompanyLeadsToCsv(leads) {
  const lines = [
    CSV_HEADERS.join(','),
    ...leads.map((lead) => CSV_HEADERS.map((header) => escapeCsv(lead[header])).join(',')),
  ];
  return lines.join('\r\n');
}

module.exports = {
  SUPPORTED_ATS,
  CSV_HEADERS,
  buildCompanyLeads,
  careersUrl,
  companyDedupKey,
  domainFromJobUrls,
  normalizeCompanyName,
  roleTagsForTitle,
  exportCompanyLeadsToCsv,
  extractJobs,
  normalizeAshbyJob,
  normalizeBamboohrJob,
  normalizeGreenhouseJob,
  normalizeJob,
  normalizeLeverJob,
  normalizeRecruiteeJob,
  normalizeWorkableJob,
  parseCompanyCsv,
  pickDomainFromSuggestions,
  postingsUrl,
};
