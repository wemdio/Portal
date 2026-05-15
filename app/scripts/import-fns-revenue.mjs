import { createClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SUPABASE_URL = process.env.SUPABASE_URL || process.argv[2];
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.argv[3];
const XML_DIR = process.env.XML_DIR || process.argv[4] || 'C:\\Users\\wemd1\\Desktop\\fns_revexp';
// За какой отчётный год эти XML. ФНС выкладывает отдельные дампы за каждый
// год — содержимое одного дампа не содержит явной метки года, год указан
// только в названии каталога. Поэтому передаём через ENV/CLI.
//
// Schema после миграции 20260514_0002: PRIMARY KEY (inn, report_year),
// то есть 2024 и 2025 в одной таблице не конфликтуют.
const REPORT_YEAR = Number(process.env.REPORT_YEAR || process.argv[5] || 2024);
const BATCH_SIZE = 500;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Usage: node import-fns-revenue.mjs <SUPABASE_URL> <SUPABASE_SERVICE_KEY> [XML_DIR] [REPORT_YEAR]');
  console.error('  REPORT_YEAR можно задать через env REPORT_YEAR=2025 или 5-м аргументом. Default: 2024.');
  process.exit(1);
}
if (!Number.isInteger(REPORT_YEAR) || REPORT_YEAR < 2000 || REPORT_YEAR > 2100) {
  console.error(`Invalid REPORT_YEAR: ${REPORT_YEAR}. Expected integer 2000..2100.`);
  process.exit(1);
}
console.log(`Importing as report_year=${REPORT_YEAR}`);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const INN_RE = /ИННЮЛ="(\d+)"/g;
const INCOME_RE = /СумДоход="([\d.]+)"/g;
const EXPENSE_RE = /СумРасход="([\d.]+)"/g;
const NAME_RE = /НаимОрг="([^"]+)"/g;

function parseXmlFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const inns = [...content.matchAll(INN_RE)].map(m => m[1]);
  const incomes = [...content.matchAll(INCOME_RE)].map(m => m[1]);
  const expenses = [...content.matchAll(EXPENSE_RE)].map(m => m[1]);
  const names = [...content.matchAll(NAME_RE)].map(m => m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));

  const records = [];
  for (let i = 0; i < inns.length; i++) {
    records.push({
      inn: inns[i],
      org_name: names[i] || '',
      income: parseFloat(incomes[i] || '0'),
      expense: parseFloat(expenses[i] || '0'),
      report_year: REPORT_YEAR,
    });
  }
  return records;
}

async function upsertBatch(records) {
  // onConflict: 'inn,report_year' — соответствует композитному PK после
  // миграции 20260514_0002. ignoreDuplicates снят: повторный импорт
  // ОБНОВЛЯЕТ существующие записи (если ФНС перезалила дамп с правками).
  const { error } = await supabase
    .from('fns_revenue')
    .upsert(records, { onConflict: 'inn,report_year' });
  if (error) throw new Error(`Supabase upsert error: ${error.message}`);
}

async function main() {
  const files = readdirSync(XML_DIR).filter(f => f.endsWith('.xml')).sort();
  console.log(`Found ${files.length} XML files in ${XML_DIR}`);

  let totalInserted = 0;
  let batch = [];
  const startTime = Date.now();

  for (let fi = 0; fi < files.length; fi++) {
    const filePath = join(XML_DIR, files[fi]);
    const records = parseXmlFile(filePath);

    for (const rec of records) {
      batch.push(rec);
      if (batch.length >= BATCH_SIZE) {
        await upsertBatch(batch);
        totalInserted += batch.length;
        batch = [];
      }
    }

    if ((fi + 1) % 100 === 0 || fi === files.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const pct = (((fi + 1) / files.length) * 100).toFixed(1);
      console.log(`[${elapsed}s] ${fi + 1}/${files.length} files (${pct}%) — ${totalInserted} records inserted`);
    }
  }

  if (batch.length > 0) {
    await upsertBatch(batch);
    totalInserted += batch.length;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone! ${totalInserted} records inserted in ${elapsed}s`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
