/** @jest-environment node */

import {
  JOBHIVE_FEED_URL,
  buildJobhiveDuckdbSql,
  mapJobhiveRowToCacheRow,
  dedupeJobhiveRowsByCompanyCountry,
  type JobhiveRow,
} from '@/lib/parsers/jobhiveIngest';

const NUL = String.fromCharCode(0);
const LONE_SURROGATE = String.fromCharCode(0xd800);

function row(overrides: Partial<JobhiveRow> = {}): JobhiveRow {
  return {
    company: 'Datadog',
    title: 'Enterprise Account Executive',
    location: 'New York, NY',
    country_iso: 'US',
    posted_at: '2026-06-20T00:00:00Z',
    ats_type: 'greenhouse',
    ats_id: 'datadog-123',
    salary_min: '90000.0',
    salary_max: '120000',
    salary_currency: 'USD',
    description: '<p>Sell&nbsp;stuff to teams.</p>',
    url: 'https://boards.greenhouse.io/datadog/jobs/123',
    apply_url: '',
    is_remote: 'false',
    ...overrides,
  };
}

describe('buildJobhiveDuckdbSql', () => {
  const sql = buildJobhiveDuckdbSql({ parquetUrl: JOBHIVE_FEED_URL, cutoffIso: '2026-03-26T00:00:00.000Z' });

  it('reads the remote parquet feed', () => {
    expect(sql).toContain(`read_parquet('${JOBHIVE_FEED_URL}')`);
  });

  it('prunes to only the columns the ingest needs (not SELECT *)', () => {
    expect(sql).not.toContain('SELECT *');
    for (const col of ['company', 'title', 'location', 'country_iso', 'posted_at', 'ats_type', 'ats_id', 'url']) {
      expect(sql).toContain(col);
    }
    // a heavy column we do NOT pull at scan time
    expect(sql).not.toMatch(/\braw\b/);
  });

  it('filters by recency cutoff on posted_at', () => {
    expect(sql).toContain('posted_at');
    expect(sql).toContain('2026-03-26T00:00:00.000Z');
  });

  it('coarse-filters to sales-ish titles in SQL (the exact filter runs in Node)', () => {
    expect(sql.toLowerCase()).toContain("like '%sales%'");
    expect(sql.toLowerCase()).toContain('lower(title)');
  });

  it('coarse-dedups server-side to one freshest posting per company+country', () => {
    expect(sql.toLowerCase()).toContain('row_number() over');
    expect(sql.toLowerCase()).toContain('partition by');
    expect(sql.toLowerCase()).toContain('order by posted_at desc');
  });

  it('bounds the stored description length to keep the export small', () => {
    expect(sql).toContain('substr(description, 1, 2000)');
  });
});

