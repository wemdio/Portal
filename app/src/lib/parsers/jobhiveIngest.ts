// jobhive bulk-feed ingest helpers (pure, unit-tested). The jobhive feed
// (storage.stapply.ai/jobhive/v1, MIT) is a daily-regenerated catalog of ~4.3M
// postings across 47 ATS platforms — including enterprise ATS (iCIMS, Oracle,
// Phenom, SuccessFactors…) whose closed APIs we cannot fetch ourselves. It carries
// a clean company NAME but no corporate domain; the domain is recovered downstream
// by the PDL resolver during the normal run's enrich pass.
//
// These helpers are the deterministic core of the out-of-band ingest worker
// (worker/jobhiveIngestCron.ts): build the DuckDB scan SQL, map a feed row to an
// eng_hiring_cache row, and pre-dedup to one freshest posting per (company, country)
// so the cache stays lean and the existing run can query+filter+dedup+enrich it like
// any native source. All country / title / html / json-sanitize logic is REUSED from
// engHiring.ts so jobhive rows are treated identically to natively-fetched ones.

import { cleanHtml, inferCountryCode, isHighIntentB2BSalesTitle, stripUnstorableJsonChars, type EngHiringSource } from '@/lib/parsers/engHiring';
import { companyDedupKey } from '@/lib/jobs/atsCompanyParser';

/** Remote Parquet the ingest streams via DuckDB httpfs (override per-env for testing/mirrors). */
export const JOBHIVE_FEED_URL = process.env.JOBHIVE_FEED_URL || 'https://storage.stapply.ai/jobhive/v1/all.parquet';

// Column-pruned scan set (the feed has 22 columns; we never pull the heavy `raw`
// blob at scan time). Keep in sync with mapJobhiveRowToCacheRow's reads.
export const JOBHIVE_SELECT_COLUMNS = [
  'company',
  'title',
  'location',
  'country_iso',
  'posted_at',
  'ats_type',
  'ats_id',
  'salary_min',
  'salary_max',
  'salary_currency',
  'description',
  'url',
  'apply_url',
  'is_remote',
] as const;

// Coarse, deliberately-broad title prefilter pushed into DuckDB to cut 4.3M rows down
// to a sales-ish subset before Node applies the EXACT isHighIntentB2BSalesTitle filter.
// Recall-biased: better to over-include here and let the precise JS filter trim.
const JOBHIVE_COARSE_SALES_TERMS = [
  '%sales%',
  '%account exec%',
  '%account manager%',
  '%business development%',
  '%revenue%',
  '%partnership%',
  '%commercial%',
  '%client partner%',
  '%go-to-market%',
  '%go to market%',
  '% sdr %',
  '% bdr %',
  '% ae %',
];

export interface JobhiveRow {
  company?: string | null;
  title?: string | null;
  location?: string | null;
  country_iso?: string | null;
  posted_at?: string | null;
  ats_type?: string | null;
  ats_id?: string | null;
  salary_min?: string | number | null;
  salary_max?: string | number | null;
  salary_currency?: string | null;
  description?: string | null;
  url?: string | null;
  apply_url?: string | null;
  is_remote?: string | boolean | null;
}

export interface JobhiveCacheRow {
  source: EngHiringSource;
  source_company_slug: string;
  source_job_id: string;
  company_name: string;
  vacancy_title: string;
  vacancy_url: string;
  vacancy_description: string | null;
  company_site_url: string | null;
  company_description: string | null;
  careers_url: string | null;
  location: string | null;
  city: string | null;
  country: string | null;
  country_code: string | null;
  salary_from: number | null;
  salary_to: number | null;
  salary_currency: string | null;
  published_at: string | null;
  raw: Record<string, unknown>;
}

/** Build the DuckDB SELECT that streams + prunes + coarse-filters + coarse-dedups the
 *  remote feed. The coarse server-side dedup (one freshest posting per exact company +
 *  country) shrinks the export ~10x so the CLI can read it without blowing memory; Node
 *  then folds legal-suffix name variants and recovers blank countries from location.
 *  `limit` (positive int) caps the export for --dry-run rehearsals; anything else throws
 *  so a bad knob never turns into an unbounded 4.3M-row scan. */
