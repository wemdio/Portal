/**
 * Standalone migrator for Instantly DB.
 * Applies SQL files from supabase/instantly-migrations/ to the database
 * specified by INSTANTLY_DATABASE_URL.
 *
 * This is a trimmed version of the main ensureDatabase.js — it skips
 * the primary Portal DB and only handles Instantly migrations.
 */
const path = require('path');
const fs = require('fs/promises');
const { Client } = require('pg');

const MAX_RETRIES = 6;
const RETRY_DELAY_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableDbError(err) {
  const msg = err && err.message ? String(err.message) : '';
  const code = err && err.code;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'ENETUNREACH' ||
    msg.includes('Connection terminated') ||
    msg.includes('max clients reached')
  );
}

async function runMigrations(dbUrl, migrationsDir, trackingTable) {
  if (!dbUrl) {
    console.warn(`[db] No database URL provided (${trackingTable}). Skipping.`);
    return;
  }

  try {
    await fs.access(migrationsDir);
  } catch {
    console.warn(`[db] Migrations dir not found: ${migrationsDir}. Skipping.`);
    return;
  }

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const client = new Client({ connectionString: dbUrl });
    try {
      await client.connect();
      await client.query('select 1');

      await client.query(
        `create table if not exists public.${trackingTable} (
          name text primary key,
          applied_at timestamptz not null default now()
        );`,
      );

      const { rows } = await client.query(
        `select name from public.${trackingTable}`,
      );
      const applied = new Set(rows.map((r) => r.name));

      let files = await fs.readdir(migrationsDir);
      files = files.filter((f) => f.endsWith('.sql')).sort();

      for (const file of files) {
        if (applied.has(file)) continue;
        const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
        const trimmed = sql.trim();

        console.log(`[db] Applying migration (${trackingTable}): ${file}`);
        await client.query('begin');
        try {
          if (trimmed) await client.query(sql);
          await client.query(
            `insert into public.${trackingTable} (name) values ($1)`,
            [file],
          );
          await client.query('commit');
        } catch (err) {
          await client.query('rollback');
          throw err;
        }
      }

      await client.end();
      return;
    } catch (err) {
      await client.end().catch(() => {});
      lastError = err;
      if (attempt < MAX_RETRIES && isRetryableDbError(err)) {
        console.warn(
          `[db] Connection failed (${trackingTable}, attempt ${attempt}/${MAX_RETRIES}), retrying in ${RETRY_DELAY_MS}ms:`,
          err.message,
        );
        await sleep(RETRY_DELAY_MS);
      } else {
        throw lastError;
      }
    }
  }
  throw lastError;
}

async function main() {
  const dbUrl = (process.env.INSTANTLY_DATABASE_URL || '').trim();
  if (!dbUrl) {
    console.error('[db] INSTANTLY_DATABASE_URL is not set. Exiting.');
    process.exit(1);
  }

  const candidates = [
    path.resolve(process.cwd(), 'supabase', 'instantly-migrations'),
    path.resolve(process.cwd(), '..', 'supabase', 'instantly-migrations'),
  ];

  let migrationsDir = '';
  for (const dir of candidates) {
    try {
      await fs.access(dir);
      migrationsDir = dir;
      break;
    } catch {
      // try next
    }
  }

  if (!migrationsDir) {
    console.error(`[db] Migrations dir not found. Tried: ${candidates.join(', ')}`);
    process.exit(1);
  }

  await runMigrations(dbUrl, migrationsDir, 'portal_instantly_migrations');
  console.log('[db] Instantly migrations complete.');
}

main().catch((err) => {
  console.error('[db] Migration error:', err);
  process.exit(1);
});
