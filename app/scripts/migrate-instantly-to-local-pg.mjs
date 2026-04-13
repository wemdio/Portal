/**
 * Migrate Instantly data from Supabase Postgres to local Postgres.
 *
 * Two modes:
 *   1. Full copy  (default)  — truncates target tables, copies everything.
 *   2. Delta sync (--delta)  — copies only rows created/updated after the last sync.
 *
 * Prerequisites:
 *   - Source Supabase DB connection string in INSTANTLY_SOURCE_DB_URL
 *     (Supabase → Settings → Database → Connection string → Transaction pooler, port 6543).
 *   - Target local Postgres in INSTANTLY_DATABASE_URL
 *     (e.g. postgresql://instantly:pass@127.0.0.1:5433/instantly).
 *   - Schema already applied to target (ensureDatabase.js handles this).
 *
 * Usage:
 *   node app/scripts/migrate-instantly-to-local-pg.mjs          # full copy
 *   node app/scripts/migrate-instantly-to-local-pg.mjs --delta   # incremental
 *   node app/scripts/migrate-instantly-to-local-pg.mjs --verify  # count comparison only
 */

import { createRequire } from 'module';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const { config } = require('dotenv');
config({ path: resolve(__dirname, '../../.env') });

const { Client } = require('pg');

const TABLES = [
  { name: 'instantly_campaign_catalog', pk: 'id', tsCol: 'synced_at' },
  { name: 'instantly_webhook_events', pk: 'id', tsCol: 'created_at' },
  { name: 'instantly_lead_qualifications', pk: 'id', tsCol: 'updated_at' },
  { name: 'user_instantly_campaign_preferences', pk: 'id', tsCol: 'created_at' },
  { name: 'client_instantly_access', pk: 'id', tsCol: 'created_at' },
  { name: 'client_campaign_leads', pk: 'id', tsCol: 'synced_at' },
  { name: 'instantly_lead_imports', pk: 'id', tsCol: 'created_at' },
  { name: 'instantly_briefs', pk: 'id', tsCol: 'created_at' },
  { name: 'instantly_brief_campaigns', pk: 'id', tsCol: 'created_at' },
  { name: 'client_telegram_chats', pk: 'id', tsCol: 'created_at' },
  { name: 'client_forwarded_leads', pk: 'id', tsCol: 'created_at' },
  { name: 'client_lead_comments', pk: 'id', tsCol: 'created_at' },
];

const BATCH = 500;

function log(msg) {
  console.log(`[migrate] ${msg}`);
}

function sslConfig(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith('supabase.co')) return { rejectUnauthorized: false };
    const mode = parsed.searchParams.get('sslmode');
    if (mode && mode !== 'disable') return { rejectUnauthorized: false };
  } catch { /* ignore */ }
  return undefined;
}

async function connect(url, label) {
  const ssl = sslConfig(url);
  const client = new Client({ connectionString: url, ssl });
  await client.connect();
  await client.query('SELECT 1');
  log(`${label}: connected`);
  return client;
}

async function getCount(client, table) {
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0].n;
}

async function getMaxTs(client, table, tsCol) {
  const { rows } = await client.query(`SELECT max(${tsCol}) AS ts FROM ${table}`);
  return rows[0].ts;
}

async function getColumns(client, table) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((r) => r.column_name);
}