describe('mapJobhiveRowToCacheRow', () => {
  it('maps a clean US row to a jobhive cache row', () => {
    const r = mapJobhiveRowToCacheRow(row())!;
    expect(r).not.toBeNull();
    expect(r.source).toBe('jobhive');
    expect(r.company_name).toBe('Datadog');
    expect(r.vacancy_title).toBe('Enterprise Account Executive');
    expect(r.vacancy_url).toBe('https://boards.greenhouse.io/datadog/jobs/123');
    expect(r.source_company_slug).toBe('greenhouse:datadog-123');
    expect(r.country_code).toBe('us');
    expect(r.published_at).toBe('2026-06-20T00:00:00.000Z');
  });

  it('lowercases country_iso into country_code', () => {
    expect(mapJobhiveRowToCacheRow(row({ country_iso: 'DE', location: 'Berlin' }))!.country_code).toBe('de');
  });

  it('falls back to inferCountryCode(location) when country_iso is empty', () => {
    expect(mapJobhiveRowToCacheRow(row({ country_iso: '', location: 'Austin, TX' }))!.country_code).toBe('us');
    expect(mapJobhiveRowToCacheRow(row({ country_iso: null, location: 'Berlin, Germany' }))!.country_code).toBe('de');
  });

  it('leaves country_code null when neither country_iso nor location resolves (no US contamination)', () => {
    expect(mapJobhiveRowToCacheRow(row({ country_iso: '', location: 'Somewhere Unknown' }))!.country_code).toBeNull();
  });

  it('coerces salary floats/strings to integers, null on garbage', () => {
    const r = mapJobhiveRowToCacheRow(row())!;
    expect(r.salary_from).toBe(90000);
    expect(r.salary_to).toBe(120000);
    expect(mapJobhiveRowToCacheRow(row({ salary_min: 'competitive', salary_max: null }))!.salary_from).toBeNull();
  });

  it('cleans the HTML description (decodes entities, strips tags)', () => {
    const r = mapJobhiveRowToCacheRow(row())!;
    expect(r.vacancy_description).not.toContain('<p>');
    expect(r.vacancy_description).not.toContain('&nbsp;');
    expect(r.vacancy_description).toContain('Sell');
    expect(r.vacancy_description).toContain('teams');
  });

  it('strips unstorable JSON chars (NUL) so the jsonb upsert cannot fail', () => {
    const r = mapJobhiveRowToCacheRow(row({ company: `Ac${NUL}me`, description: `a${NUL}b${LONE_SURROGATE}c` }))!;
    expect(r.company_name).toBe('Acme');
    expect(r.vacancy_description ?? '').not.toContain(NUL);
    expect(r.vacancy_description ?? '').not.toContain(LONE_SURROGATE);
  });

  it('uses apply_url when the primary url is missing', () => {
    const r = mapJobhiveRowToCacheRow(row({ url: '', apply_url: 'https://apply.example/x' }))!;
    expect(r.vacancy_url).toBe('https://apply.example/x');
  });

  it('returns null when company name is blank (NOT NULL column) — row is skipped', () => {
    expect(mapJobhiveRowToCacheRow(row({ company: '   ' }))).toBeNull();
  });

  it('returns null when there is no usable vacancy url (NOT NULL column)', () => {
    expect(mapJobhiveRowToCacheRow(row({ url: '', apply_url: '' }))).toBeNull();
  });

  it('builds a stable per-company-per-country source_job_id (idempotent re-ingest)', () => {
    const a = mapJobhiveRowToCacheRow(row({ ats_id: 'datadog-1' }))!;
    const b = mapJobhiveRowToCacheRow(row({ ats_id: 'datadog-2' }))!; // different posting, same company+country
    expect(a.source_job_id).toBe(b.source_job_id); // stable -> ON CONFLICT updates, no dup
    const de = mapJobhiveRowToCacheRow(row({ country_iso: 'DE' }))!;
    expect(de.source_job_id).not.toBe(a.source_job_id); // different country -> different row
  });
});

describe('dedupeJobhiveRowsByCompanyCountry', () => {
  it('keeps one freshest row per (company, country)', () => {
    const rows = [
      row({ company: 'Datadog', country_iso: 'US', posted_at: '2026-06-20T00:00:00Z', ats_id: 'a' }),
      row({ company: 'Datadog', country_iso: 'US', posted_at: '2026-06-22T00:00:00Z', ats_id: 'b' }),
    ];
    const out = dedupeJobhiveRowsByCompanyCountry(rows);
    expect(out).toHaveLength(1);
    expect(out[0].ats_id).toBe('b'); // the fresher posting wins
  });

  it('preserves geographic variants of the same company (US vs ZA are not collapsed)', () => {
    const rows = [
      row({ company: 'Momentum', country_iso: 'US', ats_id: 'us1' }),
      row({ company: 'Momentum', country_iso: 'ZA', ats_id: 'za1' }),
    ];
    expect(dedupeJobhiveRowsByCompanyCountry(rows)).toHaveLength(2);
  });

  it('folds legal-suffix variants of the same company name', () => {
    const rows = [
      row({ company: 'Datadog', country_iso: 'US', ats_id: 'a' }),
      row({ company: 'Datadog, Inc.', country_iso: 'US', ats_id: 'b' }),
    ];
    expect(dedupeJobhiveRowsByCompanyCountry(rows)).toHaveLength(1);
  });

  it('drops rows with no usable company name', () => {
    expect(dedupeJobhiveRowsByCompanyCountry([row({ company: '  ' })])).toHaveLength(0);
  });
});