export function buildJobhiveDuckdbSql(opts: { parquetUrl: string; cutoffIso: string; limit?: number | null }): string {
  if (opts.limit != null && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    throw new Error(`jobhive scan limit must be a positive integer, got ${opts.limit}`);
  }
  const scanCols = JOBHIVE_SELECT_COLUMNS
    .map((col) => (col === 'description' ? 'substr(description, 1, 2000) AS description' : col))
    .join(', ');
  const salesLike = JOBHIVE_COARSE_SALES_TERMS.map((term) => `lower(title) LIKE '${term}'`).join(' OR ');
  return [
    `SELECT ${scanCols}`,
    `FROM read_parquet('${opts.parquetUrl}')`,
    `WHERE posted_at >= TIMESTAMPTZ '${opts.cutoffIso}'`,
    `  AND title IS NOT NULL`,
    `  AND (${salesLike})`,
    `QUALIFY row_number() OVER (`,
    `  PARTITION BY lower(trim(company)), coalesce(country_iso, '')`,
    `  ORDER BY posted_at DESC NULLS LAST`,
    `) = 1`,
    ...(opts.limit != null ? [`LIMIT ${opts.limit}`] : []),
  ].join('\n');
}

/** Parse the JOBHIVE_LIMIT rehearsal cap. Throws on garbage: silently ignoring a typo
 *  would turn a "quick rehearsal" into an unbounded 4.3M-row scan. */
export function parseJobhiveLimit(raw: string | undefined | null): number | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`JOBHIVE_LIMIT must be a positive integer, got ${JSON.stringify(s)}`);
  }
  return n;
}

function toIntOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : null;
}

