#!/usr/bin/env node
// Ingest SEC EDGAR Form D (US private-placement / funding events) from the DERA
// quarterly structured data sets into public.funded_companies (source='sec_formd').
// Form D is the best FREE, public-domain, large-volume US funding source.
//
// One row per ISSUER (deduped across filings by CIK, else normalized name).
// Amendments (D/A) RESTATE an offering's totals, so within an issuer we first
// collapse filings to the LATEST filing per offering (FILE_NUM), then:
//   total_funding_usd  = sum of latest TOTALAMOUNTSOLD across offerings
//   last_funding_*     = the most recent offering's amount/date/type
//   num_funding_rounds = number of distinct offerings
// Pooled investment funds are excluded by default (not operating-company leads);
// pass --include-funds to keep them.
//
// Form D has NO website and NO company description — enrich those afterwards from
// PDL via scripts/funded/enrich-sec-from-pdl.sql (optional).
//
// Run examples:
//   SEC_USER_AGENT="Studio Portal contact@yourstudio.com" \
//     node scripts/funded/ingest-sec-formd.mjs --quarters 2026q1 --dry-run
//   SEC_USER_AGENT="Studio Portal contact@yourstudio.com" \
//     node --env-file ../.env scripts/funded/ingest-sec-formd.mjs --quarters 2025q4,2026q1
//   node --env-file ../.env scripts/funded/ingest-sec-formd.mjs --dir ./tmp/2026Q1_d
//
// Flags: --quarters 2025q4,2026q1 | --dir <extracted folder> | --dry-run | --include-funds
// Env:   DATABASE_URL (main Postgres; not needed with --dry-run);
//        SEC_USER_AGENT (MANDATORY for downloads — SEC returns 403 without a
//        descriptive UA containing a contact email).

import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const includeFunds = !!args['include-funds'];
const dryRun = !!args['dry-run'];

const TAB = '\t';
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

function parseDollar(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || /indefinite/i.test(s)) return null;
  const n = Number(s.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function normName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(inc|llc|lp|ltd|limited|corp|corporation|co|company|gp|llp|plc|holdings|group|partners|fund|trust)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function yearOf(v) {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) && n >= 1800 && n <= 2100 ? n : null;
}

// Dates in the TSVs are usually ISO (YYYY-MM-DD) but older quarters contain other
// formats and junk — return a valid ISO date string or null (never garbage that
// would fail Postgres' date cast).
function isoDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s.replace(/-/g, ' '));
  if (Number.isFinite(t)) {
    const d = new Date(t);
    const y = d.getUTCFullYear();
    if (y >= 1900 && y <= 2100) return d.toISOString().slice(0, 10);
  }
  return null;
}

function truthy(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'true' || s === 'y' || s === '1' || s === 'yes';
}

async function fetchSecZip(quarter, destDir) {
  const ua = process.env.SEC_USER_AGENT;
  if (!ua) throw new Error('SEC_USER_AGENT env is required for downloads (e.g. "Studio Portal contact@yourstudio.com").');
  const url = `https://www.sec.gov/files/structureddata/data/form-d-data-sets/${quarter.toLowerCase()}_d.zip`;
  console.log(`Downloading ${url} ...`);
  const zipPath = join(destDir, `${quarter}.zip`);
  // sec.gov's CDN resets Node/undici TLS connections on large bodies; curl passes
  // cleanly (and ships with Windows 10+ and every Linux). curl first, fetch fallback.
  try {
    execFileSync('curl', ['-sSfL', '--retry', '3', '--max-time', '300', '-A', ua, '-o', zipPath, url], { stdio: 'inherit' });
  } catch (curlErr) {
    console.warn(`curl download failed (${curlErr.message}); falling back to fetch ...`);
    const res = await fetch(url, { headers: { 'User-Agent': ua } });
    if (!res.ok) throw new Error(`SEC download failed (${res.status}) for ${quarter}. Check SEC_USER_AGENT and that the quarter exists.`);
    writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  }
  const outDir = join(destDir, quarter);
  mkdirSync(outDir, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${outDir}' -Force`], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-o', zipPath, '-d', outDir], { stdio: 'inherit' });
  }
  return outDir;
}

function findTsv(dir, wanted) {
  const found = {};
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else {
        const up = basename(ent.name).toUpperCase();
        if (wanted.includes(up)) found[up] = full;
      }
    }
  };
  walk(dir);
  return found;
}

// SEC Form D TSVs are tab-delimited, UTF-8, header row, and UNQUOTED (fields may
// contain stray double-quotes). Plain split-on-tab is the correct parser — no CSV
// quote semantics — and keeps the script dependency-free.
function readTsv(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  if (lines.length < 2) return { header: [], rows: [] };
  const header = lines[0].split(TAB).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cells = lines[i].split(TAB);
    const row = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = cells[j];
    rows.push(row);
  }
  return { header, rows };
}

