#!/usr/bin/env node
// Daily SEC Form D poller — closes the quarterly-lag gap of ingest-sec-formd.mjs.
//
// The DERA bulk datasets are published once a quarter, so the freshest rounds in
// funded_companies are up to ~3 months stale. This script polls EDGAR full-text
// search (free, realtime: companies must file Form D within 15 days of first
// sale), fetches each new filing's primary_doc.xml, and upserts it into
// public.funded_companies (source='sec_formd', same id scheme as the bulk load).
//
// Idempotency: every processed accession is recorded in funded_sec_daily_log
// (migration 20260611_0001) and skipped on later runs, so overlapping windows
// never double-count. Merge semantics on existing issuers: last_funding_* is
// overwritten only by a NEWER filing; totals are additive for new offerings and
// conservative (greatest) for amendments. Exact totals are restated anyway at the
// next quarterly bulk re-run (run it with the FULL window, e.g. all quarters of
// the last 2 years — see README).
//
// Run examples:
//   SEC_USER_AGENT="Studio Portal contact@yourstudio.com" \
//     node scripts/funded/poll-sec-daily.mjs --since 2026-06-01 --dry-run --max 20
//   SEC_USER_AGENT="..." node --env-file ../.env scripts/funded/poll-sec-daily.mjs
//
// Flags: --since YYYY-MM-DD (default: 10 days ago) | --until YYYY-MM-DD (default today)
//        --dry-run (no DB writes; DB optional) | --max N (cap processed filings)
//        --include-funds (keep pooled investment funds)
// Env:   SEC_USER_AGENT (mandatory; descriptive UA with a contact email),
//        DATABASE_URL (main Postgres; optional with --dry-run).

import pg from 'pg';
import { execFileSync } from 'node:child_process';

const args = parseArgs(process.argv.slice(2));
const dryRun = !!args['dry-run'];
const includeFunds = !!args['include-funds'];
const maxFilings = args.max ? Math.max(1, Number(args.max)) : Infinity;

const UA = process.env.SEC_USER_AGENT;
if (!UA) { console.error('SEC_USER_AGENT env is required (descriptive UA with a contact email).'); process.exit(1); }

const RATE_MS = 160; // ~6 req/s, well under SEC's 10 req/s fair-access cap
const US_STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR'.split(' '));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; } else { out[key] = true; }
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isoDay(d) { return d.toISOString().slice(0, 10); }

function parseDollar(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || /indefinite/i.test(s)) return null;
  const n = Number(s.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function isoDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

// HTTP with the mandatory SEC UA. sec.gov's CDN sometimes resets undici
// connections, so: retry fetch with backoff, and use curl as an extra fallback
// where it exists (slim Node containers don't ship it).
let curlAvailable = null;
function hasCurl() {
  if (curlAvailable == null) {
    try { execFileSync('curl', ['--version'], { stdio: 'ignore' }); curlAvailable = true; }
    catch { curlAvailable = false; }
  }
  return curlAvailable;
}
async function httpGet(url) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) { lastErr = e; }
    if (hasCurl()) {
      try {
        return execFileSync('curl', ['-sSfL', '--retry', '2', '--max-time', '60', '-A', UA, url], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      } catch (e) { lastErr = e; }
    }
    await sleep(700 * attempt);
  }
  throw lastErr;
}

// ── EDGAR full-text search enumeration ──────────────────────────────────────
// Windows the [since..until] range into ≤14-day chunks (each query caps at
// 10,000 hits) and pages through with from= (10 hits per page).
async function listFilings(since, until) {
  const filings = new Map(); // accession -> { accession, doc, cik, fileDate, isAmendment }
  let chunkStart = new Date(since + 'T00:00:00Z');
  const end = new Date(until + 'T00:00:00Z');
  while (chunkStart <= end) {
    const chunkEnd = new Date(Math.min(end.getTime(), chunkStart.getTime() + 13 * 86400_000));
    const s = isoDay(chunkStart), e = isoDay(chunkEnd);
    let from = 0, total = Infinity;
    while (from < total && from < 9990) {
      const url = `https://efts.sec.gov/LATEST/search-index?q=&forms=D&startdt=${s}&enddt=${e}&from=${from}`;
      const j = JSON.parse(await httpGet(url));
      total = j?.hits?.total?.value ?? 0;
      const hits = j?.hits?.hits ?? [];
      if (!hits.length) break;
      for (const h of hits) {
        const [accession, doc] = String(h._id).split(':');
        const src = h._source ?? {};
        const cikRaw = Array.isArray(src.ciks) ? src.ciks[0] : src.ciks;
        if (!accession || !cikRaw) continue;
        filings.set(accession, {
          accession,
          doc: doc || 'primary_doc.xml',
          cik: String(Number(cikRaw)), // strip zero-padding to match the bulk TSV keys
          fileDate: isoDate(src.file_date),
          isAmendment: String(src.file_type ?? '').trim() === 'D/A',
        });
      }
      from += hits.length;
      await sleep(RATE_MS);
    }
    if (total > 9990) console.warn(`WARN: window ${s}..${e} has ${total} hits (>9990 cap) — narrow the chunk size.`);
    console.log(`  window ${s}..${e}: ${Math.min(total, 9990)} filings`);
    chunkStart = new Date(chunkEnd.getTime() + 86400_000);
  }
  return Array.from(filings.values());
}

