#!/usr/bin/env node
/**
 * load-demo-labels.mjs — грузит ручные метки (hash-keyed) в reply_outcome_labels.
 * Вход: .tmp/demo-labels.jsonl  ({h, label} по строке)
 *        + .tmp/demo-unlabeled.jsonl и .tmp/demo-resid.jsonl для маппинга h -> (campaign_id, lead_id).
 * Идемпотентно (ON CONFLICT DO NOTHING). model='claude-fable-5', rubric_version='v1'.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../../..');
const env = Object.fromEntries(readFileSync(resolve(root,'.env'),'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const db = new Client({ connectionString: env.INSTANTLY_DATASET_DB_URL });

function readJsonl(p){ try { return readFileSync(p,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)); } catch { return []; } }

(async () => {
  await db.connect();
  await db.query("SET statement_timeout=0");
  const labels = readJsonl(resolve(root,'.tmp/demo-labels.jsonl'));
  const byHash = new Map(labels.map(x => [x.h, x.label]));
  // build h -> (campaign_id, lead_id) from the live best-body view for demo campaigns
  const IDS = ['99709456-9d33-4d4e-bfd0-836309cecba4','10821362-14ca-4a96-a90a-0a25a1395d6a','720c5e02-4fc5-45bc-8607-7e585dfa5d3e','c0d4e8b3-201c-42ab-a0e2-39e1189d1e20','145e8ab5-e6c1-47af-937f-3a3e480321e0','65f65480-a5f6-43cf-8a5b-f7f01a8ac419'];
  const map = (await db.query(`
    SELECT DISTINCT ON (campaign_id, lead_id) campaign_id, lead_id, md5(coalesce(body_text,'')) h
    FROM raw_emails
    WHERE ue_type=2 AND lead_id IS NOT NULL AND campaign_id = ANY($1)
      AND timestamp_email BETWEEN '2025-07-01' AND now()+interval '1 day'
    ORDER BY campaign_id, lead_id, length(coalesce(body_text,'')) DESC`, [IDS])).rows;
  let ins = 0, miss = 0;
  for (const r of map) {
    const label = byHash.get(r.h);
    if (!label) continue;
    const res = await db.query(
      `INSERT INTO reply_outcome_labels (campaign_id, lead_id, label, confidence, model, rubric_version, body_hash)
       VALUES ($1,$2,$3,NULL,'claude-fable-5','v1',$4) ON CONFLICT DO NOTHING`,
      [r.campaign_id, r.lead_id, label, r.h]);
    ins += res.rowCount;
  }
  // labels whose hash wasn't found in current best-body (already labeled by rules first -> conflict, fine)
  for (const x of labels) if (!map.find(m => m.h === x.h)) miss++;
  console.log(`hand-labels: ${labels.length} in file, inserted ${ins}, hash-not-in-residual ${miss}`);
  await db.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
