#!/usr/bin/env node
/**
 * Проверяет activityTypeToOkved.json:
 *   - все ключи покрывают все 303 distinct activity_type из activity_types.csv;
 *   - все значения существуют в okved2.scraped.json (т.е. валидные коды ОКВЭД-2);
 *   - пишет краткую сводку по уровням ОКВЭД.
 *
 *   node scripts/db/validateOkvedMapping.mjs
 */
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAP_PATH = resolve(__dirname, 'activityTypeToOkved.json');
const CSV_PATH = resolve(__dirname, 'activity_types.csv');
const OKVED_PATH = resolve(__dirname, 'okved2.scraped.json');

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const out = [];
  for (const line of lines.slice(1)) {
    const m = line.match(/^"((?:[^"]|"")*)",(\d+)$|^([^",]+),(\d+)$/);
    if (!m) continue;
    const name = (m[1] || m[3]).replace(/""/g, '"');
    const cnt = Number(m[2] || m[4]);
    out.push({ name, cnt });
  }
  return out;
}

const mapData = JSON.parse(await readFile(MAP_PATH, 'utf8'));
const okvedRows = JSON.parse(await readFile(OKVED_PATH, 'utf8'));
const csvRows = parseCsv(await readFile(CSV_PATH, 'utf8'));

const validCodes = new Set(okvedRows.map((r) => r.code));
const mapping = mapData.mapping;
const csvNames = new Set(csvRows.map((r) => r.name));

const missingInMap = [];
for (const n of csvNames) if (!(n in mapping)) missingInMap.push(n);

const extraInMap = [];
for (const k of Object.keys(mapping)) if (!csvNames.has(k)) extraInMap.push(k);

const invalidCodes = [];
const levelHist = {};
let nullCount = 0;
let mappedRows = 0;
for (const r of csvRows) {
  const code = mapping[r.name];
  if (code === null || code === undefined) {
    nullCount += r.cnt;
    continue;
  }
  if (!validCodes.has(code)) invalidCodes.push({ name: r.name, code });
  else {
    mappedRows += r.cnt;
    const entry = okvedRows.find((e) => e.code === code);
    const lvl = entry ? entry.level : '?';
    levelHist[lvl] = (levelHist[lvl] || 0) + 1;
  }
}

console.log('=== summary ===');
console.log('CSV categories:                  ', csvRows.length);
console.log('Mapping keys:                    ', Object.keys(mapping).length);
console.log('Missing in mapping (CSV without): ', missingInMap.length);
console.log('Extra in mapping (not in CSV):   ', extraInMap.length);
console.log('Invalid OKVED codes:             ', invalidCodes.length);
console.log('Mapped rows (companies count):   ', mappedRows);
console.log('Unmapped rows (null mapping):    ', nullCount);
console.log('By OKVED level:                  ', levelHist);

if (missingInMap.length) {
  console.log('\nMissing in mapping:');
  for (const n of missingInMap.slice(0, 30)) console.log('  -', n);
}
if (extraInMap.length) {
  console.log('\nExtra mapping keys (not in CSV):');
  for (const n of extraInMap.slice(0, 30)) console.log('  -', n);
}
if (invalidCodes.length) {
  console.log('\nInvalid OKVED codes:');
  for (const r of invalidCodes.slice(0, 30)) console.log('  -', r.name, '→', r.code);
}

if (missingInMap.length || invalidCodes.length) process.exit(1);
