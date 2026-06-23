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
  /\b(b2b|business development|account executive|\bae\b|account director|account manager|sales development|revenue development|business development representative|revenue development representative|sales manager|sales representative|sales consultant|sales lead|sales executive|enterprise sales|commercial account|commercial account director|commercial account executive|partnerships?|channel sales|partner sales|partner manager|commercial manager|client partner|sdr|bdr|rdr|go[-\s]?to[-\s]?market|gtm)\b/i;

const SUPPORTED_ATS = ['greenhouse', 'lever', 'ashby', 'workable', 'bamboohr', 'recruitee', 'breezy', 'workday', 'smartrecruiters', 'teamtailor'];

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

function normalizeWorkdayCareersUrl(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl);
    if (!parsed.hostname.toLowerCase().endsWith('.myworkdayjobs.com')) return '';
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${pathname}`;
  } catch {
    return '';
  }
}

function careersUrl(ats, slug, sourceUrl = '') {
  if (!slug) return '';
  if (ats === 'greenhouse') return `https://job-boards.greenhouse.io/${slug}`;
  if (ats === 'lever') return `https://jobs.lever.co/${slug}`;
  if (ats === 'ashby') return `https://jobs.ashbyhq.com/${slug}`;
  if (ats === 'workable') return `https://apply.workable.com/${slug}`;
  if (ats === 'bamboohr') return `https://${slug}.bamboohr.com/careers`;
  if (ats === 'recruitee') return `https://${slug}.recruitee.com`;
  if (ats === 'breezy') return `https://${slug}.breezy.hr`;
  if (ats === 'smartrecruiters') return `https://careers.smartrecruiters.com/${slug}`;
  if (ats === 'teamtailor') return `https://${slug}.teamtailor.com`;
  if (ats === 'workday') {
    const sourceCareersUrl = normalizeWorkdayCareersUrl(sourceUrl);
    if (sourceCareersUrl) return sourceCareersUrl;
    const [tenant, site] = String(slug).split('/');
    return tenant && site ? `https://${tenant}.myworkdayjobs.com/${site}` : '';
  }
  return '';
}

const ATS_BASE_HOSTS = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'bamboohr.com', 'recruitee.com', 'breezy.hr', 'myworkdayjobs.com', 'smartrecruiters.com', 'teamtailor.com'];
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

function workdayParts(slug, sourceUrl = '') {
  try {
    const parsed = new URL(sourceUrl);
    const tenant = parsed.hostname.split('.')[0];
    const site = parsed.pathname.split('/').filter(Boolean).pop();
    if (tenant && site) return { host: parsed.hostname, tenant, site };
  } catch {
    /* fall through to slug parsing */
  }
  const [tenant, site] = String(slug).split('/');
  return { host: tenant ? `${tenant}.myworkdayjobs.com` : '', tenant, site };
}

function postingsUrl(ats, slug, sourceUrl = '') {
  const safe = encodeURIComponent(slug);
  if (ats === 'greenhouse') return `https://boards-api.greenhouse.io/v1/boards/${safe}/jobs`;
  if (ats === 'lever') return `https://api.lever.co/v0/postings/${safe}?mode=json`;
  if (ats === 'ashby') return `https://api.ashbyhq.com/posting-api/job-board/${safe}`;
  if (ats === 'workable') return `https://apply.workable.com/api/v1/widget/accounts/${safe}`;
  if (ats === 'bamboohr') return `https://${slug}.bamboohr.com/careers/list`;
  if (ats === 'recruitee') return `https://${slug}.recruitee.com/api/offers`;
  if (ats === 'breezy') return `https://${slug}.breezy.hr/json`;
  if (ats === 'smartrecruiters') return `https://api.smartrecruiters.com/v1/companies/${safe}/postings`;
  if (ats === 'teamtailor') return `https://${slug}.teamtailor.com/jobs.json`;
  if (ats === 'workday') {
    const parts = workdayParts(slug, sourceUrl);
    if (parts.host && parts.tenant && parts.site) {
      return `https://${parts.host}/wday/cxs/${parts.tenant}/${parts.site}/jobs`;
    }
  }
  throw new Error(`Unsupported ATS: ${ats}`);
}

