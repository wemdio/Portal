/**
 * Test multiple email discovery methods on companies from XLSX.
 * Methods: 1) Website scrape  2) Hunter.io  3) Whois
 * Outputs combined XLSX for comparison.
 *
 * Usage: node scripts/test-methods.mjs "G:\Загрузки\test-200.xlsx" [limit]
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import https from 'https';
import http from 'http';
import { createRequire } from 'module';
import { execSync } from 'child_process';

const require = createRequire(resolve(import.meta.dirname, '..', 'app', 'node_modules', 'xlsx', 'package.json'));
const XLSX = require('xlsx');

// ── Load .env ──
for (const envFile of [resolve(import.meta.dirname, '..', '.env'), resolve(import.meta.dirname, '..', 'app', '.env')]) {
  try {
    for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {}
}

const HUNTER_API_KEY = process.env.HUNTER_API_KEY ?? '';

// ── HTTP helper ──
function httpGet(url, timeout = 10000) {
  const mod = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(url, {
      timeout,
      rejectUnauthorized: false,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/json,*/*',
        'Accept-Language': 'ru-RU,ru;q=0.9',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGet(res.headers.location, timeout).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ══════════════════════════════════════════════════════════
// METHOD 1: Website scraping — extract emails from HTML
// ══════════════════════════════════════════════════════════
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const IGNORE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'css', 'js', 'woff', 'woff2', 'ico']);

function extractEmails(html) {
  const found = new Set();
  const matches = html.match(EMAIL_RE) || [];
  for (const m of matches) {
    const lower = m.toLowerCase();
    const ext = lower.split('.').pop();
    if (IGNORE_EXTENSIONS.has(ext)) continue;
    if (lower.includes('example.com') || lower.includes('sentry.io')) continue;
    if (lower.length > 60) continue;
    found.add(lower);
  }
  return [...found];
}

async function scrapeWebsite(siteUrl) {
  if (!siteUrl) return { emails: [], error: null };
  let url = siteUrl.trim();
  if (!url.startsWith('http')) url = 'http://' + url;

  try {
    const main = await httpGet(url, 8000);
    if (main.status !== 200) return { emails: [], error: `HTTP ${main.status}` };

    const emails = extractEmails(main.body);

    // Try /contacts or /kontakty page
    for (const path of ['/contacts', '/kontakty', '/contact', '/about']) {
      try {
        const base = url.replace(/\/+$/, '');
        const sub = await httpGet(base + path, 5000);
        if (sub.status === 200) {
          for (const e of extractEmails(sub.body)) {
            if (!emails.includes(e)) emails.push(e);
          }
        }
      } catch {}
    }

    return { emails, error: null };
  } catch (e) {
    return { emails: [], error: e.message };
  }
}

// ══════════════════════════════════════════════════════════
// METHOD 2: Hunter.io — email finder by domain
// ══════════════════════════════════════════════════════════
async function hunterSearch(domain) {
  if (!HUNTER_API_KEY || !domain) return { emails: [], error: 'no key' };
  const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${encodeURIComponent(HUNTER_API_KEY)}&limit=10`;
  try {
    const res = await httpGet(url, 10000);
    if (res.status !== 200) return { emails: [], error: `HTTP ${res.status}` };
    const json = JSON.parse(res.body);
    const emails = (json.data?.emails || []).map(e => e.value?.toLowerCase()).filter(Boolean);
    return { emails, error: null };
  } catch (e) {
    return { emails: [], error: e.message };
  }
}

// ══════════════════════════════════════════════════════════
// METHOD 3: Whois — registrant email from domain
// ══════════════════════════════════════════════════════════
async function whoisLookup(domain) {
  if (!domain) return { emails: [], error: 'no domain' };

  // Use web whois service
  try {
    const url = `https://htmlweb.ru/analiz/api.php?whois&url=${encodeURIComponent(domain)}&json`;
    const res = await httpGet(url, 8000);
    if (res.status === 200) {
      const emails = extractEmails(res.body);
      return { emails, error: null };
    }
  } catch {}

  // Fallback: try whois via another service
  try {
    const url2 = `https://www.nic.ru/whois/?searchWord=${encodeURIComponent(domain)}`;
    const res2 = await httpGet(url2, 8000);
    if (res2.status === 200) {
      const emails = extractEmails(res2.body);
      return { emails, error: null };
    }
  } catch {}

  return { emails: [], error: 'failed' };
}

