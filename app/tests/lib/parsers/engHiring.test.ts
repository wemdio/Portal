/** @jest-environment node */

import {
  dedupeEngHiringVacancies,
  mergeEngHiringVacancyDetail,
  matchesEngHiringVacancy,
  normalizeAtsJobToEngVacancy,
  type EngHiringSearchConfig,
  type EngHiringVacancy,
} from '@/lib/parsers/engHiring';

describe('engHiring parser normalizer', () => {
  it('normalizes Greenhouse jobs into HH-like vacancy rows', () => {
    const vacancy = normalizeAtsJobToEngVacancy(
      'greenhouse',
      {
        id: 12345,
        title: 'Demand Generation Manager',
        company_name: 'Acme, Inc.',
        location: { name: 'New York, NY' },
        absolute_url: 'https://www.acme.com/careers/jobs/12345?gh_jid=12345',
        updated_at: '2026-06-01T12:30:00-04:00',
        salary: { min_value: 120000, max_value: 150000, currency: 'USD' },
      },
      { slug: 'acme', companyName: 'Acme fallback' },
    );

    expect(vacancy).toMatchObject({
      source: 'greenhouse',
      source_company_slug: 'acme',
      source_job_id: '12345',
      vacancy_title: 'Demand Generation Manager',
      vacancy_description: null,
      vacancy_url: 'https://www.acme.com/careers/jobs/12345?gh_jid=12345',
      company_name: 'Acme, Inc.',
      company_site_url: 'https://acme.com',
      location: 'New York, NY',
      country_code: 'us',
      salary_from: 120000,
      salary_to: 150000,
      salary_currency: 'USD',
    });
    expect(vacancy?.published_at).toBe(new Date('2026-06-01T12:30:00-04:00').toISOString());
  });

  it('extracts Ashby description and salary from list payloads', () => {
    const vacancy = normalizeAtsJobToEngVacancy(
      'ashby',
      {
        id: 'ash-2',
        title: 'Senior Account Executive - Enterprise',
        location: 'New York, NY',
        address: { postalAddress: { addressCountry: 'United States' } },
        publishedAt: '2026-06-03T08:00:00.000Z',
        jobUrl: 'https://jobs.ashbyhq.com/acme/ash-2',
        descriptionPlain: 'About Acme. This enterprise sales role owns B2B pipeline.',
        compensation: '$120k - $160k USD',
      },
      { slug: 'acme', companyName: 'Acme Ltd' },
    );

    expect(vacancy).toMatchObject({
      vacancy_description: 'About Acme. This enterprise sales role owns B2B pipeline.',
      salary_from: 120000,
      salary_to: 160000,
      salary_currency: 'USD',
      country_code: 'us',
    });
  });

  it('merges Greenhouse detail payloads into normalized vacancies', () => {
    const vacancy = normalizeAtsJobToEngVacancy(
      'greenhouse',
      {
        id: 12345,
        title: 'Account Executive',
        company_name: 'Acme',
        location: { name: 'Remote US' },
        absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/12345',
        first_published: '2026-06-01T00:00:00.000Z',
      },
      { slug: 'acme', companyName: 'Acme' },
    );

    const enriched = mergeEngHiringVacancyDetail(vacancy!, {
      content: '<p>About Acme</p><p>Base salary range: $130,000 - $170,000 USD.</p><p>Enterprise sales motion.</p>',
    });

    expect(enriched).toMatchObject({
      vacancy_description: 'About Acme Base salary range: $130,000 - $170,000 USD. Enterprise sales motion.',
      salary_from: 130000,
      salary_to: 170000,
      salary_currency: 'USD',
    });
  });

  it('normalizes Lever and Ashby jobs even when salary and company site are missing', () => {
    const lever = normalizeAtsJobToEngVacancy(
      'lever',
      {
        id: 'lev-1',
        text: 'Enterprise Account Executive',
        categories: { location: 'Remote - United Kingdom' },
        createdAt: 1776376050258,
        hostedUrl: 'https://jobs.lever.co/acme/abc',
      },
      { slug: 'acme', companyName: 'Acme Ltd' },
    );

    const ashby = normalizeAtsJobToEngVacancy(
      'ashby',
      {
        id: 'ash-1',
        title: 'Growth Marketing Lead',
        location: 'London',
        address: { postalAddress: { addressCountry: 'United Kingdom' } },
        publishedAt: '2026-06-03T08:00:00.000Z',
        jobUrl: 'https://jobs.ashbyhq.com/acme/ash-1',
      },
      { slug: 'acme', companyName: 'Acme Ltd' },
    );

    expect(lever).toMatchObject({
      source: 'lever',
      source_job_id: 'lev-1',
      company_name: 'Acme Ltd',
      vacancy_title: 'Enterprise Account Executive',
      company_site_url: null,
      salary_from: null,
      salary_to: null,
      country_code: 'gb',
    });
    expect(ashby).toMatchObject({
      source: 'ashby',
      source_job_id: 'ash-1',
      vacancy_title: 'Growth Marketing Lead',
      country: 'United Kingdom',
      country_code: 'gb',
    });
  });

  it('normalizes Workable jobs with salary and description from detail markdown payloads', () => {
    const vacancy = normalizeAtsJobToEngVacancy(
      'workable',
      {
        title: 'Senior Account Executive',
        shortcode: 'ED7ABE3F68',
        url: 'https://apply.workable.com/j/ED7ABE3F68',
        published_on: '2026-05-21',
        locations: [{ city: 'New York', region: 'NY', country: 'United States' }],
      },
      { slug: '1000heads', companyName: '1000heads' },
    );

    const enriched = mergeEngHiringVacancyDetail(vacancy!, `
# Senior Account Executive

> 1000heads · New York, United States (Hybrid) · Posted 2026-05-21

**Salary:** USD 60,000–70,000

## Description

Own B2B client communications and revenue expansion for enterprise accounts.
`);

    expect(enriched).toMatchObject({
      source: 'workable',
      source_company_slug: '1000heads',
      source_job_id: 'ED7ABE3F68',
      company_name: '1000heads',
      vacancy_title: 'Senior Account Executive',
      vacancy_description: expect.stringContaining('Own B2B client communications'),
      salary_from: 60000,
      salary_to: 70000,
      salary_currency: 'USD',
      country_code: 'us',
    });
  });

  it('normalizes BambooHR list jobs and merges detail payloads', () => {
    const vacancy = normalizeAtsJobToEngVacancy(
      'bamboohr',
      {
        id: '52',
        jobOpeningName: 'Enterprise Sales Manager',
        location: { city: 'Austin', state: 'TX' },
        atsLocation: { country: 'United States' },
      },
      { slug: 'acme', companyName: 'Acme Inc' },
    );

    const enriched = mergeEngHiringVacancyDetail(vacancy!, {
      result: {
        jobOpening: {
          description: '<p>Lead enterprise sales for US B2B customers.</p><p>Base salary: $110,000 - $150,000 USD.</p>',
          compensation: '$110,000 - $150,000 USD',
          datePosted: '2026-06-01T00:00:00.000Z',
        },
      },
    });

    expect(enriched).toMatchObject({
      source: 'bamboohr',
      source_job_id: '52',
      vacancy_url: 'https://acme.bamboohr.com/careers/52',
      vacancy_description: 'Lead enterprise sales for US B2B customers. Base salary: $110,000 - $150,000 USD.',
      salary_from: 110000,
      salary_to: 150000,
      salary_currency: 'USD',
      country_code: 'us',
    });
  });

  it('normalizes Recruitee offers with description and salary fields', () => {
    const vacancy = normalizeAtsJobToEngVacancy(
      'recruitee',
      {
        id: 137,
        title: 'Account Executive',
        company_name: '12Build',
        careers_url: 'https://12build.recruitee.com/o/account-executive',
        published_at: '2026-06-05 13:30:25 UTC',
        location: 'New York, NY, United States',
        country: 'United States',
        description: '<p>Sell SaaS to B2B construction customers.</p>',
        salary: { min: 90000, max: 130000, currency: 'USD' },
      },
      { slug: '12build', companyName: '12Build' },
    );

    expect(vacancy).toMatchObject({
      source: 'recruitee',
      source_job_id: '137',
      company_name: '12Build',
      vacancy_title: 'Account Executive',
      vacancy_description: 'Sell SaaS to B2B construction customers.',
      salary_from: 90000,
      salary_to: 130000,
      salary_currency: 'USD',
      country_code: 'us',
    });
  });
});

