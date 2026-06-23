/** @jest-environment node */

import { buildAdzunaSearchUrl, normalizeAdzunaJobToEngVacancy } from '@/lib/parsers/engHiring';

describe('buildAdzunaSearchUrl', () => {
  it('builds a country search URL with creds, paging, recency, and role query', () => {
    const url = buildAdzunaSearchUrl({
      country: 'us', page: 2, appId: 'ID', appKey: 'KEY', what: 'sales manager', maxDaysOld: 30, resultsPerPage: 50,
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://api.adzuna.com/v1/api/jobs/us/search/2');
    expect(u.searchParams.get('app_id')).toBe('ID');
    expect(u.searchParams.get('app_key')).toBe('KEY');
    expect(u.searchParams.get('results_per_page')).toBe('50');
    expect(u.searchParams.get('what')).toBe('sales manager');
    expect(u.searchParams.get('max_days_old')).toBe('30');
  });

  it('clamps page / results_per_page and lowercases the country code', () => {
    const u = new URL(buildAdzunaSearchUrl({ country: 'US', page: 0, appId: 'a', appKey: 'b', resultsPerPage: 999 }));
    expect(u.pathname).toBe('/v1/api/jobs/us/search/1');
    expect(u.searchParams.get('results_per_page')).toBe('50');
    expect(u.searchParams.get('max_days_old')).toBeNull(); // omitted when 0/undefined
  });
});

describe('normalizeAdzunaJobToEngVacancy', () => {
  it('maps an Adzuna result to an EngHiringVacancy (clean description, currency, city)', () => {
    const v = normalizeAdzunaJobToEngVacancy(
      {
        id: '4861512345',
        title: 'Enterprise Sales Manager',
        company: { display_name: 'Acme Corp' },
        location: { display_name: 'San Francisco, California', area: ['US', 'California', 'San Francisco'] },
        salary_min: 90000,
        salary_max: 140000,
        created: '2026-06-20T12:00:00Z',
        redirect_url: 'https://www.adzuna.com/land/ad/4861512345',
        description: '<p>Own B2B&nbsp;revenue &amp; pipeline.</p>',
      },
      { country: 'us' },
    );
    expect(v).toMatchObject({
      source: 'adzuna',
      source_job_id: '4861512345',
      company_name: 'Acme Corp',
      vacancy_title: 'Enterprise Sales Manager',
      vacancy_url: 'https://www.adzuna.com/land/ad/4861512345',
      location: 'San Francisco, California',
      city: 'San Francisco',
      country_code: 'us',
      salary_from: 90000,
      salary_to: 140000,
      salary_currency: 'USD',
      company_site_url: null, // resolved later by the domain enrichment step
    });
    expect(v?.vacancy_description).toBe('Own B2B revenue & pipeline.');
    expect(v?.published_at).toBe(new Date('2026-06-20T12:00:00Z').toISOString());
  });

  it('returns null when a required field is missing', () => {
    expect(normalizeAdzunaJobToEngVacancy({ title: 'X' }, { country: 'us' })).toBeNull();
    expect(normalizeAdzunaJobToEngVacancy(null, { country: 'us' })).toBeNull();
  });

  it('drops out-of-range salaries via the annual guards', () => {
    const v = normalizeAdzunaJobToEngVacancy(
      { id: '1', title: 'Sales Manager', company: { display_name: 'Z' }, redirect_url: 'https://x/1', salary_min: 5, salary_max: 9 },
      { country: 'us' },
    );
    expect(v?.salary_from).toBeNull();
    expect(v?.salary_to).toBeNull();
  });
});
