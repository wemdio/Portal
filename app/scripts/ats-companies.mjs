#!/usr/bin/env node

// Build EU/US company leads from ATS boards (Greenhouse / Lever / Ashby).
//
// This is the English-language counterpart to the HH fleet scripts: an open
// role is the buying signal, the hiring company is the lead. Unlike Adzuna,
// ATS boards are first-party, so we get the careers URL directly and enrich the
// real domain (so the output feeds the email pipeline like HH's site_url does).
//
// Company-token lists come from the open-source kalil0321/ats-scrapers dataset
// (MIT), fetched live from raw GitHub. Domain enrichment uses Clearbit's free
// autocomplete endpoint (no key).
//
// Examples:
//   node scripts/ats-companies.mjs --companies-limit=150
//   node scripts/ats-companies.mjs --ats=greenhouse,lever --companies-limit=0   # all companies
//   node scripts/ats-companies.mjs --match="fleet|logistics|driver" --no-enrich
//   node scripts/ats-companies.mjs --shuffle --companies-limit=300 --out=out/ats.csv

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import parser from '../src/lib/jobs/atsCompanyParser.js';

const execFileP = promisify(execFile);

const {
  SUPPORTED_ATS,
  buildCompanyLeads,
  domainFromJobUrls,
  exportCompanyLeadsToCsv,
  extractJobs,
  normalizeJob,
  parseCompanyCsv,
  pickDomainFromSuggestions,
  postingsUrl,
} = parser;

const UA = 'PortalAtsCompanyParser/1.0 (sergey@wemd.io)';
const TOKENS_BASE = 'https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies';
const CLEARBIT_SUGGEST = 'https://autocomplete.clearbit.com/v1/companies/suggest';
const REQUEST_TIMEOUT_MS = 15000; // per-request cap so one hung board can't stall the whole run

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, ...valueParts] = arg.slice(2).split('=');
    args[key] = valueParts.join('=') || 'true';
  }
  return args;
}