// ── primary_doc.xml parsing (regex-scoped: flat fixed schema, no XML dep) ───
function block(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : '';
}
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return m ? m[1].trim() : null;
}
function tagAll(xml, name) {
  return Array.from(xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))).map((m) => m[1].trim());
}

function parseFormD(xml, meta) {
  if ((tag(xml, 'testOrLive') || 'LIVE').toUpperCase() !== 'LIVE') return null;
  const issuer = block(xml, 'primaryIssuer');
  const offering = block(xml, 'offeringData');
  if (!issuer || !offering) return null;

  const fundType = tag(block(offering, 'investmentFundInfo'), 'investmentFundType');
  const industry = tag(block(offering, 'industryGroup'), 'industryGroupType');
  const isFund = !!fundType || /pooled investment fund/i.test(industry || '');
  if (isFund && !includeFunds) return null;

  const addr = block(issuer, 'issuerAddress');
  const stateCode = (tag(addr, 'stateOrCountry') || '').toUpperCase();
  const stateDesc = tag(addr, 'stateOrCountryDescription');
  const isUs = US_STATES.has(stateCode);

  const sale = block(block(offering, 'typeOfFiling'), 'dateOfFirstSale');
  const saleDate = isoDate(tag(sale, 'value'));
  const amounts = block(offering, 'offeringSalesAmounts');
  const sold = parseDollar(tag(amounts, 'totalAmountSold'));
  const securities = block(offering, 'typesOfSecuritiesOffered');
  let lastType = 'reg_d';
  if ((tag(securities, 'isEquityType') || '') === 'true') lastType = 'equity';
  else if ((tag(securities, 'isDebtType') || '') === 'true') lastType = 'debt';

  const name = tag(issuer, 'entityName');
  if (!name) return null;
  const cik = String(Number(tag(issuer, 'cik') || meta.cik));

  return {
    id: `secd:cik:${cik}`,
    source: 'sec_formd',
    name,
    industry: industry ? industry.toLowerCase() : null,
    country: isUs ? 'united states' : (stateDesc ? stateDesc.toLowerCase() : null),
    region: isUs ? stateDesc : null,
    locality: tag(addr, 'city'),
    founded: (() => { const y = parseInt(tag(block(issuer, 'yearOfInc'), 'value') || '', 10); return Number.isFinite(y) && y >= 1800 && y <= 2100 ? y : null; })(),
    last_funding_usd: sold,
    last_funding_type: lastType,
    last_funding_date: saleDate || meta.fileDate,
    funding_detail: {
      exemptions: tagAll(block(offering, 'federalExemptionsExclusions'), 'item').join(',') || null,
      entity_type: tag(issuer, 'entityType'),
      jurisdiction: tag(issuer, 'jurisdictionOfInc'),
      is_amendment: meta.isAmendment || tag(block(block(offering, 'typeOfFiling'), 'newOrAmendment'), 'isAmendment') === 'true',
      accession: meta.accession,
      via: 'daily_poller',
    },
    source_url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=D&dateb=&owner=include&count=40`,
  };
}

// ── Upsert with merge semantics (newer wins for last_*, additive totals) ────
const UPSERT_SQL = `
insert into public.funded_companies
  (id, source, name, website, description, short_description, industry, country, region, locality,
   founded, linkedin_url, total_funding_usd, last_funding_usd, last_funding_type, last_funding_date,
   num_funding_rounds, investors, funding_detail, source_url, batch, stage, team_size, tags)
values ($1,'sec_formd',$2,null,null,null,$3,$4,$5,$6,$7,null,$8,$8,$9,$10,1,null,$11,$12,null,null,null,null)
on conflict (id) do update set
  name = excluded.name,
  industry = coalesce(excluded.industry, funded_companies.industry),
  country = coalesce(excluded.country, funded_companies.country),
  region = coalesce(excluded.region, funded_companies.region),
  locality = coalesce(excluded.locality, funded_companies.locality),
  founded = coalesce(excluded.founded, funded_companies.founded),
  total_funding_usd = case
    when (excluded.funding_detail->>'is_amendment')::boolean
      then greatest(coalesce(funded_companies.total_funding_usd, 0), coalesce(excluded.last_funding_usd, 0))
    else coalesce(funded_companies.total_funding_usd, 0) + coalesce(excluded.last_funding_usd, 0)
  end,
  num_funding_rounds = case
    when (excluded.funding_detail->>'is_amendment')::boolean then coalesce(funded_companies.num_funding_rounds, 1)
    else coalesce(funded_companies.num_funding_rounds, 0) + 1
  end,
  last_funding_usd = case when funded_companies.last_funding_date is null or excluded.last_funding_date >= funded_companies.last_funding_date
    then excluded.last_funding_usd else funded_companies.last_funding_usd end,
  last_funding_type = case when funded_companies.last_funding_date is null or excluded.last_funding_date >= funded_companies.last_funding_date
    then excluded.last_funding_type else funded_companies.last_funding_type end,
  funding_detail = case when funded_companies.last_funding_date is null or excluded.last_funding_date >= funded_companies.last_funding_date
    then excluded.funding_detail else funded_companies.funding_detail end,
  last_funding_date = case when funded_companies.last_funding_date is null or excluded.last_funding_date >= funded_companies.last_funding_date
    then excluded.last_funding_date else funded_companies.last_funding_date end,
  updated_at = now()
`;

function dbSsl(url) {
  if (/sslmode=disable/i.test(url) || /localhost|127\.0\.0\.1/.test(url)) return false;
  return { rejectUnauthorized: false };
}

async function main() {
  const today = isoDay(new Date());
  const since = isoDate(args.since) || isoDay(new Date(Date.now() - 10 * 86400_000));
  const until = isoDate(args.until) || today;
  console.log(`Polling EDGAR Form D filings ${since}..${until}${dryRun ? ' (dry-run)' : ''} ...`);

  const DB_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || process.env.POSTGRES_URL;
  let client = null;
  if (!dryRun) {
    if (!DB_URL) { console.error('Missing DATABASE_URL (or run with --dry-run).'); process.exit(1); }
    client = new pg.Client({ connectionString: DB_URL, ssl: dbSsl(DB_URL) });
    await client.connect();
  }

  let filings = await listFilings(since, until);
  console.log(`Enumerated ${filings.length} filings.`);

  if (client) {
    const { rows } = await client.query(
      'select accession from public.funded_sec_daily_log where accession = any($1)',
      [filings.map((f) => f.accession)],
    );
    const seen = new Set(rows.map((r) => r.accession));
    filings = filings.filter((f) => !seen.has(f.accession));
    console.log(`${filings.length} new after skipping already-processed.`);
  }
  if (filings.length > maxFilings) filings = filings.slice(0, maxFilings);

  let upserted = 0, skippedFunds = 0, errors = 0;
  for (let i = 0; i < filings.length; i++) {
    const f = filings[i];
    try {
      const accNoDash = f.accession.replace(/-/g, '');
      const xml = await httpGet(`https://www.sec.gov/Archives/edgar/data/${f.cik}/${accNoDash}/${f.doc}`);
      const row = parseFormD(xml, f);
      if (!row) { skippedFunds++; }
      else if (dryRun) {
        if (upserted < 10) console.log(`  ${row.name} | ${row.locality ?? '—'}, ${row.region ?? row.country ?? '—'} | ${row.last_funding_usd ? '$' + row.last_funding_usd.toLocaleString('en-US') : '—'} ${row.last_funding_type} @ ${row.last_funding_date}${row.funding_detail.is_amendment ? ' (D/A)' : ''}`);
        upserted++;
      } else {
        await client.query(UPSERT_SQL, [
          row.id, row.name, row.industry, row.country, row.region, row.locality, row.founded,
          row.last_funding_usd, row.last_funding_type, row.last_funding_date,
          JSON.stringify(row.funding_detail), row.source_url,
        ]);
        upserted++;
      }
      if (client && !dryRun) {
        await client.query(
          'insert into public.funded_sec_daily_log (accession, cik, filing_date) values ($1,$2,$3) on conflict do nothing',
          [f.accession, f.cik, f.fileDate],
        );
      }
    } catch (e) {
      errors++;
      if (errors <= 5) console.warn(`  WARN ${f.accession}: ${e.message}`);
    }
    if ((i + 1) % 200 === 0) console.log(`  ... ${i + 1}/${filings.length} processed (${upserted} upserted)`);
    await sleep(RATE_MS);
  }

  console.log(`Done. ${upserted} ${dryRun ? 'parsed' : 'upserted'}, ${skippedFunds} funds/non-live skipped, ${errors} errors.`);
  if (client && !dryRun && upserted > 0) {
    await client.query('analyze public.funded_companies');
    const { rows } = await client.query("select max(last_funding_date)::text mx, count(*)::int n from public.funded_companies where source='sec_formd'");
    console.log(`source='sec_formd': ${rows[0].n} companies, freshest round date: ${rows[0].mx}.`);
  }
  if (client) await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