// Build one "filing" object per accession (primary issuer + submission + offering).
function buildFilings(dir) {
  const t = findTsv(dir, ['FORMDSUBMISSION.TSV', 'ISSUERS.TSV', 'OFFERING.TSV']);
  if (!t['FORMDSUBMISSION.TSV'] || !t['ISSUERS.TSV'] || !t['OFFERING.TSV']) {
    throw new Error(`Missing required TSVs in ${dir} (need FORMDSUBMISSION, ISSUERS, OFFERING).`);
  }
  const subT = readTsv(t['FORMDSUBMISSION.TSV']);
  const offT = readTsv(t['OFFERING.TSV']);
  const issT = readTsv(t['ISSUERS.TSV']);
  if (dryRun) {
    console.log(`  FORMDSUBMISSION columns: ${subT.header.join(', ')}`);
    console.log(`  OFFERING columns:        ${offT.header.slice(0, 14).join(', ')} ...`);
    console.log(`  ISSUERS columns:         ${issT.header.slice(0, 14).join(', ')} ...`);
  }

  const submissions = new Map();
  for (const s of subT.rows) submissions.set(s.ACCESSIONNUMBER, s);
  const offerings = new Map();
  for (const o of offT.rows) offerings.set(o.ACCESSIONNUMBER, o);

  const filings = [];
  for (const iss of issT.rows) {
    if (!truthy(iss.IS_PRIMARYISSUER_FLAG)) continue;
    const sub = submissions.get(iss.ACCESSIONNUMBER) || {};
    const off = offerings.get(iss.ACCESSIONNUMBER) || {};
    const isFund = truthy(off.ISPOOLEDINVESTMENTFUNDTYPE) || truthy(off.IS40ACT) ||
      String(off.INDUSTRYGROUPTYPE || '').toLowerCase().includes('pooled investment fund');
    if (isFund && !includeFunds) continue;

    const stateCode = String(iss.STATEORCOUNTRY || '').trim().toUpperCase();
    const isUs = US_STATES.has(stateCode);
    const country = isUs ? 'united states' : (iss.STATEORCOUNTRYDESCRIPTION ? String(iss.STATEORCOUNTRYDESCRIPTION).toLowerCase() : null);

    let lastType = 'reg_d';
    if (truthy(off.ISEQUITYTYPE)) lastType = 'equity';
    else if (truthy(off.ISDEBTTYPE)) lastType = 'debt';

    filings.push({
      accession: iss.ACCESSIONNUMBER,
      fileNum: String(sub.FILE_NUM || '').trim() || iss.ACCESSIONNUMBER, // offering id; amendments share it
      cik: String(iss.CIK || '').trim() || null,
      name: iss.ENTITYNAME,
      norm: normName(iss.ENTITYNAME),
      city: iss.CITY || null,
      region: isUs ? (iss.STATEORCOUNTRYDESCRIPTION || null) : null,
      country,
      founded: yearOf(iss.YEAROFINC_VALUE_ENTERED),
      industry: off.INDUSTRYGROUPTYPE ? String(off.INDUSTRYGROUPTYPE).toLowerCase() : null,
      filingDate: isoDate(sub.FILING_DATE),
      saleDate: isoDate(off.SALE_DATE),
      amountSold: parseDollar(off.TOTALAMOUNTSOLD),
      offeringAmount: parseDollar(off.TOTALOFFERINGAMOUNT),
      lastType,
      detail: {
        exemptions: off.FEDERALEXEMPTIONS_ITEMS_LIST || null,
        min_investment: parseDollar(off.MINIMUMINVESTMENTACCEPTED),
        entity_type: iss.ENTITYTYPE || null,
        jurisdiction: iss.JURISDICTIONOFINC || null,
        is_amendment: sub.SUBMISSIONTYPE === 'D/A' || truthy(off.ISAMENDMENT),
      },
    });
  }
  return filings;
}