function extractJobs(ats, payload) {
  if (ats === 'lever') return Array.isArray(payload) ? payload : [];
  if (ats === 'breezy') return Array.isArray(payload) ? payload : [];
  if (ats === 'workday') return Array.isArray(payload?.jobPostings) ? payload.jobPostings : [];
  if (ats === 'workable') return Array.isArray(payload?.jobs) ? payload.jobs : [];
  if (ats === 'bamboohr') return Array.isArray(payload?.result) ? payload.result : [];
  if (ats === 'recruitee') return Array.isArray(payload?.offers) ? payload.offers : [];
  if (ats === 'smartrecruiters') return Array.isArray(payload?.content) ? payload.content : [];
  if (ats === 'teamtailor') return Array.isArray(payload?.items) ? payload.items : [];
  return Array.isArray(payload?.jobs) ? payload.jobs : [];
}

function baseJob({ ats, slug, company, title, location, country, url, posted_at, careers_url }) {
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
    ...(careers_url ? { careers_url: normalizeWhitespace(careers_url) } : {}),
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

function normalizeBreezyJob(job, { slug, companyName } = {}) {
  const location = job?.location || {};
  const country = location?.country?.name || location?.country || '';
  const state = location?.state?.id || location?.state?.name || location?.state || '';
  const locationName = location?.name || joinLocationParts([location?.city, state]);
  return baseJob({
    ats: 'breezy',
    slug,
    company: job?.company?.name || companyName,
    title: job?.name,
    location: joinLocationParts([locationName, country]),
    country,
    url: job?.url || (slug && job?.friendly_id ? `https://${slug}.breezy.hr/p/${job.friendly_id}` : ''),
    posted_at: job?.published_date || job?.publishedDate || job?.created_at,
  });
}

function normalizeSmartrecruitersJob(job, { slug, companyName } = {}) {
  const location = job?.location || {};
  // fullLocation carries the full country name ("Chicago, IL, United States"),
  // which feeds country inference cleanly; fall back to city/region/country code.
  const locationText = location.fullLocation || joinLocationParts([location.city, location.region, location.country]);
  const identifier = job?.company?.identifier || slug;
  const id = normalizeWhitespace(job?.id);
  return baseJob({
    ats: 'smartrecruiters',
    slug,
    company: job?.company?.name || companyName,
    title: job?.name,
    location: locationText,
    country: '',
    // `ref` is the API endpoint, never a public link — prefer the public posting
    // URL (detail payloads) or construct it from the company identifier + id.
    url: job?.postingUrl || job?.applyUrl || (identifier && id ? `https://jobs.smartrecruiters.com/${identifier}/${id}` : ''),
    posted_at: job?.releasedDate || job?.actualPostedDate || job?.createdOn,
  });
}

let _regionDisplayNames;
// Resolve a bare ISO-3166 alpha-2 code to its English country name so it cannot
// collide with a US state code during inference (e.g. "DE" = Germany, not
// Delaware; "ID" = Indonesia, not Idaho). Full names / non-2-letter values pass
// through unchanged.
function isoCountryName(value) {
  const raw = normalizeWhitespace(value);
  if (!/^[A-Za-z]{2}$/.test(raw)) return raw;
  try {
    _regionDisplayNames = _regionDisplayNames || new Intl.DisplayNames(['en'], { type: 'region' });
    return _regionDisplayNames.of(raw.toUpperCase()) || raw;
  } catch {
    return raw;
  }
}

function normalizeTeamtailorJob(job, { slug, companyName } = {}) {
  // jobs.json items embed a schema.org JobPosting under `_jobposting`, the only
  // place with structured location (jobLocation[].address.addressCountry).
  const posting = job?._jobposting || {};
  const address = (Array.isArray(posting.jobLocation) ? posting.jobLocation[0]?.address : null) || {};
  const country = isoCountryName(address.addressCountry || '');
  return baseJob({
    ats: 'teamtailor',
    slug,
    company: posting?.hiringOrganization?.name || job?.company?.name || companyName,
    title: job?.title || posting?.title,
    location: joinLocationParts([address.addressLocality, address.addressRegion, country]),
    country,
    url: job?.url,
    posted_at: job?.date_published || posting?.datePosted,
  });
}

function workdayPostedAt(value) {
  const raw = normalizeWhitespace(value).toLowerCase();
  if (!raw) return '';
  const now = new Date();
  if (/today/.test(raw)) return now.toISOString();
  if (/yesterday/.test(raw)) {
    now.setUTCDate(now.getUTCDate() - 1);
    return now.toISOString();
  }
  const hours = raw.match(/(\d+)\s+hours?\s+ago/);
  if (hours) {
    now.setUTCHours(now.getUTCHours() - Number(hours[1]));
    return now.toISOString();
  }
  const days = raw.match(/(\d+)\+?\s+days?\s+ago/);
  if (days) {
    const plus = raw.includes(`${days[1]}+`);
    now.setUTCDate(now.getUTCDate() - Number(days[1]) - (plus ? 1 : 0));
    return now.toISOString();
  }
  return toIso(value);
}

function workdayPublicJobUrl(sourceUrl, externalPath) {
  if (!externalPath) return '';
  try {
    const parsed = new URL(sourceUrl);
    const basePath = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = `${basePath}${String(externalPath).startsWith('/') ? externalPath : `/${externalPath}`}`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function normalizeWorkdayJob(job, { slug, companyName, sourceUrl } = {}) {
  return baseJob({
    ats: 'workday',
    slug,
    company: companyName,
    title: job?.title,
    location: job?.locationsText || job?.location || '',
    country: '',
    url: workdayPublicJobUrl(sourceUrl, job?.externalPath),
    posted_at: workdayPostedAt(job?.postedOn || job?.startDate || job?.posted_on),
    careers_url: careersUrl('workday', slug, sourceUrl),
  });
}

function normalizeJob(ats, job, ctx = {}) {
  if (ats === 'greenhouse') return normalizeGreenhouseJob(job, ctx);
  if (ats === 'lever') return normalizeLeverJob(job, ctx);
  if (ats === 'ashby') return normalizeAshbyJob(job, ctx);
  if (ats === 'workable') return normalizeWorkableJob(job, ctx);
  if (ats === 'bamboohr') return normalizeBamboohrJob(job, ctx);
  if (ats === 'recruitee') return normalizeRecruiteeJob(job, ctx);
  if (ats === 'breezy') return normalizeBreezyJob(job, ctx);
  if (ats === 'smartrecruiters') return normalizeSmartrecruitersJob(job, ctx);
  if (ats === 'teamtailor') return normalizeTeamtailorJob(job, ctx);
  if (ats === 'workday') return normalizeWorkdayJob(job, ctx);
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
    if (parts.length >= 2 && /^[a-z0-9][a-z0-9._/-]*$/.test(tail)) {
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

// Merge per-ATS company-token lists from several sources (e.g. multiple public
// datasets) into one, deduping by slug case-insensitively. First occurrence wins
// and order is preserved, so the primary list ranks ahead of supplementary ones.
// Tokens without a slug are dropped (they can't be fetched). Tolerates
// null/undefined lists so one failing source doesn't break the merge.
function mergeCompanyTokens(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists || []) {
    for (const token of list || []) {
      const key = String(token?.slug ?? '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(token);
    }
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
        careers_url: job.careers_url || careersUrl(job.ats, job.slug),
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
  mergeCompanyTokens,
  normalizeAshbyJob,
  normalizeBamboohrJob,
  normalizeBreezyJob,
  normalizeGreenhouseJob,
  normalizeJob,
  normalizeLeverJob,
  normalizeRecruiteeJob,
  normalizeSmartrecruitersJob,
  normalizeTeamtailorJob,
  normalizeWorkdayJob,
  normalizeWorkableJob,
  parseCompanyCsv,
  pickDomainFromSuggestions,
  postingsUrl,
};
