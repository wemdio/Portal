import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createRequire } from 'module';
const require = createRequire(resolve(import.meta.dirname, '..', 'app', 'node_modules', 'xlsx', 'package.json'));
const XLSX = require('xlsx');

const csv = readFileSync('G:\\Загрузки\\test-200-email-results.csv', 'utf-8').replace(/^\uFEFF/, '');
const lines = csv.split('\n').filter(l => l.trim());

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

const headers = parseCSVLine(lines[0]);
// indexes: 0=ИНН, 1=Компания, 2=Руководитель, 3=Сайт, 4=Email из файла, 5=OfData emails, 6=OfData телефоны, 7=Permutator, 8=SMTP
// Keep only 0-6
const keep = [0, 1, 2, 3, 4, 5, 6];
const keepHeaders = keep.map(i => headers[i]);

const rows = [];
for (let i = 1; i < lines.length; i++) {
  const vals = parseCSVLine(lines[i]);
  const obj = {};
  keep.forEach(idx => obj[headers[idx]] = (vals[idx] || '').trim());
  rows.push(obj);
}

const ws = XLSX.utils.json_to_sheet(rows);
ws['!cols'] = [
  { wch: 14 },
  { wch: 38 },
  { wch: 36 },
  { wch: 28 },
  { wch: 50 },
  { wch: 50 },
  { wch: 45 },
];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Email Discovery');
XLSX.writeFile(wb, 'G:\\Загрузки\\email-results-clean.xlsx');
console.log('OK:', rows.length, 'rows');
