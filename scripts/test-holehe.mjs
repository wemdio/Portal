/**
 * Test holehe on emails from our discovered results.
 * Picks ~10 companies, runs holehe on their emails, outputs summary.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(resolve(import.meta.dirname, '..', 'app', 'node_modules', 'xlsx', 'package.json'));
const XLSX = require('xlsx');

// Load merged results
const wb = XLSX.readFile('G:\\Загрузки\\email-all-methods.xlsx');
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });

// Pick 10 companies that have emails
const withEmails = rows.filter(r => String(r['ВСЕ уникальные email'] ?? '').trim().length > 3);
const sample = withEmails.slice(0, 10);

console.log(`\nТестируем holehe на ${sample.length} компаниях\n`);

const results = [];

for (let i = 0; i < sample.length; i++) {
  const row = sample[i];
  const company = String(row['Компания'] ?? '').trim();
  const allEmails = String(row['ВСЕ уникальные email'] ?? '').trim();
  
  // Take first 2 unique emails per company
  const emails = [...new Set(allEmails.split(';').map(e => e.trim().toLowerCase()).filter(e => e.includes('@')))].slice(0, 2);
  
  console.log(`[${i+1}/${sample.length}] ${company}`);
  
  for (const email of emails) {
    console.log(`  📧 ${email}`);
    try {
      const output = execSync(`holehe ${email}`, { 
        encoding: 'utf-8', 
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      
      // Parse output: [+] means registered
      const registered = [];
      for (const line of output.split('\n')) {
        if (line.includes('[+]')) {
          const service = line.replace(/\[.\]\s*/, '').replace(/\x1b\[[0-9;]*m/g, '').trim();
          if (service) registered.push(service);
        }
      }
      
      const usedCount = registered.length;
      console.log(`    ✅ Зарегистрирован на ${usedCount} сервисах: ${registered.slice(0, 5).join(', ')}${usedCount > 5 ? '...' : ''}`);
      
      results.push({ company, email, registered: registered.join('; '), count: usedCount });
    } catch (e) {
      // Try parsing stderr/stdout from error
      const out = (e.stdout || '') + (e.stderr || '');
      const registered = [];
      for (const line of out.split('\n')) {
        if (line.includes('[+]')) {
          const service = line.replace(/\[.\]\s*/, '').replace(/\x1b\[[0-9;]*m/g, '').trim();
          if (service) registered.push(service);
        }
      }
      console.log(`    ✅ Зарегистрирован на ${registered.length} сервисах: ${registered.slice(0, 5).join(', ')}${registered.length > 5 ? '...' : ''}`);
      results.push({ company, email, registered: registered.join('; '), count: registered.length });
    }
  }
}

// Summary
console.log('\n' + '═'.repeat(50));
console.log('HOLEHE ИТОГИ');
console.log('═'.repeat(50));
const withReg = results.filter(r => r.count > 0);
console.log(`Проверено email: ${results.length}`);
console.log(`Активных (на сервисах): ${withReg.length} (${Math.round(withReg.length/results.length*100)}%)`);
console.log(`Средний count: ${(results.reduce((s,r) => s + r.count, 0) / results.length).toFixed(1)}`);

console.log('\nТаблица:');
console.log('Компания | Email | Сервисы | Кол-во');
console.log('-'.repeat(80));
for (const r of results) {
  console.log(`${r.company.slice(0,25)} | ${r.email} | ${r.registered.slice(0,40)} | ${r.count}`);
}