async function fullCopy(src, dst) {
  for (const table of TABLES) {
    log(`→ ${table.name}`);

    const srcCount = await getCount(src, table.name);
    log(`  source: ${srcCount} rows`);

    if (srcCount === 0) {
      log('  empty, skipping');
      continue;
    }

    const cols = await getColumns(src, table.name);
    const dstCols = await getColumns(dst, table.name);
    const common = cols.filter((c) => dstCols.includes(c));

    if (common.length === 0) {
      log(`  WARNING: no common columns, skipping`);
      continue;
    }

    const colList = common.join(', ');
    const placeholders = common.map((_, i) => `$${i + 1}`).join(', ');
    const conflict = `ON CONFLICT (${table.pk}) DO NOTHING`;

    let offset = 0;
    let copied = 0;

    while (true) {
      const { rows } = await src.query(
        `SELECT ${colList} FROM ${table.name} ORDER BY ${table.pk} LIMIT ${BATCH} OFFSET ${offset}`,
      );
      if (rows.length === 0) break;

      await dst.query('BEGIN');
      try {
        for (const row of rows) {
          const vals = common.map((c) => row[c]);
          await dst.query(
            `INSERT INTO ${table.name} (${colList}) VALUES (${placeholders}) ${conflict}`,
            vals,
          );
        }
        await dst.query('COMMIT');
      } catch (err) {
        await dst.query('ROLLBACK');
        throw err;
      }

      copied += rows.length;
      offset += rows.length;
      if (rows.length < BATCH) break;
    }

    log(`  copied: ${copied} rows`);
  }
}

async function deltaCopy(src, dst) {
  for (const table of TABLES) {
    log(`→ ${table.name} (delta)`);

    const dstMax = await getMaxTs(dst, table.name, table.tsCol);
    if (!dstMax) {
      log(`  target is empty — run full copy first (skipping)`);
      continue;
    }

    const cols = await getColumns(src, table.name);
    const dstCols = await getColumns(dst, table.name);
    const common = cols.filter((c) => dstCols.includes(c));
    const colList = common.join(', ');
    const placeholders = common.map((_, i) => `$${i + 1}`).join(', ');
    const updateSet = common
      .filter((c) => c !== table.pk)
      .map((c) => `${c} = EXCLUDED.${c}`)
      .join(', ');
    const upsert = `ON CONFLICT (${table.pk}) DO UPDATE SET ${updateSet}`;

    const { rows } = await src.query(
      `SELECT ${colList} FROM ${table.name} WHERE ${table.tsCol} > $1 ORDER BY ${table.pk}`,
      [dstMax],
    );

    if (rows.length === 0) {
      log('  no new rows');
      continue;
    }

    await dst.query('BEGIN');
    try {
      for (const row of rows) {
        const vals = common.map((c) => row[c]);
        await dst.query(
          `INSERT INTO ${table.name} (${colList}) VALUES (${placeholders}) ${upsert}`,
          vals,
        );
      }
      await dst.query('COMMIT');
    } catch (err) {
      await dst.query('ROLLBACK');
      throw err;
    }

    log(`  upserted: ${rows.length} rows`);
  }
}

async function verify(src, dst) {
  log('');
  log('Verification (row counts):');
  let allMatch = true;
  for (const table of TABLES) {
    const srcN = await getCount(src, table.name);
    const dstN = await getCount(dst, table.name);
    const ok = srcN === dstN;
    if (!ok) allMatch = false;
    console.log(`  ${ok ? 'OK' : 'MISMATCH'} ${table.name}: source=${srcN}, target=${dstN}`);
  }
  return allMatch;
}

async function main() {
  const sourceUrl = (process.env.INSTANTLY_SOURCE_DB_URL || '').trim();
  const targetUrl = (process.env.INSTANTLY_DATABASE_URL || '').trim();

  if (!sourceUrl) {
    console.error('INSTANTLY_SOURCE_DB_URL is not set. Set it to the Supabase Postgres transaction pooler URL.');
    process.exit(1);
  }
  if (!targetUrl) {
    console.error('INSTANTLY_DATABASE_URL is not set. Set it to the local Postgres URL.');
    process.exit(1);
  }

  const mode = process.argv.includes('--delta')
    ? 'delta'
    : process.argv.includes('--verify')
      ? 'verify'
      : 'full';

  log(`Mode: ${mode}`);
  log('Connecting...');

  const src = await connect(sourceUrl, 'source (Supabase)');
  const dst = await connect(targetUrl, 'target (local)');

  try {
    if (mode === 'full') {
      await fullCopy(src, dst);
    } else if (mode === 'delta') {
      await deltaCopy(src, dst);
    }

    const ok = await verify(src, dst);
    log(ok ? 'All counts match.' : 'Some counts differ — review the output above.');
  } finally {
    await src.end();
    await dst.end();
  }

  log('Done.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
