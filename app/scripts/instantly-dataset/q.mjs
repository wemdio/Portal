#!/usr/bin/env node
/**
 * q.mjs — quick SQL runner against instantly_dataset on VPS.
 *
 * Usage:
 *   node app/scripts/instantly-dataset/q.mjs "SELECT count(*) FROM raw_emails"
 *   echo "SELECT ..." | node app/scripts/instantly-dataset/q.mjs
 *   node app/scripts/instantly-dataset/q.mjs --json "SELECT id, subject FROM raw_emails LIMIT 5"
 *   node app/scripts/instantly-dataset/q.mjs --file query.sql
 *
 * Output: table for human-readable, --json for piping.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

const env = Object.fromEntries(
  readFileSync(resolve(REPO_ROOT, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const url = env.INSTANTLY_DATASET_DB_URL;
if (!url) { console.error('FATAL: INSTANTLY_DATASET_DB_URL missing in .env'); process.exit(1); }

const args = process.argv.slice(2);
const flagJson = args.includes('--json');
const fileIdx = args.indexOf('--file');
const filePath = fileIdx >= 0 ? args[fileIdx + 1] : null;
const sqlArg = args.find((a, i) => !a.startsWith('--') && (fileIdx < 0 || i !== fileIdx + 1));

async function getSql() {
  if (filePath) return readFileSync(filePath, 'utf8');
  if (sqlArg) return sqlArg;
  // stdin
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk;
  return buf.trim();
}

(async () => {
  const sql = await getSql();
  if (!sql) {
    console.error('Usage: q.mjs "<sql>"  |  q.mjs --file query.sql  |  echo "..." | q.mjs');
    process.exit(1);
  }
  const c = new Client({ connectionString: url, statement_timeout: 60_000 });
  await c.connect();
  try {
    const res = await c.query(sql);
    if (Array.isArray(res)) {
      // multi-statement: print each result
      res.forEach((r, i) => {
        console.log(`--- statement ${i + 1}: ${r.command} (${r.rowCount ?? 0} rows) ---`);
        if (r.rows?.length) flagJson ? console.log(JSON.stringify(r.rows, null, 2)) : console.table(r.rows);
      });
    } else {
      if (res.rows?.length) {
        flagJson ? console.log(JSON.stringify(res.rows, null, 2)) : console.table(res.rows);
      } else {
        console.log(`${res.command} ok (${res.rowCount ?? 0} rows affected)`);
      }
    }
  } catch (e) {
    console.error(`SQL error: ${e.message}`);
    process.exit(2);
  } finally {
    await c.end();
  }
})();
