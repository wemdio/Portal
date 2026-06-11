#!/usr/bin/env node
// Ingest the Y Combinator companies catalog (yc-oss/api — unofficial public API)
// into public.funded_companies with source='yc'. Idempotent: upsert on id.
//
// Data: https://yc-oss.github.io/api/companies/all.json (one JSON array, ~6k cos,
// daily-refreshed, no auth/key/rate-limit). No funding fields exist in YC data —
// we opportunistically regex a "$NN million/billion" mention out of long_description
// into total_funding_usd as a SOFT signal (provenance kept in funding_detail).
//
// Run:  node --env-file ../.env scripts/funded/ingest-yc.mjs
//       node scripts/funded/ingest-yc.mjs --dry-run    (parse + report, no DB)
// Env:  DATABASE_URL (main Postgres; not needed with --dry-run).
//       Optional: YC_ALL_URL to override the source.

import pg from 'pg';

const ALL_URL = process.env.YC_ALL_URL || 'https://yc-oss.github.io/api/companies/all.json';
const dryRun = process.argv.includes('--dry-run');

// Normalize YC location/region strings to the lowercased country labels the rest
// of the catalog uses (matching PDL: 'united states', 'germany', ...).
const COUNTRY_FIX = new Map([
  ['united states of america', 'united states'],
  ['usa', 'united states'],
  ['us', 'united states'],
  ['uk', 'united kingdom'],
  ['great britain', 'united kingdom'],
]);
function normCountry(regions, allLocations) {
  const candidates = [];
  if (Array.isArray(regions)) candidates.push(...regions);
  if (allLocations) candidates.push(String(allLocations).split(',').pop());
  for (const raw of candidates) {
    if (!raw) continue;
    const c = String(raw).trim().toLowerCase();
    if (COUNTRY_FIX.has(c)) return COUNTRY_FIX.get(c);
    // Skip continent-ish region buckets like "america / canada".
    if (c.includes('/')) continue;
    if (c.length >= 3) return c;
  }
  return null;
}
function localityOf(allLocations) {
  if (!allLocations) return null;
  const first = String(allLocations).split(',')[0]?.trim();
  return first || null;
}

// Best-effort funding signal from prose: "raised $69 million", "$1.2B in funding".
const FUND_RE = /\$\s?([\d.,]+)\s?(billion|bn|b|million|mm|m|thousand|k)\b/gi;
function extractFundingUsd(text) {
  if (!text) return null;
  let max = 0;
  for (const m of String(text).matchAll(FUND_RE)) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    const unit = m[2].toLowerCase();
    const mult = unit.startsWith('b') ? 1e9 : unit.startsWith('th') || unit === 'k' ? 1e3 : 1e6;
    max = Math.max(max, Math.round(n * mult));
  }
  return max > 0 ? max : null;
}

function mapRow(c) {
  const fundingUsd = extractFundingUsd(c.long_description);
  return {
    id: `yc:${c.id}`,
    source: 'yc',
    name: c.name ?? null,
    website: c.website || null,
    description: c.long_description || null,
    short_description: c.one_liner || null,
    industry: c.industry ? String(c.industry).toLowerCase() : null,
    country: normCountry(c.regions, c.all_locations),
    region: null,
    locality: localityOf(c.all_locations),
    founded: null, // YC has no founding year (launched_at is the YC launch, not incorporation)
    linkedin_url: null,
    total_funding_usd: fundingUsd,
    last_funding_usd: null,
    last_funding_type: null, // not a real round — only a text mention
    last_funding_date: null,
    num_funding_rounds: null,
    investors: null,
    funding_detail: fundingUsd ? { funding_source: 'yc_long_description_regex', confidence: 'low' } : null,
    source_url: c.url || null,
    batch: c.batch || null,
    stage: c.stage || c.status || null,
    team_size: Number.isFinite(c.team_size) ? c.team_size : null,
    tags: Array.isArray(c.tags) ? c.tags : null,
  };
}

const COLS = [
  'id', 'source', 'name', 'website', 'description', 'short_description', 'industry', 'country', 'region',
  'locality', 'founded', 'linkedin_url', 'total_funding_usd', 'last_funding_usd', 'last_funding_type',
  'last_funding_date', 'num_funding_rounds', 'investors', 'funding_detail', 'source_url', 'batch', 'stage',
  'team_size', 'tags',
];

async function upsertBatch(client, rows) {
  if (!rows.length) return;
  const values = [];
  const params = [];
  let p = 1;
  for (const r of rows) {
    const ph = COLS.map(() => `$${p++}`);
    values.push(`(${ph.join(',')})`);
    for (const col of COLS) {
      let v = r[col];
      if (col === 'funding_detail' && v != null) v = JSON.stringify(v);
      params.push(v ?? null);
    }
  }
  const updates = COLS.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ');
  const sql =
    `insert into public.funded_companies (${COLS.join(',')}) values ${values.join(',')} ` +
    `on conflict (id) do update set ${updates}, updated_at = now()`;
  await client.query(sql, params);
}

async function main() {
  console.log(`Fetching ${ALL_URL} …`);
  const res = await fetch(ALL_URL, { headers: { 'User-Agent': 'Portal/funded-ingest (internal tool)' } });
  if (!res.ok) throw new Error(`YC fetch failed: ${res.status}`);
  const companies = await res.json();
  if (!Array.isArray(companies)) throw new Error('Unexpected YC payload (not an array)');
  console.log(`Got ${companies.length} YC companies.`);

  const rows = companies.map(mapRow).filter((r) => r.name);
  const withFunding = rows.filter((r) => r.total_funding_usd).length;
  const withSite = rows.filter((r) => r.website).length;
  const withDesc = rows.filter((r) => r.description).length;

  if (dryRun) {
    console.log(`--dry-run: ${rows.length} rows mapped | with website: ${withSite} | with description: ${withDesc} | with text-extracted funding: ${withFunding}`);
    for (const r of rows.slice(0, 5)) {
      console.log(`  ${r.name} | ${r.website ?? '—'} | ${r.batch ?? '—'} | ${r.country ?? '—'} | ${(r.short_description ?? '').slice(0, 60)}`);
    }
    return;
  }

  const DB_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || process.env.POSTGRES_URL;
  if (!DB_URL) {
    console.error('Missing DATABASE_URL (or SUPABASE_DB_URL / POSTGRES_URL). Or run with --dry-run.');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: DB_URL, ssl: dbSsl(DB_URL) });
  await client.connect();
  try {
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await upsertBatch(client, rows.slice(i, i + CHUNK));
      process.stdout.write(`\rUpserted ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
    }
    process.stdout.write('\n');
    const { rows: cnt } = await client.query("select count(*) c from public.funded_companies where source='yc'");
    console.log(`Done. source='yc' rows in table: ${cnt[0].c}. (${withFunding} had a text-extracted funding signal.)`);
  } finally {
    await client.end();
  }
}

function dbSsl(url) {
  // Local/compose Postgres usually needs no SSL; managed ones do. Mirror the
  // permissive setting used by the other ingest scripts.
  return /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
