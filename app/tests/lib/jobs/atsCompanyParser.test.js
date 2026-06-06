/** @jest-environment node */

const {
  buildCompanyLeads,
  domainFromJobUrls,
  exportCompanyLeadsToCsv,
  normalizeAshbyJob,
  normalizeGreenhouseJob,
  normalizeLeverJob,
  parseCompanyCsv,
  pickDomainFromSuggestions,
  roleTagsForTitle,
} = require('../../../src/lib/jobs/atsCompanyParser');

describe('atsCompanyParser — normalizers', () => {
  it('normalizes a Greenhouse job (uses company_name and updated_at)', () => {
    const job = normalizeGreenhouseJob(
      {
        title: 'B2B Marketing Manager',
        company_name: '10x Genomics',
        location: { name: 'California, USA (Remote)' },
        absolute_url: 'https://www.augury.com/careers/123?gh_jid=123',
        updated_at: '2026-05-12T14:51:29-04:00',
      },
      { slug: '10xgenomics', companyName: 'fallback' },
    );

    expect(job).toMatchObject({
      ats: 'greenhouse',
      slug: '10xgenomics',
      company: '10x Genomics',
      title: 'B2B Marketing Manager',
      location: 'California, USA (Remote)',
      url: 'https://www.augury.com/careers/123?gh_jid=123',
      roles: ['b2b_sales', 'marketing'],
    });
    expect(job.posted_at).toBe(new Date('2026-05-12T14:51:29-04:00').toISOString());
  });

  it('normalizes a Lever job (title from text, epoch-ms date, company from ctx)', () => {
    const job = normalizeLeverJob(
      {
        text: 'Account Executive',
        categories: { location: 'Remote', team: 'Sales' },
        createdAt: 1776376050258,
        hostedUrl: 'https://jobs.lever.co/acme/abc',
      },
      { slug: 'acme', companyName: 'Acme Ltd' },
    );

    expect(job).toMatchObject({
      ats: 'lever',
      company: 'Acme Ltd',
      title: 'Account Executive',
      location: 'Remote',
      url: 'https://jobs.lever.co/acme/abc',
      roles: ['b2b_sales'],
    });
    expect(job.posted_at).toBe(new Date(1776376050258).toISOString());
  });

  it('normalizes an Ashby job (country from postal address)', () => {
    const job = normalizeAshbyJob(
      {
        title: 'Senior Growth Marketer',
        location: 'New York',
        address: { postalAddress: { addressCountry: 'United States' } },
        publishedAt: '2026-06-01T21:05:10.955Z',
        jobUrl: 'https://jobs.ashbyhq.com/acme/xyz',
      },
      { slug: 'acme', companyName: 'Acme' },
    );

    expect(job).toMatchObject({
      ats: 'ashby',
      country: 'United States',
      title: 'Senior Growth Marketer',
      roles: ['marketing'],
    });
  });

  it('tags only marketing / b2b-sales titles', () => {
    expect(roleTagsForTitle('Backend Engineer')).toEqual([]);
    expect(roleTagsForTitle('Demand Generation Manager')).toEqual(['marketing']);
    expect(roleTagsForTitle('SDR, Enterprise')).toEqual(['b2b_sales']);
  });
});

describe('atsCompanyParser — aggregation', () => {
  it('deduplicates a company across jobs and sets the careers URL', () => {
    const jobs = [
      normalizeGreenhouseJob(
        { title: 'Account Executive', company_name: 'Acme', location: { name: 'London' }, absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/1', updated_at: '2026-05-01T10:00:00Z' },
        { slug: 'acme' },
      ),
      normalizeGreenhouseJob(
        { title: 'Product Marketing Manager', company_name: 'Acme', location: { name: 'Remote' }, absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/2', updated_at: '2026-05-03T10:00:00Z' },
        { slug: 'acme' },
      ),
    ];

    const leads = buildCompanyLeads(jobs);
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({
      company: 'Acme',
      ats: 'greenhouse',
      slug: 'acme',
      job_count: 2,
      roles_found: ['b2b_sales', 'marketing'],
      careers_url: 'https://job-boards.greenhouse.io/acme',
    });
    expect(leads[0].cities).toEqual(['London', 'Remote']);
    expect(leads[0].latest_posted_at).toBe('2026-05-03T10:00:00.000Z');
  });
});

describe('atsCompanyParser — domain helpers', () => {
  it('extracts a domain from a custom careers host but not from ATS hosts', () => {
    expect(domainFromJobUrls(['https://www.augury.com/careers/1'])).toBe('augury.com');
    expect(domainFromJobUrls(['https://careers.acme.co.uk/1'])).toBe('acme.co.uk');
    expect(domainFromJobUrls(['https://job-boards.greenhouse.io/acme/jobs/1'])).toBe('');
    expect(domainFromJobUrls(['https://jobs.lever.co/acme/1', 'https://jobs.ashbyhq.com/acme/2'])).toBe('');
  });

  it('prefers an exact name match among Clearbit suggestions', () => {
    const domain = pickDomainFromSuggestions('Replit', [
      { name: 'Replit Foo', domain: 'foo.com' },
      { name: 'Replit', domain: 'replit.com' },
    ]);
    expect(domain).toBe('replit.com');
    expect(pickDomainFromSuggestions('Whatever', [])).toBe('');
  });
});

describe('atsCompanyParser — CSV parsing & export', () => {
  it('parses name,slug,url (commas in names) and legacy name,url rows', () => {
    const rows = parseCompanyCsv(
      [
        'name,slug,url',
        'Acme, Inc,acmeinc,https://job-boards.greenhouse.io/acmeinc',
        'Stripe,stripe,https://job-boards.greenhouse.io/stripe',
        'LegacyCo,https://jobs.lever.co/legacyco',
      ].join('\n'),
    );

    expect(rows).toEqual([
      { name: 'Acme, Inc', slug: 'acmeinc', url: 'https://job-boards.greenhouse.io/acmeinc' },
      { name: 'Stripe', slug: 'stripe', url: 'https://job-boards.greenhouse.io/stripe' },
      { name: 'LegacyCo', slug: 'legacyco', url: 'https://jobs.lever.co/legacyco' },
    ]);
  });

  it('exports CSV with the domain column and proper escaping', () => {
    const csv = exportCompanyLeadsToCsv([
      {
        company: 'Acme',
        domain: 'acme.com',
        ats: 'greenhouse',
        slug: 'acme',
        country: 'US',
        cities: ['London'],
        roles_found: ['marketing'],
        job_count: 1,
        job_titles: ['Growth "Lead", EMEA'],
        job_urls: ['https://job-boards.greenhouse.io/acme/jobs/1'],
        careers_url: 'https://job-boards.greenhouse.io/acme',
        latest_posted_at: '2026-05-01T10:00:00.000Z',
      },
    ]);

    expect(csv.split('\r\n')[0]).toBe(
      'company,domain,ats,slug,country,cities,roles_found,job_count,job_titles,job_urls,careers_url,latest_posted_at',
    );
    expect(csv).toContain('"Growth ""Lead"", EMEA"');
    expect(csv).toContain('acme.com');
  });
});
