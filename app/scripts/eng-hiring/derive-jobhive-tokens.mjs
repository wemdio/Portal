#!/usr/bin/env node
// Derive a BIGGER per-ATS company-token list from the jobhive aggregated jobs
// feed (stapply.ai, MIT). jobhive's static company CSVs are byte-identical to
// kalil0321 (no uplift) — the uplift comes from the LIVE jobs feed, which spans
// far more boards than the static list. We extract the DISTINCT board slug from
// each posting URL and emit `name,slug,url` CSVs in the same schema our parser
// already reads, so the merge infra (ENG_HIRING_TOKEN_BASES + mergeCompanyTokens)
// just layers them on top of the kalil0321 seed.
//
// DuckDB streams the remote parquet over HTTP and only reads the `url` column for
// the DISTINCT, so it never downloads the whole file into memory.
//
// PREREQS (run on prod 139 — the download is ~300MB of column chunks):
//   1) DuckDB CLI (single static binary, no deps):
//        curl -L https://github.com/duckdb/duckdb/releases/latest/download/duckdb_cli-linux-amd64.zip -o /tmp/duckdb.zip
//        unzip -o /tmp/duckdb.zip -d /usr/local/bin && chmod +x /usr/local/bin/duckdb
//   2) node scripts/eng-hiring/derive-jobhive-tokens.mjs
//   3) git add app/public/eng-hiring-tokens && commit + deploy
//   4) set ENG_HIRING_TOKEN_BASES (see README at the bottom).
//
// Re-run monthly to refresh (boards do not churn fast).

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, '..', '..', 'public', 'eng-hiring-tokens');
const FEED = 'https://storage.stapply.ai/jobhive/v1';

// slugRe: a DuckDB regexp capturing the board slug (group 1) from the posting URL.
// careers: SQL expression building the careers URL from `slug` (mirrors
// atsCompanyParser.careersUrl so the rows match the other sources).
const SOURCES = [
  { source: 'greenhouse',     slugRe: 'greenhouse\\.io/([^/?#]+)',     careers: "'https://job-boards.greenhouse.io/' || slug" },
  { source: 'lever',          slugRe: 'lever\\.co/([^/?#]+)',          careers: "'https://jobs.lever.co/' || slug" },
  { source: 'ashby',          slugRe: 'ashbyhq\\.com/([^/?#]+)',       careers: "'https://jobs.ashbyhq.com/' || slug" },
  { source: 'breezy',         slugRe: '://([^.]+)\\.breezy\\.hr',      careers: "'https://' || slug || '.breezy.hr'" },
  { source: 'bamboohr',       slugRe: '://([^.]+)\\.bamboohr\\.com',   careers: "'https://' || slug || '.bamboohr.com/careers'" },
  { source: 'smartrecruiters', slugRe: 'smartrecruiters\\.com/([^/?#]+)', careers: "'https://careers.smartrecruiters.com/' || slug" },
  { source: 'teamtailor',     slugRe: '://([^.]+)\\.teamtailor\\.com', careers: "'https://' || slug || '.teamtailor.com'" },
  // workable (apply.workable.com/j/{jobId}) and recruitee (custom domains) do not
  // expose the board slug in the posting URL — deferred.
];

// Non-slug path segments that the regexp can accidentally capture.
const NOISE_SLUGS = ['jobs', 'j', 'o', 'p', 'api', 'embed', 'widget'];

function deriveOne({ source, slugRe, careers }) {
  const noise = NOISE_SLUGS.map((s) => `'${s}'`).join(', ');
  const out = join(OUT_DIR, `${source}.csv`).replace(/\\/g, '/');
  const sql = `
    INSTALL httpfs; LOAD httpfs;
    COPY (
      SELECT DISTINCT slug AS name, slug, ${careers} AS url
      FROM (
        SELECT lower(regexp_extract(url, '${slugRe}', 1)) AS slug
        FROM read_parquet('${FEED}/${source}/jobs.parquet')
      )
      WHERE slug <> '' AND slug NOT IN (${noise}) AND length(slug) >= 2
      ORDER BY slug
    ) TO '${out}' (HEADER, DELIMITER ',', QUOTE '"');
  `;
  execFileSync('duckdb', ['-c', sql], { stdio: ['ignore', 'inherit', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
  const lines = existsSync(out) ? readFileSync(out, 'utf8').split(/\r?\n/).filter(Boolean).length - 1 : 0;
  return Math.max(0, lines);
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  let total = 0;
  for (const cfg of SOURCES) {
    process.stdout.write(`deriving ${cfg.source} … `);
    try {
      const n = deriveOne(cfg);
      total += n;
      console.log(`${n} companies`);
    } catch (err) {
      console.log(`FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\nDONE → ${OUT_DIR}\nTotal distinct companies across sources: ${total}`);
  console.log('Next: commit app/public/eng-hiring-tokens, deploy, and set ENG_HIRING_TOKEN_BASES.');
}

main();