// Collapse filings to one row per issuer (CIK, else normalized name).
// Within an issuer: latest filing per offering (FILE_NUM) — amendments restate
// totals, so only the newest filing of each offering counts.
function dedupeToCompanies(filings) {
  const byIssuer = new Map();
  for (const f of filings) {
    const key = f.cik ? `cik:${f.cik}` : `nm:${f.norm}`;
    if (key === 'nm:') continue;
    let arr = byIssuer.get(key);
    if (!arr) { arr = []; byIssuer.set(key, arr); }
    arr.push(f);
  }

  const rows = [];
  for (const [key, group] of byIssuer) {
    // newest first
    group.sort((a, b) => String(b.filingDate || '').localeCompare(String(a.filingDate || '')));
    // latest filing per offering
    const latestPerOffering = new Map();
    for (const f of group) {
      if (!latestPerOffering.has(f.fileNum)) latestPerOffering.set(f.fileNum, f);
    }
    const offeringsArr = Array.from(latestPerOffering.values());
    const latest = offeringsArr[0]; // group is sorted, so first seen = newest overall
    const cumulative = offeringsArr.reduce((s, g) => s + (g.amountSold || 0), 0) || null;
    const sourceUrl = latest.cik
      ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${latest.cik}&type=D&dateb=&owner=include&count=40`
      : null;
    rows.push({
      id: `secd:${key}`,
      source: 'sec_formd',
      name: latest.name,
      website: null,
      description: null,
      short_description: null,
      industry: latest.industry,
      country: latest.country,
      region: latest.region,
      locality: latest.city,
      founded: latest.founded,
      linkedin_url: null,
      total_funding_usd: cumulative,
      last_funding_usd: latest.amountSold,
      last_funding_type: latest.lastType,
      last_funding_date: latest.saleDate || latest.filingDate,
      num_funding_rounds: offeringsArr.length,
      investors: null,
      funding_detail: latest.detail,
      source_url: sourceUrl,
      batch: null,
      stage: null,
      team_size: null,
      tags: null,
    });
  }
  return rows;
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
    values.push(`(${COLS.map(() => `$${p++}`).join(',')})`);
    for (const col of COLS) {
      let v = r[col];
      if (col === 'funding_detail' && v != null) v = JSON.stringify(v);
      params.push(v ?? null);
    }
  }
  const updates = COLS.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ');
  await client.query(
    `insert into public.funded_companies (${COLS.join(',')}) values ${values.join(',')} ` +
    `on conflict (id) do update set ${updates}, updated_at = now()`,
    params,
  );
}

function dbSsl(url) {
  if (/sslmode=disable/i.test(url) || /localhost|127\.0\.0\.1/.test(url)) return false;
  return { rejectUnauthorized: false };
}

function fmtUsd(n) {
  return n == null ? '—' : `$${n.toLocaleString('en-US')}`;
}

async function main() {
  const dirs = [];
  if (args.dir) {
    dirs.push(args.dir);
  } else if (args.quarters) {
    const tmp = mkdtempSync(join(tmpdir(), 'formd-'));
    for (const q of String(args.quarters).split(',').map((s) => s.trim()).filter(Boolean)) {
      dirs.push(await fetchSecZip(q, tmp));
    }
  } else {
    console.error('Provide --quarters 2025q4,2026q1  or  --dir <extracted folder>. Add --dry-run to test without DB.');
    process.exit(1);
  }

  let allFilings = [];
  for (const d of dirs) {
    const f = buildFilings(d);
    console.log(`${d}: ${f.length} primary-issuer filings${includeFunds ? '' : ' (funds excluded)'}.`);
    allFilings = allFilings.concat(f);
  }
  const rows = dedupeToCompanies(allFilings).filter((r) => r.name);
  const withAmount = rows.filter((r) => r.last_funding_usd != null).length;
  console.log(`Deduped to ${rows.length} issuer companies (${withAmount} with a non-null sold amount).`);

  if (dryRun) {
    console.log('\n--dry-run: sample rows (no DB writes):');
    for (const r of rows.slice(0, 5)) {
      console.log(`  ${r.name} | ${r.locality ?? '—'}, ${r.region ?? r.country ?? '—'} | ${r.industry ?? '—'} | last: ${fmtUsd(r.last_funding_usd)} ${r.last_funding_type} @ ${r.last_funding_date ?? '—'} | total: ${fmtUsd(r.total_funding_usd)} | rounds: ${r.num_funding_rounds}`);
    }
    return;
  }

  const DB_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || process.env.POSTGRES_URL;
  if (!DB_URL) { console.error('Missing DATABASE_URL (or run with --dry-run).'); process.exit(1); }

  const client = new pg.Client({ connectionString: DB_URL, ssl: dbSsl(DB_URL) });
  await client.connect();
  try {
    const CHUNK = Math.max(50, Number(process.env.INGEST_CHUNK || 400));
    for (let i = 0; i < rows.length; i += CHUNK) {
      await upsertBatch(client, rows.slice(i, i + CHUNK));
      process.stdout.write(`\rUpserted ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
    }
    process.stdout.write('\n');
    const { rows: cnt } = await client.query("select count(*) c from public.funded_companies where source='sec_formd'");
    console.log(`Done. source='sec_formd' rows in table: ${cnt[0].c}.`);
    console.log('Tip: enrich website/industry from PDL via scripts/funded/enrich-sec-from-pdl.sql');
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
