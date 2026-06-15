#!/usr/bin/env node
/**
 * One-time backfill of per-campaign DAILY analytics for ALL campaigns.
 *
 * Why: the original pull fetched /campaigns/analytics/daily with the buggy
 * `id` param (workspace-wide garbage, truncated in migration 009). The fixed
 * nightly sync only refreshes ACTIVE campaigns (since 2026-05-30). But
 * Instantly retains daily AGGREGATES far longer than email objects (verified
 * 2026-06-11: a Feb-2025 campaign returned its full 70-day series, totals
 * matching lifetime overview exactly) — so a one-time full backfill recovers
 * daily sent/replies/opportunities series for the entire workspace history,
 * including campaigns whose raw emails are long purged.
 *
 * Rows land in raw_campaign_analytics_daily_snap under a dedicated
 * dataset_snapshots row (mode='analytics-only', see notes). raw_payload keeps the full
 * API row (incl. replies_automatic, opportunities — columns the table doesn't
 * have explicitly).
 *
 * Checkpoints to .tmp/daily-backfill-progress.json — safe to re-run after an
 * interruption; finished campaigns are skipped.
 *
 * Usage: node app/scripts/instantly-dataset/backfill-daily-analytics.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const PROGRESS_FILE = join(REPO_ROOT, '.tmp', 'daily-backfill-progress.json');
mkdirSync(join(REPO_ROOT, '.tmp'), { recursive: true });

const env = Object.fromEntries(readFileSync(join(REPO_ROOT, '.env'), 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const KEY = env.INSTANTLY_EXPORT_API_KEY;
if (!KEY) { console.error('FATAL: INSTANTLY_EXPORT_API_KEY missing'); process.exit(1); }

const PACE_MS = 900;            // ~1.1 req/s — analytics family, gentle pace
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

const toInt = (v) => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const toJson = (v) => { if (v == null) return null; const j = JSON.stringify(v); return typeof j === 'string' ? j.replace(/\\u0000/g, '') : j; };

async function fetchDaily(cid) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`https://api.instantly.ai/api/v2/campaigns/analytics/daily?campaign_id=${cid}`,
        { headers: { Authorization: `Bearer ${KEY}` } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) { log(`  ! ${cid.slice(0, 8)} HTTP ${res.status} (skipping)`); return null; }
      const data = await res.json();
      return Array.isArray(data) ? data : (data.items || data.data || []);
    } catch (e) {
      const wait = Math.min(60000, 2000 * 2 ** attempt);
      log(`  retry ${attempt}/5 for ${cid.slice(0, 8)}: ${e.message} (wait ${wait / 1000}s)`);
      await sleep(wait);
    }
  }
  log(`  ! ${cid.slice(0, 8)} gave up after 5 attempts`);
  return null;
}

(async () => {
  const db = new Client({ connectionString: env.INSTANTLY_DATASET_DB_URL });
  await db.connect();

  const progress = existsSync(PROGRESS_FILE) ? JSON.parse(readFileSync(PROGRESS_FILE, 'utf8')) : { snapshotId: null, done: [] };
  const doneSet = new Set(progress.done);

  if (!progress.snapshotId) {
    const r = await db.query(
      `INSERT INTO dataset_snapshots (mode, notes) VALUES ('analytics-only', 'one-time DAILY analytics backfill for all campaigns, launched ' || now()) RETURNING id`);
    progress.snapshotId = r.rows[0].id;
    writeFileSync(PROGRESS_FILE, JSON.stringify(progress));
  }
  const snapshotId = progress.snapshotId;
  log(`snapshot ${snapshotId} (resuming with ${doneSet.size} campaigns already done)`);

  const camps = (await db.query(`SELECT id FROM raw_campaigns ORDER BY timestamp_created`)).rows.map(r => r.id);
  const todo = camps.filter(c => !doneSet.has(c));
  log(`campaigns: ${camps.length} total, ${todo.length} to fetch`);

  let rowsTotal = 0, withData = 0, idx = 0;
  const started = Date.now();
  for (const cid of todo) {
    idx++;
    const days = await fetchDaily(cid);
    if (Array.isArray(days) && days.length) {
      withData++;
      const cols = ['snapshot_id', 'campaign_id', 'date', 'sent', 'opened', 'unique_opened', 'replies', 'unique_replies', 'clicks', 'unique_clicks', 'bounced', 'unsubscribed', 'raw_payload'];
      const rows = days.filter(d => d.date || d.day).map(d => ({
        snapshot_id: snapshotId, campaign_id: cid, date: d.date || d.day,
        sent: toInt(d.sent), opened: toInt(d.opened), unique_opened: toInt(d.unique_opened ?? d.opened_unique),
        replies: toInt(d.replies), unique_replies: toInt(d.unique_replies ?? d.replies_unique),
        clicks: toInt(d.clicks), unique_clicks: toInt(d.unique_clicks ?? d.clicks_unique),
        bounced: toInt(d.bounced ?? d.bounces), unsubscribed: toInt(d.unsubscribed),
        raw_payload: toJson(d),
      }));
      for (let i = 0; i < rows.length; i += 500) {
        const slice = rows.slice(i, i + 500);
        const valueRows = []; const params = []; let p = 1;
        for (const r of slice) {
          valueRows.push('(' + cols.map(() => '$' + (p++)).join(',') + ')');
          for (const c of cols) params.push(r[c] === undefined ? null : r[c]);
        }
        await db.query(`INSERT INTO raw_campaign_analytics_daily_snap (${cols.join(',')}) VALUES ${valueRows.join(',')} ON CONFLICT (snapshot_id, campaign_id, date) DO NOTHING`, params);
      }
      rowsTotal += rows.length;
    }
    doneSet.add(cid);
    if (idx % 25 === 0) {
      progress.done = [...doneSet];
      writeFileSync(PROGRESS_FILE, JSON.stringify(progress));
    }
    if (idx % 100 === 0) {
      const rate = idx / ((Date.now() - started) / 1000);
      log(`progress: ${idx}/${todo.length} | ${rowsTotal} day-rows | ETA ${((todo.length - idx) / rate / 60).toFixed(0)} min`);
    }
    await sleep(PACE_MS);
  }
  progress.done = [...doneSet];
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress));
  await db.query(`UPDATE dataset_snapshots SET finished_at = now(), ok = true, counts = $2::jsonb WHERE id = $1`,
    [snapshotId, JSON.stringify({ campaigns_fetched: doneSet.size, campaigns_with_data: withData, day_rows: rowsTotal })]);
  log(`DONE: ${doneSet.size} campaigns, ${withData} with data, ${rowsTotal} day-rows inserted. Snapshot ${snapshotId} closed.`);
  await db.end();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
