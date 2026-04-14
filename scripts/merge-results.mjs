/**
 * Merge all method results into one comparison XLSX.
 * Sources: test-200-email-results.csv (OfData), test-200-methods-compare.xlsx (scrape)
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createRequire } from 'module';
const require = createRequire(resolve(import.meta.dirname, '..', 'app', 'node_modules', 'xlsx', 'package.json'));
const XLSX = require('xlsx');

function parseCSVLine(line) {
  const result = []; let field = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (inQ && line[i+1] === '"') { field += '"'; i++; } else { inQ = !inQ; } }
    else if (ch === ',' && !inQ) { result.push(field); field = ''; }
    else { field += ch; }
  }
  result.push(field);
  return result;
}

// Load OfData results
const csv = readFileSync('G:\\Загрузки\\test-200-email-results.csv', 'utf-8').replace(/^\uFEFF/, '');
const csvLines = csv.split('\n').filter(l => l.trim());
const csvHeaders = parseCSVLine(csvLines[0]);
const ofdataMap = new Map();
for (let i = 1; i < csvLines.length; i++) {
  const vals = parseCSVLine(csvLines[i]);
  const inn = vals[0]?.trim();
  if (inn) ofdataMap.set(inn, {
    ofdataEmails: vals[5]?.trim() || '',
    ofdataPhones: vals[6]?.trim() || '',
  });
}

// Load scrape results
const wb2 = XLSX.readFile('G:\\Загрузки\\test-200-methods-compare.xlsx');
const scrapeRows = XLSX.utils.sheet_to_json(wb2.Sheets[wb2.SheetNames[0]], { defval: '' });
const scrapeMap = new Map();
for (const r of scrapeRows) {
  const inn = String(r['ИНН'] ?? '').trim();
  if (inn) scrapeMap.set(inn, {
    scrapeEmails: String(r['🌐 С сайта'] ?? '').trim(),
  });
}

// Load original file
const wb0 = XLSX.readFile('G:\\Загрузки\\test-200.xlsx');
const origRows = XLSX.utils.sheet_to_json(wb0.Sheets[wb0.SheetNames[0]], { defval: '' });

// Merge
const merged = origRows.map(r => {
  const inn = String(r['ИНН'] ?? '').trim();
  const od = ofdataMap.get(inn) || {};
  const sc = scrapeMap.get(inn) || {};

  const fileEmails = String(r['Email'] ?? '').trim();
  const ofdataE = od.ofdataEmails || '';
  const scrapeE = sc.scrapeEmails || '';

  // Collect all unique emails
  const allEmails = new Set();
  for (const src of [fileEmails, ofdataE, scrapeE]) {
    for (const e of src.split(/[;,]/).map(s => s.trim().toLowerCase()).filter(Boolean)) {
      if (e.includes('@')) allEmails.add(e);
    }
  }

  return {
    'ИНН': inn,
    'Компания': String(r['Сокращенное наименование'] ?? '').trim(),
    'Руководитель': String(r['Руководитель'] ?? '').trim(),
    'Домен': String(r['Веб-сайт'] ?? '').trim().split(',')[0]?.trim()
      .replace(/^(?:https?:\/\/)?(?:www\.)?/i, '').replace(/\/.*$/, '') || '',
    'Email из файла (DaData)': fileEmails,
    'OfData (реестры)': ofdataE,
    'Scrape (с сайта)': scrapeE,
    'ВСЕ уникальные email': [...allEmails].join('; '),
    'Кол-во email': allEmails.size,
  };
});

// Stats
const withFile = merged.filter(r => r['Email из файла (DaData)']).length;
const withOfdata = merged.filter(r => r['OfData (реестры)']).length;
const withScrape = merged.filter(r => r['Scrape (с сайта)']).length;
const withAny = merged.filter(r => r['Кол-во email'] > 0).length;

// Unique emails only from OfData (not in file)
let ofdataNew = 0;
let scrapeNew = 0;
for (const r of merged) {
  const fileSet = new Set(r['Email из файла (DaData)'].split(/[;,]/).map(s => s.trim().toLowerCase()).filter(s => s.includes('@')));
  for (const e of r['OfData (реестры)'].split(/[;,]/).map(s => s.trim().toLowerCase()).filter(s => s.includes('@'))) {
    if (!fileSet.has(e)) { ofdataNew++; break; }
  }
  for (const e of r['Scrape (с сайта)'].split(/[;,]/).map(s => s.trim().toLowerCase()).filter(s => s.includes('@'))) {
    if (!fileSet.has(e)) { scrapeNew++; break; }
  }
}

console.log('═'.repeat(50));
console.log('СВОДКА ПО МЕТОДАМ');
console.log('═'.repeat(50));
console.log(`Всего компаний:              ${merged.length}`);
console.log(`📁 Email из файла (DaData):  ${withFile} (${Math.round(withFile/merged.length*100)}%)`);
console.log(`📋 OfData (реестры):         ${withOfdata} (${Math.round(withOfdata/merged.length*100)}%) | новых: ${ofdataNew}`);
console.log(`🌐 Scrape (с сайта):         ${withScrape} (${Math.round(withScrape/merged.length*100)}%) | новых: ${scrapeNew}`);
console.log(`✅ Хотя бы один email:       ${withAny} (${Math.round(withAny/merged.length*100)}%)`);

const ws = XLSX.utils.json_to_sheet(merged);
ws['!cols'] = [
  { wch: 14 }, { wch: 36 }, { wch: 34 }, { wch: 22 },
  { wch: 50 }, { wch: 50 }, { wch: 55 }, { wch: 60 }, { wch: 10 },
];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Сравнение методов');
XLSX.writeFile(wb, 'G:\\Загрузки\\email-all-methods.xlsx');
console.log('\n💾 G:\\Загрузки\\email-all-methods.xlsx');
