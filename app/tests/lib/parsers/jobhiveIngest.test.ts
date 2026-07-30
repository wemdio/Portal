/** @jest-environment node */

import {
  JOBHIVE_FEED_URL,
  buildJobhiveDuckdbSql,
  buildJobhiveDryRunReport,
  mapJobhiveRowToCacheRow,
  dedupeJobhiveRowsByCompanyCountry,
  parseJobhiveLimit,
  processJobhiveRows,
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

describe('buildJobhiveDuckdbSql limit option (rehearsal cap)', () => {
  const base = { parquetUrl: JOBHIVE_FEED_URL, cutoffIso: '2026-03-26T00:00:00.000Z' };

  it('omits LIMIT by default (full scan)', () => {
    expect(buildJobhiveDuckdbSql(base)).not.toMatch(/\bLIMIT\b/i);
  });

  it('appends LIMIT when a positive integer limit is given', () => {
    const sql = buildJobhiveDuckdbSql({ ...base, limit: 500 });
    expect(sql).toMatch(/LIMIT 500\s*$/);
  });

  it('rejects a non-positive / non-integer limit (fail fast, never silently scan 4M rows)', () => {
    for (const bad of [0, -5, 1.5, Number.NaN]) {
      expect(() => buildJobhiveDuckdbSql({ ...base, limit: bad })).toThrow(/limit/i);
    }
  });
});

describe('parseJobhiveLimit', () => {
  it('returns null when unset or blank', () => {
    expect(parseJobhiveLimit(undefined)).toBeNull();
    expect(parseJobhiveLimit(null)).toBeNull();
    expect(parseJobhiveLimit('')).toBeNull();
    expect(parseJobhiveLimit('   ')).toBeNull();
  });

  it('parses a positive integer cap', () => {
    expect(parseJobhiveLimit('2000')).toBe(2000);
  });

  it('throws on garbage so a typo never triggers an unbounded scan', () => {
    for (const bad of ['abc', '0', '-10', '2.5']) {
      expect(() => parseJobhiveLimit(bad)).toThrow(/JOBHIVE_LIMIT/);
    }
  });
});

describe('processJobhiveRows', () => {
  it('runs the exact title filter, dedup and mapping, returning full funnel stats', () => {
    const stats = processJobhiveRows([
      row({ ats_id: 'a', posted_at: '2026-06-20T00:00:00Z' }),
      row({ ats_id: 'b', posted_at: '2026-06-22T00:00:00Z' }), // fresher dup -> wins
      row({ title: 'Senior Software Engineer', ats_id: 'c' }), // not a sales title -> filtered
      row({ company: '', ats_id: 'd' }), // no company -> dropped in dedup
      row({ company: 'NoUrl Co', url: '', apply_url: '', ats_id: 'e' }), // unmappable (NOT NULL url)
    ]);
    expect(stats.exported).toBe(5);
    expect(stats.titleMatched).toBe(4); // everything but the engineer
    expect(stats.deduped).toBe(2); // Datadog (fresher posting) + NoUrl Co
    expect(stats.mapped).toBe(1);
    expect(stats.unmappable).toBe(1);
    expect(stats.cacheRows).toHaveLength(1);
    expect(stats.cacheRows[0].company_name).toBe('Datadog');
    expect(stats.cacheRows[0].raw.ats_id).toBe('b'); // the fresher posting survived
  });

  it('returns zeroed stats for an empty export', () => {
    const stats = processJobhiveRows([]);
    expect(stats).toMatchObject({ exported: 0, titleMatched: 0, deduped: 0, mapped: 0, unmappable: 0 });
    expect(stats.cacheRows).toEqual([]);
  });
});

describe('buildJobhiveDryRunReport', () => {
  it('states that no DB writes happened, prints the funnel counts and sample rows', () => {
    const stats = processJobhiveRows([
      row({ company: 'Alpha', ats_id: 'a1' }),
      row({ company: 'Beta', ats_id: 'b1' }),
      row({ title: 'Senior Software Engineer', ats_id: 'c1' }),
    ]);
    const report = buildJobhiveDryRunReport(stats);
    expect(report).toMatch(/dry-run/i);
    expect(report).toMatch(/no DB writes/i);
    expect(report).toContain('rows exported from feed: 3');
    expect(report).toContain('passed exact sales-title filter: 2');
    expect(report).toContain('after company/country dedup: 2');
    expect(report).toContain('mapped to eng_hiring_cache rows: 2');
    expect(report).toContain('unmappable');
    expect(report).toContain('Alpha');
    expect(report).toContain('Beta');
  });

  it('caps the sample section at 5 rows by default and honours sampleSize', () => {
    const stats = processJobhiveRows(
      Array.from({ length: 8 }, (_, i) => row({ company: `Co${i}`, ats_id: `id${i}` })),
    );
    const report = buildJobhiveDryRunReport(stats);
    expect(report).toContain('Co4');
    expect(report).not.toContain('Co5');
    const small = buildJobhiveDryRunReport(stats, { sampleSize: 2 });
    expect(small).toContain('Co1');
    expect(small).not.toContain('Co2');
  });
});
