import { createClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SUPABASE_URL = process.env.SUPABASE_URL || process.argv[2];
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.argv[3];
const XML_DIR = process.env.XML_DIR || process.argv[4] || 'C:\\Users\\wemd1\\Desktop\\fns_revexp';
const BATCH_SIZE = 500;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Usage: node import-fns-revenue.mjs <SUPABASE_URL> <SUPABASE_SERVICE_KEY> [XML_DIR]');
  process.exit(1);
}

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
      report_year: 2024,
    });
  }
  return records;
}

async function upsertBatch(records) {
  const { error } = await supabase
    .from('fns_revenue')
    .upsert(records, { onConflict: 'inn', ignoreDuplicates: true });
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