function toIsoOrNull(value: unknown): string | null {
  if (value == null || value === '') return null;
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** ISO-2 country_iso is authoritative; fall back to the location gazetteer for the
 *  ~62% of rows the feed leaves blank. Returns null (never a US guess) when neither
 *  signal resolves — the run's strict country filter then drops the row. */
function countryCodeFor(row: JobhiveRow): string | null {
  const iso = String(row.country_iso ?? '').trim();
  if (/^[a-z]{2}$/i.test(iso)) return iso.toLowerCase();
  return inferCountryCode(row.location, null);
}

/** Map one feed row to an eng_hiring_cache row, or null if it can't satisfy the
 *  NOT NULL columns (company_name / vacancy_title / vacancy_url). */
export function mapJobhiveRowToCacheRow(row: JobhiveRow): JobhiveCacheRow | null {
  const company_name = String(row.company ?? '').trim();
  if (!company_name) return null;
  const vacancy_title = String(row.title ?? '').trim();
  if (!vacancy_title) return null;
  const vacancy_url = String(row.url ?? '').trim() || String(row.apply_url ?? '').trim();
  if (!vacancy_url) return null;

  const country_code = countryCodeFor(row);
  const companyKey = companyDedupKey(company_name);
  const atsType = String(row.ats_type ?? '').trim().toLowerCase();
  const atsId = String(row.ats_id ?? '').trim();

  const mapped: JobhiveCacheRow = {
    source: 'jobhive',
    // unique enough per company after pre-dedup; used by the enrich write-back filter.
    source_company_slug: atsType && atsId ? `${atsType}:${atsId}` : companyKey || vacancy_url,
    // stable per (company, country) so nightly re-ingests UPSERT instead of duplicating.
    source_job_id: `jh:${companyKey || vacancy_url}:${country_code ?? 'xx'}`,
    company_name,
    vacancy_title,
    vacancy_url,
    vacancy_description: cleanHtml(row.description) || null,
    company_site_url: null,
    company_description: null,
    careers_url: null,
    location: String(row.location ?? '').trim() || null,
    city: null,
    country: null,
    country_code,
    salary_from: toIntOrNull(row.salary_min),
    salary_to: toIntOrNull(row.salary_max),
    salary_currency: String(row.salary_currency ?? '').trim() || null,
    published_at: toIsoOrNull(row.posted_at),
    raw: { ...row },
  };
  // Strip NUL / lone surrogates so the jsonb `raw` (and text columns) never trip
  // Postgres' "invalid input syntax for type json".
  return stripUnstorableJsonChars(mapped);
}

function rowFreshnessRank(row: JobhiveRow): number {
  const ms = Date.parse(String(row.posted_at ?? ''));
  const fresh = Number.isNaN(ms) ? 0 : ms;
  // Tiny tiebreak so that, among same-dated postings, an exact-match sales title wins.
  const strong = isHighIntentB2BSalesTitle(String(row.title ?? '')) ? 1 : 0;
  return fresh + strong;
}

/** Collapse the feed to one freshest posting per (normalized company, country). Keeps
 *  geographic variants of a same-named company apart (Momentum US vs ZA) so the run's
 *  country filter can later pick the right one. */
export function dedupeJobhiveRowsByCompanyCountry(rows: JobhiveRow[]): JobhiveRow[] {
  const best = new Map<string, JobhiveRow>();
  for (const row of rows) {
    const companyKey = companyDedupKey(String(row.company ?? ''));
    if (!companyKey) continue;
    const key = `${companyKey}:${countryCodeFor(row) ?? 'xx'}`;
    const existing = best.get(key);
    if (!existing || rowFreshnessRank(row) > rowFreshnessRank(existing)) best.set(key, row);
  }
  return [...best.values()];
}

export interface JobhivePipelineStats {
  /** Rows the DuckDB scan exported (after the SQL coarse filter + coarse dedup). */
  exported: number;
  /** Rows that passed the EXACT sales-title filter. */
  titleMatched: number;
  /** Rows after the per-(company, country) dedup. */
  deduped: number;
  /** Rows successfully mapped to eng_hiring_cache rows. */
  mapped: number;
  /** Deduped rows the mapper rejected (NOT NULL columns unsatisfiable) — would be skipped. */
  unmappable: number;
  /** The mapped cache rows (what the real run would upsert). */
  cacheRows: JobhiveCacheRow[];
}

/** The whole Node-side pipeline after the DuckDB scan: exact sales-title filter →
 *  per-(company, country) dedup → cache-row mapping. Pure (no I/O) so the real ingest
 *  and the --dry-run rehearsal share one code path and it stays unit-testable. */
export function processJobhiveRows(rawRows: JobhiveRow[]): JobhivePipelineStats {
  const titleMatched = rawRows.filter((row) => isHighIntentB2BSalesTitle(String(row.title ?? '')));
  const dedupedRows = dedupeJobhiveRowsByCompanyCountry(titleMatched);
  const cacheRows = dedupedRows
    .map(mapJobhiveRowToCacheRow)
    .filter((row): row is JobhiveCacheRow => row != null);
  return {
    exported: rawRows.length,
    titleMatched: titleMatched.length,
    deduped: dedupedRows.length,
    mapped: cacheRows.length,
    unmappable: dedupedRows.length - cacheRows.length,
    cacheRows,
  };
}

/** Human-readable dry-run report: the full funnel counts plus a few sample cache rows
 *  so the operator can eyeball what WOULD be upserted before the first real run. */
export function buildJobhiveDryRunReport(stats: JobhivePipelineStats, opts: { sampleSize?: number } = {}): string {
  const sampleSize = Math.max(0, opts.sampleSize ?? 5);
  const samples = stats.cacheRows.slice(0, sampleSize);
  return [
    'JOBHIVE DRY-RUN — no DB writes performed (scan + mapping rehearsal only)',
    `rows exported from feed: ${stats.exported}`,
    `passed exact sales-title filter: ${stats.titleMatched}`,
    `after company/country dedup: ${stats.deduped}`,
    `mapped to eng_hiring_cache rows: ${stats.mapped} (unmappable, would be skipped: ${stats.unmappable})`,
    `sample cache rows (first ${samples.length}):`,
    ...samples.map((row, i) =>
      `  ${i + 1}. ${row.company_name} | ${row.vacancy_title} | ${row.country_code ?? '??'} | ${row.vacancy_url}`),
  ].join('\n');
}
