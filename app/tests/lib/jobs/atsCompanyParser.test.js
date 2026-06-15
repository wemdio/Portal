/** @jest-environment node */

import {
  buildCompanyLeads,
  domainFromJobUrls,
  exportCompanyLeadsToCsv,
  extractJobs,
  normalizeAshbyJob,
  normalizeBamboohrJob,
  normalizeGreenhouseJob,
  normalizeLeverJob,
  normalizeRecruiteeJob,
  normalizeWorkableJob,
  parseCompanyCsv,
  pickDomainFromSuggestions,
  postingsUrl,
  roleTagsForTitle,
} from '../../../src/lib/jobs/atsCompanyParser';

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

  it('normalizes a Workable job from widget API payloads', () => {
    const job = normalizeWorkableJob(
      {
        title: 'Senior Account Executive',
        shortcode: 'ED7ABE3F68',
        department: 'Account Management',
        url: 'https://apply.workable.com/j/ED7ABE3F68',
        application_url: 'https://apply.workable.com/j/ED7ABE3F68/apply',
        published_on: '2026-05-21',
        locations: [
          {
            city: 'New York',
            region: 'NY',
            country: 'United States',
            countryCode: 'US',
          },
        ],
      },
      { slug: '1000heads', companyName: '1000heads' },
    );

    expect(job).toMatchObject({
      ats: 'workable',
      slug: '1000heads',
      company: '1000heads',
      title: 'Senior Account Executive',
      location: 'New York, NY, United States',
      country: 'United States',
      url: 'https://apply.workable.com/j/ED7ABE3F68',
      roles: ['b2b_sales'],
    });
    expect(job.posted_at).toBe(new Date('2026-05-21').toISOString());
  });

  it('normalizes a BambooHR job from list payloads', () => {
    const job = normalizeBamboohrJob(
      {
        id: '52',
        jobOpeningName: 'Enterprise Sales Manager',
        departmentLabel: 'Sales',
        employmentStatusLabel: 'Full-Time',
        location: { city: 'Austin', state: 'TX', addressCountry: 'United States' },
      },
      { slug: 'acme', companyName: 'Acme Inc' },
    );

    expect(job).toMatchObject({
      ats: 'bamboohr',
      slug: 'acme',
      company: 'Acme Inc',
      title: 'Enterprise Sales Manager',
      location: 'Austin, TX, United States',
      country: 'United States',
      url: 'https://acme.bamboohr.com/careers/52',
      roles: ['b2b_sales'],
    });
  });

  it('normalizes a Recruitee job from offers payloads', () => {
    const job = normalizeRecruiteeJob(
      {
        id: 137,
        title: 'Customer Success Consultant',
        company_name: '12Build',
        department: 'Customer Success',
        careers_url: 'https://12build.recruitee.com/o/customer-success-consultant',
        published_at: '2026-06-05 13:30:25 UTC',
        location: 'Nijverdal, Overijssel, Nederland',
        country: 'Netherlands',
      },
      { slug: '12build', companyName: '12Build' },
    );

    expect(job).toMatchObject({
      ats: 'recruitee',
      slug: '12build',
      company: '12Build',
      title: 'Customer Success Consultant',
      location: 'Nijverdal, Overijssel, Nederland',
      country: 'Netherlands',
      url: 'https://12build.recruitee.com/o/customer-success-consultant',
    });
    expect(job.posted_at).toBe(new Date('2026-06-05 13:30:25 UTC').toISOString());
  });

  it('builds public endpoints and extracts jobs for the added ATS sources', () => {
    expect(postingsUrl('workable', '1000heads')).toBe('https://apply.workable.com/api/v1/widget/accounts/1000heads');
    expect(postingsUrl('bamboohr', '10web')).toBe('https://10web.bamboohr.com/careers/list');
    expect(postingsUrl('recruitee', '12build')).toBe('https://12build.recruitee.com/api/offers');

    expect(extractJobs('workable', { jobs: [{ title: 'AE' }] })).toEqual([{ title: 'AE' }]);
    expect(extractJobs('bamboohr', { result: [{ jobOpeningName: 'AE' }] })).toEqual([{ jobOpeningName: 'AE' }]);
    expect(extractJobs('recruitee', { offers: [{ title: 'AE' }] })).toEqual([{ title: 'AE' }]);
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

  it('does not fall back to a non-exact Clearbit suggestion', () => {
    const domain = pickDomainFromSuggestions('Engine', [
      { name: 'Engineers Edge', domain: 'engineersedge.com' },
    ]);

    expect(domain).toBe('');
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