describe('engHiring cache filtering', () => {
  const base: EngHiringVacancy = {
    source: 'greenhouse',
    source_company_slug: 'acme',
    source_job_id: 'job-1',
    company_name: 'Acme',
    company_site_url: 'https://acme.com',
    company_description: null,
    vacancy_title: 'Demand Generation Manager',
    vacancy_url: 'https://acme.com/jobs/1',
    careers_url: 'https://job-boards.greenhouse.io/acme',
    location: 'New York, NY',
    city: 'New York',
    country: 'United States',
    country_code: 'us',
    salary_from: null,
    salary_to: null,
    salary_currency: null,
    vacancy_description: null,
    published_at: '2026-06-01T00:00:00.000Z',
    raw: {},
  };

  it('filters cached vacancies by role, source, country, and recency', () => {
    const config: EngHiringSearchConfig = {
      text: 'demand generation, account executive',
      sources: ['greenhouse'],
      countries: ['us'],
      posted_within_days: 30,
      now: '2026-06-11T00:00:00.000Z',
    };

    expect(matchesEngHiringVacancy(base, config)).toBe(true);
    expect(matchesEngHiringVacancy({ ...base, vacancy_title: 'Backend Engineer' }, config)).toBe(false);
    expect(matchesEngHiringVacancy({ ...base, source: 'lever' }, config)).toBe(false);
    expect(matchesEngHiringVacancy({ ...base, country_code: 'gb', location: 'London' }, config)).toBe(false);
    expect(matchesEngHiringVacancy({ ...base, published_at: '2026-04-01T00:00:00.000Z' }, config)).toBe(false);
  });

  it('matches role keywords in vacancy descriptions after detail enrichment', () => {
    const config: EngHiringSearchConfig = {
      text: 'enterprise sales',
      sources: ['greenhouse'],
      countries: ['us'],
      posted_within_days: 30,
      now: '2026-06-11T00:00:00.000Z',
    };

    expect(matchesEngHiringVacancy({
      ...base,
      vacancy_title: 'Account Executive',
      vacancy_description: 'Own the enterprise sales motion for B2B customers.',
    }, config)).toBe(true);
  });

  it('deduplicates vacancies by source and source_job_id', () => {
    const rows = dedupeEngHiringVacancies([
      base,
      { ...base, vacancy_title: 'Demand Generation Manager duplicate' },
      { ...base, source_job_id: 'job-2', vacancy_title: 'Account Executive' },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.source_job_id)).toEqual(['job-1', 'job-2']);
  });
});