function splitList(value, fallback) {
  if (!value) return fallback;
  return String(value)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function intArg(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function boolArg(value, fallback) {
  if (value === undefined) return fallback;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fisher–Yates; only used when --shuffle is passed.
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Clearbit's autocomplete WAF (CloudFront) blocks node/undici by TLS fingerprint
// but lets curl through, so we shell out. curl ships on dev + the Linux prod box.
async function clearbitDomain(name, retries = 1) {
  const url = `${CLEARBIT_SUGGEST}?query=${encodeURIComponent(name)}`;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const { stdout } = await execFileP('curl', ['-sS', '--max-time', '15', '-H', 'Accept: application/json', url], {
        timeout: 20000,
        maxBuffer: 1024 * 1024,
      });
      const domain = pickDomainFromSuggestions(name, JSON.parse(stdout));
      if (domain) return domain;
    } catch {
      // transient curl/parse failure — retry below
    }
    if (attempt < retries) await sleep(400);
  }
  return '';
}

async function loadCompanies(ats, base) {
  const text = await fetchText(`${base}/${ats}.csv`);
  return parseCompanyCsv(text);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const atsList = splitList(args.ats, SUPPORTED_ATS).filter((a) => SUPPORTED_ATS.includes(a));
  if (atsList.length === 0) {
    throw new Error(`No valid --ats given. Supported: ${SUPPORTED_ATS.join(', ')}`);
  }

  const companiesLimit = intArg(args['companies-limit'], 200); // 0 = all (heavy!)
  const delayMs = intArg(args['delay-ms'], 150);
  const enrich = boolArg(args.enrich, true);
  const enrichLimit = intArg(args['enrich-limit'], 600);
  const enrichDelayMs = intArg(args['enrich-delay-ms'], 200);
  const doShuffle = boolArg(args.shuffle, false);
  const base = args['tokens-base'] || TOKENS_BASE;
  const matchRe = args.match ? new RegExp(args.match, 'i') : null;

  const defaultOut = path.join('out', `ats-companies-${new Date().toISOString().slice(0, 10)}.csv`);
  const outPath = path.resolve(args.out || defaultOut);

  console.log(`ATS: ${atsList.join(', ')}`);
  console.log(`Companies per ATS: ${companiesLimit === 0 ? 'ALL (heavy)' : companiesLimit}${doShuffle ? ' (shuffled)' : ' (alphabetical head)'}`);
  console.log(`Role filter: ${matchRe ? matchRe.source : 'shared marketing/B2B-sales taxonomy'}`);
  console.log(`Domain enrichment: ${enrich ? `on (cap ${enrichLimit})` : 'off'}\n`);

  const jobs = [];
  const stats = {};

  for (const ats of atsList) {
    process.stdout.write(`[${ats}] loading company list... `);
    let companies = await loadCompanies(ats, base);
    process.stdout.write(`${companies.length} companies\n`);
    if (doShuffle) shuffle(companies);
    if (companiesLimit > 0) companies = companies.slice(0, companiesLimit);

    let ok = 0;
    let errors = 0;
    let matched = 0;
    for (let i = 0; i < companies.length; i += 1) {
      const company = companies[i];
      try {
        const payload = await fetchJson(postingsUrl(ats, company.slug));
        for (const raw of extractJobs(ats, payload)) {
          const job = normalizeJob(ats, raw, { slug: company.slug, companyName: company.name });
          if (!job) continue;
          const keep = matchRe ? matchRe.test(job.title) : job.roles.length > 0;
          if (keep) {
            jobs.push(job);
            matched += 1;
          }
        }
        ok += 1;
      } catch {
        errors += 1; // company moved off this ATS, private board, or rate-limited
      }
      if ((i + 1) % 25 === 0 || i === companies.length - 1) {
        process.stdout.write(`  [${ats}] ${i + 1}/${companies.length} (ok ${ok}, err ${errors}, signal jobs ${matched})\n`);
      }
      await sleep(delayMs);
    }
    stats[ats] = { ok, errors, matched };
  }

  const leads = buildCompanyLeads(jobs);
  console.log(`\nCompanies with a matching role: ${leads.length} (from ${jobs.length} signal jobs)`);

  // 1) Free, network-free: domain straight from a custom careers host.
  let freeHits = 0;
  for (const lead of leads) {
    lead.domain = domainFromJobUrls(lead.job_urls);
    if (lead.domain) freeHits += 1;
  }
  console.log(`\nDomains from careers URLs (free): ${freeHits}/${leads.length}`);

  // 2) Clearbit (via curl) for leads still missing a domain.
  if (enrich) {
    const pending = leads.filter((lead) => !lead.domain);
    const cap = enrichLimit > 0 ? Math.min(pending.length, enrichLimit) : pending.length;
    console.log(`Enriching ${cap} more via Clearbit (curl)...`);
    const cache = new Map();
    let used = 0;
    let hits = 0;
    for (const lead of pending) {
      if (enrichLimit > 0 && used >= enrichLimit) break;
      const key = lead.company.toLowerCase();
      if (cache.has(key)) {
        lead.domain = cache.get(key);
        if (lead.domain) hits += 1;
        continue;
      }
      try {
        lead.domain = await clearbitDomain(lead.company);
      } catch {
        lead.domain = '';
      }
      if (lead.domain) hits += 1;
      cache.set(key, lead.domain);
      used += 1;
      await sleep(enrichDelayMs);
    }
    console.log(`  resolved ${hits}/${used} via Clearbit`);
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, '﻿' + exportCompanyLeadsToCsv(leads), 'utf8');

  console.log(`\nSaved ${leads.length} companies to ${outPath}`);
  for (const [ats, s] of Object.entries(stats)) {
    console.log(`  ${ats}: ${s.ok} boards ok, ${s.errors} errors, ${s.matched} signal jobs`);
  }
  console.log('\nTop leads:');
  for (const lead of leads.slice(0, 15)) {
    console.log(`  ${lead.company} [${lead.ats}] — ${lead.job_count} roles (${lead.roles_found.join('/') || '-'}) — ${lead.domain || 'no domain'}`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
