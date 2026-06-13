#!/usr/bin/env node
/**
 * load-reply-labels.mjs — загрузка меток из .tmp/label-batches/out-*.json в reply_outcome_labels.
 * Файлы производят Claude-субагенты (политика проекта: без внешних LLM-API).
 * Идемпотентен: ON CONFLICT DO NOTHING, можно гонять после каждой волны.
 */
import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(readFileSync(resolve(__dirname, '../../../.env'), 'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const db = new Client({ connectionString: env.INSTANTLY_DATASET_DB_URL });
const DIR = resolve(__dirname, '../../../.tmp/label-batches');
const LABELS = new Set(['interested','referral','question','objection','not_interested','unsubscribe','auto_reply','wrong_person','other']);
const MODEL = 'claude-fable-5';

(async () => {
  await db.connect();
  const files = readdirSync(DIR).filter(f => /^out-\d+\.json$/.test(f)).sort();
  let total = 0, inserted = 0, bad = 0;
  for (const f of files) {
    let arr;
    try { arr = JSON.parse(readFileSync(resolve(DIR, f), 'utf8')); } catch (e) { console.log(`! ${f}: parse error ${e.message.slice(0, 60)}`); continue; }
    if (!Array.isArray(arr)) { console.log(`! ${f}: not an array`); continue; }
    const rows = arr.filter(x => x && x.c && x.l && LABELS.has(x.label));
    bad += arr.length - rows.length;
    total += rows.length;
    for (let i = 0; i < rows.length; i += 500) {
      const slice = rows.slice(i, i + 500);
      const vals = []; const params = []; let p = 1;
      for (const r of slice) {
        vals.push(`($${p++},$${p++},$${p++},$${p++},'v1',$${p++})`);
        params.push(r.c, r.l, r.label, MODEL, r.h ?? null);
      }
      const res = await db.query(
        `INSERT INTO reply_outcome_labels (campaign_id, lead_id, label, model, rubric_version, body_hash)
         VALUES ${vals.join(',')} ON CONFLICT (campaign_id, lead_id) DO NOTHING`, params);
      inserted += res.rowCount;
    }
  }
  console.log(`files: ${files.length}, rows seen: ${total}, inserted: ${inserted}, invalid: ${bad}`);
  const c = await db.query(`SELECT model, count(*) FROM reply_outcome_labels GROUP BY 1 ORDER BY 2 DESC`);
  c.rows.forEach(r => console.log(`  ${r.model}: ${r.count}`));
  await db.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
