const LEGAL_SUFFIX_RE =
  /\b(ltd|limited|inc|llc|gmbh|ag|plc|corp|corporation|company|co|bv|nv|oy|ab|aps|pte|pty|sarl|sas|sa|spa|srl)\b\.?/gi;

const MARKETING_RE =
  /\b(marketing|marketer|growth|demand generation|lead generation|performance|digital marketing|product marketing|brand|content|seo|sem|ppc|paid social|crm|lifecycle|field marketing|go[-\s]?to[-\s]?market|gtm)\b/i;

const B2B_SALES_RE =
  /\b(b2b|business development|account executive|sales development|business development representative|sales manager|sales lead|sales executive|enterprise sales|partnerships?|channel sales|commercial manager|revenue manager|sdr|bdr)\b/i;

const CSV_HEADERS = [
  'company',
  'country',
  'cities',
  'roles_found',
  'job_count',
  'job_titles',
  'job_urls',
  'queries',
  'latest_posted_at',
  'source',
];

function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
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

function uniq(values) {
  return [...new Set(values.map(normalizeWhitespace).filter(Boolean))];
}

function roleTagsForTitle(title) {
  const tags = [];
  if (B2B_SALES_RE.test(title)) tags.push('b2b_sales');
  if (MARKETING_RE.test(title)) tags.push('marketing');
  return tags;
}

function normalizeAdzunaJob(job, options = {}) {
  const company = normalizeCompanyName(job?.company?.display_name);
  const title = normalizeWhitespace(job?.title);
  if (!company || !title) return null;

  return {
    id: normalizeWhitespace(job?.id),
    company,
    company_key: companyDedupKey(company),
    title,
    country: normalizeWhitespace(options.country).toLowerCase(),
    city: normalizeWhitespace(job?.location?.display_name),
    url: normalizeWhitespace(job?.redirect_url || job?.adref || job?.url),
    query: normalizeWhitespace(options.query),
    posted_at: normalizeWhitespace(job?.created),
    roles: roleTagsForTitle(title),
    source: 'adzuna',
  };
}

function buildCompanyLeads(jobs) {
  const byCompany = new Map();

  for (const job of jobs) {
    if (!job?.company_key) continue;
    const key = `${job.country || 'unknown'}:${job.company_key}`;
    const existing =
      byCompany.get(key) ??
      {
        company: job.company,
        country: job.country,
        cities: [],
        roles_found: [],
        job_count: 0,
        job_titles: [],
        job_urls: [],
        queries: [],
        latest_posted_at: '',
        source: 'adzuna',
      };

    existing.job_count += 1;
    existing.cities = uniq([...existing.cities, job.city]);
    existing.roles_found = uniq([...existing.roles_found, ...job.roles]).sort();
    existing.job_titles = uniq([...existing.job_titles, job.title]);
    existing.job_urls = uniq([...existing.job_urls, job.url]);
    existing.queries = uniq([...existing.queries, job.query]);
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
  CSV_HEADERS,
  buildCompanyLeads,
  companyDedupKey,
  exportCompanyLeadsToCsv,
  normalizeAdzunaJob,
  normalizeCompanyName,
  roleTagsForTitle,
};
