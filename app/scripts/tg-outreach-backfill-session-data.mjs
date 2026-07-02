#!/usr/bin/env node
/**
 * One-shot backfill: convert raw .session SQLite blobs in storage to
 * gramJS StringSession strings stored in tg_outreach_accounts.session_data,
 * then clear the per-account degraded flags so the worker re-picks them up.
 *
 * Why this exists:
 *   The bulk-files import route (app/src/app/api/tools/tg-outreach/accounts/
 *   bulk-files/route.ts) uploads the raw .session file to storage but writes
 *   session_data: '' to the row. The worker then falls back to reading the
 *   SQLite blob via readSqliteSession() every cycle (gramClient.ts:151),
 *   which only takes the FIRST row of the `sessions` table — if a session has
 *   multiple DC entries and the first one isn't the account's home DC, the
 *   client connects to the wrong DC, getDialogs hangs for 180s, the worker
 *   declares the account degraded for 24h, and outreach stops.
 *
 *   The proven path is to materialise the StringSession ('1AgA...') once and
 *   keep it in session_data so the worker takes the (account.session_data?.
 *   trim()) branch on every cycle. This script does that for the affected
 *   accounts and resets their degraded state.
 *
 * Scope safety:
 *   Refuses to run without CAMPAIGN_IDS — never touches campaigns the operator
 *   didn't explicitly list. Idempotent: rows whose session_data is already
 *   non-empty are skipped (so re-running is safe).
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   CAMPAIGN_IDS=<uuid>,<uuid> \
 *   [DRY_RUN=0]   # default 1 (preview); set to 0 to actually write
 *   [VERBOSE=1]   # per-account log lines
 *     node app/scripts/tg-outreach-backfill-session-data.mjs
 *
 * Required Node packages (already in app/package.json): @supabase/supabase-js,
 * sqlite3. Run from repo root or app/ — both resolve node_modules correctly.
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ---- Config ----------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CAMPAIGN_IDS_RAW = process.env.CAMPAIGN_IDS ?? '';
const DRY_RUN = process.env.DRY_RUN !== '0'; // default DRY (only false when explicit 0)
const VERBOSE = process.env.VERBOSE === '1';

const required = { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SUPABASE_KEY };
for (const [k, v] of Object.entries(required)) {
  if (!v) {
    console.error(`Missing env var: ${k}`);
    process.exit(1);
  }
}

const CAMPAIGN_IDS = CAMPAIGN_IDS_RAW
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (CAMPAIGN_IDS.length === 0) {
  console.error('CAMPAIGN_IDS is required (comma-separated uuids). Refusing to scan all campaigns.');
  process.exit(1);
}

const BUCKET = 'tg-outreach-sessions';
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- SQLite -> StringSession conversion -----------------------------------
// Mirrors app/src/lib/telegram/sessionUtils.ts (readSqliteSession +
// sqliteBufferToSessionString) but inlined so this script has no dependency
// on the Next.js TypeScript build.

function readSqliteSessionSync(filePath) {
  const sqlite3 = require('sqlite3');
  return new Promise((resolve, reject) => {
    const sdb = new sqlite3.Database(filePath, sqlite3.OPEN_READONLY, (err) => {
      if (err) return reject(err);
      sdb.get(
        'SELECT dc_id, server_address, port, auth_key FROM sessions LIMIT 1',
        (err2, row) => {
          sdb.close();
          if (err2) return reject(err2);
          if (!row?.auth_key) return reject(new Error('Empty session in SQLite file'));

          const isIPv6 = row.server_address.includes(':');
          const addressBuf = isIPv6
            ? Buffer.from(
                row.server_address.split(':').flatMap((p) => {
                  const n = parseInt(p, 16);
                  return [(n >> 8) & 255, n & 255];
                }),
              )
            : Buffer.from(row.server_address.split('.').map((p) => parseInt(p, 10)));

          const dcBuf = Buffer.from([row.dc_id]);
          const portBuf = Buffer.alloc(2);
          portBuf.writeInt16BE(row.port, 0);
          const keyBuf = Buffer.isBuffer(row.auth_key) ? row.auth_key : Buffer.from(row.auth_key);
          const result = Buffer.concat([dcBuf, addressBuf, portBuf, keyBuf.subarray(0, 256)]);
          resolve({
            sessionString: '1' + result.toString('base64'),
            dcId: row.dc_id,
          });
        },
      );
    });
  });
}

async function sqliteBufferToSessionString(buffer) {
  const tmpPath = path.join(
    os.tmpdir(),
    `tg-session-backfill-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
  );
  fs.writeFileSync(tmpPath, Buffer.from(buffer));
  try {
    return await readSqliteSessionSync(tmpPath);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

// ---- Main ------------------------------------------------------------------

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY (writing to DB)'}`);
  console.log(`Campaigns: ${CAMPAIGN_IDS.join(', ')}`);

  // Pick targets: rows with empty session_data + session_file_path present, in
  // requested campaigns. is_active is intentionally NOT filtered — operators
  // sometimes deactivate accounts during a fire-drill and we still want them
  // backfilled so they're ready when re-enabled.
  // Pull all rows in scope; filter empty session_data in JS (the PostgREST
  // .or() syntax for "null OR empty string" is brittle).
  const { data: targetsRaw, error: tErr } = await db
    .from('tg_outreach_accounts')
    .select('id, campaign_id, phone, session_name, session_data, session_file_path, degraded, cooldown_until')
    .in('campaign_id', CAMPAIGN_IDS)
    .not('session_file_path', 'is', null);

  if (tErr) {
    console.error('Failed to fetch accounts:', tErr.message);
    process.exit(2);
  }

  const targets = (targetsRaw ?? []).filter(
    (a) => !a.session_data || !a.session_data.trim(),
  );
  if (targets.length === 0) {
    console.log('No accounts to backfill (all have session_data already, or no file path).');
    return;
  }

  console.log(`Found ${targets.length} accounts to process.\n`);

  const stats = {
    total: targets.length,
    converted: 0,
    skipped: 0,
    download_failed: 0,
    parse_failed: 0,
    update_failed: 0,
    cleared_degraded: 0,
  };

  for (const acc of targets) {
    const tag = `${acc.phone || acc.session_name || acc.id} (campaign ${acc.campaign_id.slice(0, 8)})`;

    if (acc.session_data && acc.session_data.trim()) {
      stats.skipped++;
      if (VERBOSE) console.log(`  skip ${tag}: session_data already populated`);
      continue;
    }

    // 1. Download blob
    const { data: blob, error: dErr } = await db.storage.from(BUCKET).download(acc.session_file_path);
    if (dErr || !blob) {
      stats.download_failed++;
      console.error(`  ERR ${tag}: download failed — ${dErr?.message ?? 'no data'}`);
      continue;
    }
    const buf = Buffer.from(await blob.arrayBuffer());
    if (buf.length === 0) {
      stats.download_failed++;
      console.error(`  ERR ${tag}: blob is empty`);
      continue;
    }

    // 2. Parse SQLite -> StringSession
    let sessionString, dcId;
    try {
      const r = await sqliteBufferToSessionString(buf);
      sessionString = r.sessionString;
      dcId = r.dcId;
    } catch (e) {
      stats.parse_failed++;
      console.error(`  ERR ${tag}: parse failed — ${e?.message ?? e}`);
      continue;
    }

    if (!sessionString.startsWith('1') || sessionString.length < 50) {
      stats.parse_failed++;
      console.error(`  ERR ${tag}: produced suspicious session string (len=${sessionString.length})`);
      continue;
    }

    if (VERBOSE || DRY_RUN) {
      console.log(`  ok  ${tag}: blob=${buf.length}B, dc=${dcId}, prefix=${sessionString.slice(0, 6)}…, degraded=${acc.degraded}`);
    }

    if (DRY_RUN) {
      stats.converted++;
      continue;
    }

    // 3. Write back + clear degraded state in one update
    const { error: uErr } = await db
      .from('tg_outreach_accounts')
      .update({
        session_data: sessionString,
        degraded: false,
        degraded_at: null,
        degraded_reason: null,
        cooldown_until: null,
        consecutive_proxy_failures: 0,
      })
      .eq('id', acc.id);

    if (uErr) {
      stats.update_failed++;
      console.error(`  ERR ${tag}: UPDATE failed — ${uErr.message}`);
      continue;
    }

    stats.converted++;
    if (acc.degraded) stats.cleared_degraded++;
  }

  console.log('\n--- Summary ---');
  console.log(`Total scanned:        ${stats.total}`);
  console.log(`Converted${DRY_RUN ? ' (would convert)' : ''}: ${stats.converted}`);
  if (!DRY_RUN) console.log(`Cleared degraded:     ${stats.cleared_degraded}`);
  console.log(`Skipped (already ok): ${stats.skipped}`);
  if (stats.download_failed) console.log(`Download failed:      ${stats.download_failed}`);
  if (stats.parse_failed)    console.log(`Parse failed:         ${stats.parse_failed}`);
  if (stats.update_failed)   console.log(`Update failed:        ${stats.update_failed}`);
  if (DRY_RUN) {
    console.log('\nThis was a DRY RUN. Re-run with DRY_RUN=0 to actually write.');
  }
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(3);
});
