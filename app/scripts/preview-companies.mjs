import fs from 'fs';
import Papa from 'papaparse';

const raw = fs.readFileSync('../сезонный бизнес - сезонный бизнес.csv', 'utf-8');
const { data } = Papa.parse(raw, { header: true, skipEmptyLines: true });

const valid = data.filter(r =>
  r.Company && r.Company.trim() &&
  r.Email && r.Email.includes('@') &&
  r.Site && r.Site.startsWith('http') &&
  r.Description && r.Description.trim().length > 20
);

console.log(`Total rows: ${data.length}, Valid: ${valid.length}\n`);
console.log('=== First 20 valid companies ===\n');

valid.slice(0, 20).forEach((r, i) => {
  console.log(`${i + 1}. ${r.Company}`);
  console.log(`   Email: ${r.Email}`);
  console.log(`   Site:  ${r.Site}`);
  console.log(`   Desc:  ${r.Description.substring(0, 150)}...`);
  console.log();
});
