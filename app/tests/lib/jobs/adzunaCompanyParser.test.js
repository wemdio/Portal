/** @jest-environment node */

import {
  buildCompanyLeads,
  exportCompanyLeadsToCsv,
  normalizeAdzunaJob,
} from '../../../src/lib/jobs/adzunaCompanyParser';

describe('adzunaCompanyParser', () => {
  it('normalizes Adzuna jobs, deduplicates companies, and combines target roles', () => {
    const rawJobs = [
      {
        id: 'job-1',
        title: 'B2B Marketing Manager',
        company: { display_name: 'Acme Ltd' },
        location: { display_name: 'London, UK' },
        redirect_url: 'https://example.com/jobs/1',
        created: '2026-05-01T10:00:00Z',
      },
      {
        id: 'job-2',
        title: 'Account Executive, Enterprise',
        company: { display_name: 'ACME Limited' },
        location: { display_name: 'Remote' },
        redirect_url: 'https://example.com/jobs/2',
        created: '2026-05-03T10:00:00Z',
      },
      {
        id: 'job-3',
        title: 'Backend Engineer',
        company: { display_name: 'Other Inc' },
        location: { display_name: 'New York, NY' },
        redirect_url: 'https://example.com/jobs/3',
      },
    ];

    const jobs = rawJobs
      .map((job) => normalizeAdzunaJob(job, { country: 'gb', query: 'marketing manager' }))
      .filter(Boolean);

    const leads = buildCompanyLeads(jobs);

    expect(leads).toHaveLength(2);
    expect(leads[0]).toMatchObject({
      company: 'Acme Ltd',
      country: 'gb',
      job_count: 2,
      roles_found: ['b2b_sales', 'marketing'],
      source: 'adzuna',
    });
    expect(leads[0].cities).toEqual(['London, UK', 'Remote']);
    expect(leads[0].job_titles).toEqual(['B2B Marketing Manager', 'Account Executive, Enterprise']);
    expect(leads[0].job_urls).toEqual(['https://example.com/jobs/1', 'https://example.com/jobs/2']);
    expect(leads[0].latest_posted_at).toBe('2026-05-03T10:00:00Z');
  });

  it('exports CSV with stable headers and escaping', () => {
    const csv = exportCompanyLeadsToCsv([
      {
        company: 'Acme Ltd',
        country: 'gb',
        cities: ['London'],
        roles_found: ['marketing'],
        job_count: 1,
        job_titles: ['Growth "Lead", EMEA'],
        job_urls: ['https://example.com/jobs/1'],
        queries: ['growth marketer'],
        latest_posted_at: '2026-05-01T10:00:00Z',
        source: 'adzuna',
      },
    ]);

    expect(csv).toContain('company,country,cities,roles_found,job_count,job_titles,job_urls,queries,latest_posted_at,source');
    expect(csv).toContain('"Growth ""Lead"", EMEA"');
  });
});