// ── Domain extraction ──
function domainFromUrl(url) {
  if (!url) return null;
  const first = url.split(',')[0]?.trim() ?? url;
  return first.replace(/^(?:https?:\/\/)?(?:www\.)?/i, '').replace(/\/.*$/, '').trim().toLowerCase() || null;
}

// ══════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════
const inputFile = process.argv[2];
const limit = parseInt(process.argv[3] || '199', 10);

if (!inputFile) { console.error('Usage: node test-methods.mjs <xlsx> [limit]'); process.exit(1); }

console.log(`\n📂 File: ${inputFile}`);
console.log(`🔑 Hunter.io key: ${HUNTER_API_KEY ? 'present' : 'MISSING (skip)'}`);
console.log(`📊 Limit: ${limit}\n`);

const wb = XLSX.readFile(inputFile);
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
const companies = rows.slice(0, limit);

const results = [];

for (let i = 0; i < companies.length; i++) {
  const row = companies[i];
  const inn = String(row['ИНН'] ?? '').trim();
  const name = String(row['Сокращенное наименование'] ?? '').trim();
  const director = String(row['Руководитель'] ?? '').trim();
  const existingEmail = String(row['Email'] ?? '').trim();
  const site = String(row['Веб-сайт'] ?? '').trim();
  const domain = domainFromUrl(site);

  console.log(`[${i + 1}/${companies.length}] ${name} | ${domain || '—'}`);

  // Method 1: Website scrape
  const scrape = await scrapeWebsite(site);
  if (scrape.emails.length) console.log(`  🌐 Site: ${scrape.emails.join(', ')}`);
  else if (scrape.error) console.log(`  🌐 Site: ✗ ${scrape.error}`);
  else console.log(`  🌐 Site: нет email`);

  // Method 2: Hunter.io
  const hunter = await hunterSearch(domain);
  if (hunter.emails.length) console.log(`  🔍 Hunter: ${hunter.emails.join(', ')}`);
  else console.log(`  🔍 Hunter: ${hunter.error || 'нет'}`);

  // Method 3: Whois
  const whois = await whoisLookup(domain);
  if (whois.emails.length) console.log(`  📋 Whois: ${whois.emails.join(', ')}`);
  else console.log(`  📋 Whois: ${whois.error || 'нет'}`);

  results.push({
    inn, name, director, site, domain: domain || '',
    existingEmail,
    scrapeEmails: scrape.emails.join('; '),
    hunterEmails: hunter.emails.join('; '),
    whoisEmails: whois.emails.join('; '),
  });

  if (i < companies.length - 1) await new Promise(r => setTimeout(r, 500));
}

// ── Stats ──
const withScrape = results.filter(r => r.scrapeEmails).length;
const withHunter = results.filter(r => r.hunterEmails).length;
const withWhois = results.filter(r => r.whoisEmails).length;
const withAny = results.filter(r => r.scrapeEmails || r.hunterEmails || r.whoisEmails).length;

console.log('\n' + '═'.repeat(50));
console.log('ИТОГИ');
console.log('═'.repeat(50));
console.log(`Всего: ${results.length}`);
console.log(`🌐 Website scrape: ${withScrape} (${Math.round(withScrape / results.length * 100)}%)`);
console.log(`🔍 Hunter.io:      ${withHunter} (${Math.round(withHunter / results.length * 100)}%)`);
console.log(`📋 Whois:          ${withWhois} (${Math.round(withWhois / results.length * 100)}%)`);
console.log(`Хотя бы один:      ${withAny} (${Math.round(withAny / results.length * 100)}%)`);

// ── Save XLSX ──
const outRows = results.map(r => ({
  'ИНН': r.inn,
  'Компания': r.name,
  'Руководитель': r.director,
  'Домен': r.domain,
  'Email из файла': r.existingEmail,
  '🌐 С сайта': r.scrapeEmails,
  '🔍 Hunter.io': r.hunterEmails,
  '📋 Whois': r.whoisEmails,
}));

const outWs = XLSX.utils.json_to_sheet(outRows);
outWs['!cols'] = [
  { wch: 14 }, { wch: 36 }, { wch: 34 }, { wch: 24 },
  { wch: 50 }, { wch: 50 }, { wch: 50 }, { wch: 40 },
];
const outWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(outWb, outWs, 'Methods Compare');
const outPath = inputFile.replace(/\.xlsx$/i, '-methods-compare.xlsx');
XLSX.writeFile(outWb, outPath);
console.log(`\n💾 ${outPath}`);
