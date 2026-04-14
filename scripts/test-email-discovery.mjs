/**
 * Standalone test script for email discovery pipeline.
 * Reads companies from XLSX, runs OfData + permutator + SMTP verify,
 * outputs results to console and saves CSV.
 *
 * Usage: node scripts/test-email-discovery.mjs "G:\Загрузки\test-200.xlsx" [limit]
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { createConnection } from 'net';
import { resolveMx } from 'dns';

// ── Load .env ──
const envPath = resolve(import.meta.dirname, '..', 'app', '.env');
try {
  const envText = readFileSync(envPath, 'utf-8');
  for (const line of envText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* no .env */ }

// Also try root .env
try {
  const rootEnvPath = resolve(import.meta.dirname, '..', '.env');
  const envText = readFileSync(rootEnvPath, 'utf-8');
  for (const line of envText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* no .env */ }

const OFDATA_API_KEY = process.env.OFDATA_API_KEY ?? '';

// ── XLSX reader ──
import { createRequire } from 'module';
const require = createRequire(resolve(import.meta.dirname, '..', 'app', 'node_modules', 'xlsx', 'package.json'));
const XLSX = require('xlsx');

// ── Transliteration ──
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e',
  ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function translit(text) {
  return text.toLowerCase().split('').map(ch => TRANSLIT[ch] ?? ch).join('').replace(/[^a-z0-9]/g, '');
}

function parseFio(fullName) {
  const words = fullName.trim().split(/\s+/);
  if (words.length < 2) return null;
  return { last: words[0], first: words[1], pat: words[2] ?? null };
}

function generatePermutations(fio, domain) {
  const seen = new Set();
  const results = [];
  const add = (local) => {
    const email = `${local}@${domain}`.toLowerCase();
    if (!seen.has(email) && local.length >= 2) { seen.add(email); results.push(email); }
  };

  const last = translit(fio.last);
  const first = translit(fio.first);
  const fl = first[0] ?? '';
  const pat = fio.pat ? translit(fio.pat) : '';
  const pl = pat ? pat[0] ?? '' : '';

  add(last);
  add(`${fl}.${last}`);
  add(`${fl}${last}`);
  add(`${first}.${last}`);
  add(`${first}_${last}`);
  add(`${last}.${fl}`);
  add(`${last}${fl}`);
  add(`${last}.${first}`);
  add(first);
  if (pl) {
    add(`${fl}.${pl}.${last}`);
    add(`${fl}${pl}${last}`);
  }
  add(`${fl}-${last}`);
  add(`${first}-${last}`);

  return results;
}

// ── OfData client (uses https module — ofdata.ru has weak TLS that fetch rejects) ──
import https from 'https';

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: false,
      secureProtocol: 'TLSv1_2_method',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchOfData(inn) {
  if (!OFDATA_API_KEY) return null;
  const url = `https://api.ofdata.ru/v2/company?key=${encodeURIComponent(OFDATA_API_KEY)}&inn=${encodeURIComponent(inn)}`;
  try {
    const res = await httpsGet(url);
    if (res.status !== 200) return null;
    const json = JSON.parse(res.body);
    const data = json.data;
    if (!data) return null;

    const contacts = data['Контакты'] ?? {};

    const rawEmails = contacts['Емэйл'];
    const emails = (Array.isArray(rawEmails) ? rawEmails : []).map(e => String(e).trim().toLowerCase()).filter(e => e.includes('@'));

    const rawPhones = contacts['Тел'];
    const phones = (Array.isArray(rawPhones) ? rawPhones : []).map(p => String(p).replace(/[\s()-]/g, '').trim()).filter(p => p.length >= 6);

    const rawSites = contacts['ВебСайт'];
    const sites = typeof rawSites === 'string' ? [rawSites].filter(Boolean)
      : Array.isArray(rawSites) ? rawSites.map(s => String(s).trim()).filter(Boolean)
      : [];

    const dirArray = data['Руковод'] ?? [];
    const directors = (Array.isArray(dirArray) ? dirArray : []).map(d => ({
      name: String(d['ФИО'] ?? '').trim(),
      inn: d['ИНН'] ? String(d['ИНН']).trim() : null,
      post: d['НаимДолжн'] ? String(d['НаимДолжн']).trim() : null,
    })).filter(d => d.name.length > 2);

    return { emails, phones, sites, directors };
  } catch (e) {
    console.error(`  [ofdata] error for ${inn}: ${e.message}`);
    return null;
  }
}

// ── SMTP verifier ──
function resolveMxAsync(domain) {
  return new Promise((resolve, reject) => {
    resolveMx(domain, (err, records) => {
      if (err) return reject(err);
      resolve((records ?? []).sort((a, b) => a.priority - b.priority));
    });
  });
}

function smtpCheck(host, email) {
  return new Promise((resolve) => {
    let done = false;
    let buf = '';
    let stage = 'greeting';
    let rcptCode = 0;

    const finish = (code, catchAll = false) => {
      if (done) return;
      done = true;
      sock.destroy();
      clearTimeout(timer);
      resolve({ code, catchAll });
    };

    const sock = createConnection({ host, port: 25, timeout: 8000 });
    const timer = setTimeout(() => finish(0), 8000);

    sock.on('timeout', () => finish(0));
    sock.on('error', () => finish(0));
    sock.on('close', () => { if (!done) finish(0); });

    sock.on('data', (chunk) => {
      buf += chunk.toString();
      if (!buf.includes('\n')) return;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';

      for (const line of lines) {
        const code = parseInt(line.slice(0, 3), 10);
        if (isNaN(code) || (line.length > 3 && line[3] === '-')) continue;

        if (stage === 'greeting' && code >= 200 && code < 300) {
          stage = 'ehlo'; sock.write('EHLO test.local\r\n');
        } else if (stage === 'ehlo' && code >= 200 && code < 300) {
          stage = 'mail'; sock.write('MAIL FROM:<test@test.local>\r\n');
        } else if (stage === 'mail' && code === 250) {
          stage = 'rcpt'; sock.write(`RCPT TO:<${email}>\r\n`);
        } else if (stage === 'rcpt') {
          rcptCode = code;
          stage = 'rcpt_fake';
          sock.write(`RCPT TO:<nonexistent-${Date.now()}@${email.split('@')[1]}>\r\n`);
        } else if (stage === 'rcpt_fake') {
          const fakeOk = code === 250;
          stage = 'quit'; sock.write('QUIT\r\n');
          finish(rcptCode, rcptCode === 250 && fakeOk);
        } else if (stage === 'quit') {
          finish(rcptCode);
        } else if (code >= 400) {
          finish(code);
        }
      }
    });
  });
}

async function verifyEmail(email) {
  const domain = email.split('@')[1];
  if (!domain) return 'invalid';

  let mx;
  try { mx = await resolveMxAsync(domain); } catch { return 'invalid'; }
  if (mx.length === 0) return 'invalid';

  for (const rec of mx.slice(0, 2)) {
    try {
      const r = await smtpCheck(rec.exchange, email);
      if (r.catchAll) return 'catch_all';
      if (r.code === 250) return 'valid';
      if (r.code >= 500) return 'invalid';
    } catch { continue; }
  }
  return 'unknown';
}

// ── Generic email filter ──
const GENERIC = new Set([
  'info', 'office', 'sales', 'support', 'admin', 'contact', 'help',
  'service', 'mail', 'hello', 'hr', 'marketing', 'reception', 'secretary',
  'general', 'noreply', 'no-reply', 'feedback', 'priemnaya', 'order',
]);

function isGeneric(email) {
  return GENERIC.has(email.split('@')[0]?.toLowerCase() ?? '');
}

function domainFromUrl(url) {
  if (!url) return null;
  return url.replace(/^(?:https?:\/\/)?(?:www\.)?/i, '').replace(/\/.*$/, '').trim().toLowerCase() || null;
}

// ── Main ──
const inputFile = process.argv[2];
const limit = parseInt(process.argv[3] || '20', 10);

if (!inputFile) {
  console.error('Usage: node scripts/test-email-discovery.mjs <xlsx-file> [limit]');
  process.exit(1);
}

console.log(`\n📂 Reading: ${inputFile}`);
console.log(`🔑 OfData key: ${OFDATA_API_KEY ? 'present' : 'MISSING'}`);
console.log(`📊 Limit: ${limit} companies\n`);

const wb = XLSX.readFile(inputFile);
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

const results = [];
const companies = rows.slice(0, limit);

for (let i = 0; i < companies.length; i++) {
  const row = companies[i];
  const inn = String(row['ИНН'] ?? '').trim();
  const name = String(row['Сокращенное наименование'] ?? '').trim();
  const director = String(row['Руководитель'] ?? '').trim();
  const existingEmail = String(row['Email'] ?? '').trim();
  const site = String(row['Веб-сайт'] ?? '').trim();

  console.log(`\n━━━ [${i + 1}/${companies.length}] ${name} (ИНН: ${inn}) ━━━`);
  console.log(`  Руководитель: ${director || '—'}`);
  console.log(`  Сайт: ${site || '—'}`);
  console.log(`  Email из файла: ${existingEmail || '—'}`);

  const result = {
    inn, name, director, site, existingEmail,
    ofdataEmails: [], ofdataPhones: [], ofdataSites: [], ofdataDirectors: [],
    permutations: [], verifiedEmail: null, verifyResult: null,
  };

  // ── Step 1: OfData ──
  if (inn && OFDATA_API_KEY) {
    console.log(`  [1/3] OfData запрос...`);
    const ofdata = await fetchOfData(inn);
    if (ofdata) {
      result.ofdataEmails = ofdata.emails;
      result.ofdataPhones = ofdata.phones;
      result.ofdataSites = ofdata.sites;
      result.ofdataDirectors = ofdata.directors;

      const personalEmails = ofdata.emails.filter(e => !isGeneric(e));
      const genericEmails = ofdata.emails.filter(e => isGeneric(e));

      console.log(`    Email: ${ofdata.emails.length > 0 ? ofdata.emails.join(', ') : '—'}`);
      console.log(`    Телефоны: ${ofdata.phones.length > 0 ? ofdata.phones.join(', ') : '—'}`);
      console.log(`    Сайты: ${ofdata.sites.length > 0 ? ofdata.sites.join(', ') : '—'}`);
      console.log(`    Руководители: ${ofdata.directors.map(d => `${d.name} (${d.post})`).join('; ') || '—'}`);
      console.log(`    ✉ Персональные email: ${personalEmails.length > 0 ? personalEmails.join(', ') : '—'}`);
      console.log(`    📋 Generic email: ${genericEmails.length > 0 ? genericEmails.join(', ') : '—'}`);
    } else {
      console.log(`    ❌ Нет данных`);
    }
  }

  // ── Step 2: Email Permutator ──
  const firstSite = site.split(',')[0]?.trim() ?? site;
  const firstEmail = existingEmail.split(',')[0]?.trim() ?? existingEmail;
  const domain = domainFromUrl(firstSite) || domainFromUrl(result.ofdataSites[0]) || (firstEmail.includes('@') ? firstEmail.split('@').pop()?.trim() : null);

  if (director && domain) {
    console.log(`  [2/3] Permutator: ${director} @ ${domain}`);
    const fio = parseFio(director);
    if (fio) {
      const perms = generatePermutations(fio, domain);
      result.permutations = perms;
      console.log(`    Кандидаты (${perms.length}): ${perms.slice(0, 6).join(', ')}${perms.length > 6 ? '...' : ''}`);
    } else {
      console.log(`    ⚠ Не удалось распарсить ФИО`);
    }
  } else {
    console.log(`  [2/3] Permutator: пропущен (нет ФИО или домена)`);
  }

  // ── Step 3: Best candidate (SMTP disabled on Windows — port 25 blocked) ──
  if (result.permutations.length > 0) {
    result.verifiedEmail = result.permutations[0];
    result.verifyResult = 'candidate';
    console.log(`  [3/3] Лучший кандидат: ${result.verifiedEmail}`);
  } else {
    console.log(`  [3/3] Пропущен (нет кандидатов)`);
  }

  results.push(result);

  if (i < companies.length - 1) {
    await new Promise(r => setTimeout(r, 1500));
  }
}

// ── Summary ──
console.log('\n\n' + '═'.repeat(60));
console.log('ИТОГИ');
console.log('═'.repeat(60));

const withOfdataEmail = results.filter(r => r.ofdataEmails.length > 0);
const withVerified = results.filter(r => r.verifiedEmail);
const withAny = results.filter(r => r.ofdataEmails.length > 0 || r.verifiedEmail);

console.log(`Всего компаний: ${results.length}`);
console.log(`OfData email найден: ${withOfdataEmail.length} (${Math.round(withOfdataEmail.length / results.length * 100)}%)`);
console.log(`SMTP verified email: ${withVerified.length} (${Math.round(withVerified.length / results.length * 100)}%)`);
console.log(`Хотя бы один email: ${withAny.length} (${Math.round(withAny.length / results.length * 100)}%)`);

// ── Save XLSX ──
const outRows = results.map(r => ({
  'ИНН': r.inn,
  'Компания': r.name,
  'Руководитель': r.director || '',
  'Сайт': r.site || '',
  'Email из файла': r.existingEmail || '',
  'OfData emails': r.ofdataEmails.join('; '),
  'OfData телефоны': r.ofdataPhones.join('; '),
  'OfData сайты': r.ofdataSites.join('; '),
  'OfData руководители': r.ofdataDirectors.map(d => `${d.name} (${d.post})`).join('; '),
  'Permutator email': r.verifiedEmail ?? '',
  'Результат': r.verifyResult ?? '',
  'Все кандидаты': r.permutations.slice(0, 8).join('; '),
}));

const outWs = XLSX.utils.json_to_sheet(outRows);

// Auto-width columns
const colWidths = Object.keys(outRows[0] || {}).map(key => {
  const maxLen = Math.max(key.length, ...outRows.map(r => String(r[key] || '').length));
  return { wch: Math.min(maxLen + 2, 60) };
});
outWs['!cols'] = colWidths;

const outWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(outWb, outWs, 'Email Discovery');
const outPath = inputFile.replace(/\.xlsx$/i, '-email-results.xlsx');
XLSX.writeFile(outWb, outPath);
console.log(`\n💾 Результаты сохранены: ${outPath}`);
