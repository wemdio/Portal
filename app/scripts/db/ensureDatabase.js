const path = require('path');
const fs = require('fs/promises');
const dotenv = require('dotenv');
const { Client } = require('pg');

const MIGRATION_TABLE = 'portal_migrations';

function loadEnvFiles() {
  const candidates = [
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '..', '.env'),
  ];

  for (const file of candidates) {
    dotenv.config({ path: file });
  }
}

function resolveDbUrl() {
  return (
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DB_URL ||
    process.env.POSTGRES_URL ||
    ''
  ).trim();
}

function shouldUseSsl(dbUrl) {
  const sslEnv = (process.env.DB_SSL || process.env.PGSSLMODE || '').toLowerCase();
  if (sslEnv === 'require' || sslEnv === 'true' || sslEnv === '1') return true;

  try {
    const parsed = new URL(dbUrl);
    const sslmode = parsed.searchParams.get('sslmode');
    if (sslmode && sslmode.toLowerCase() !== 'disable') return true;
    if (parsed.hostname.endsWith('supabase.co')) return true;
  } catch {
    // ignore
  }

  return false;
}

function resolveMigrationsDir() {
  return (
    process.env.DB_MIGRATIONS_DIR ||
    path.resolve(process.cwd(), '..', 'supabase', 'migrations')
  );
}

async function ensureDatabase() {
  loadEnvFiles();

  const dbUrl = resolveDbUrl();
  if (!dbUrl) {
    throw new Error(
      'Не задан URL базы данных. Укажите SUPABASE_DB_URL или DATABASE_URL.',
    );
  }

  const migrationsDir = resolveMigrationsDir();
  const ssl = shouldUseSsl(dbUrl) ? { rejectUnauthorized: false } : undefined;
  const client = new Client({ connectionString: dbUrl, ssl });

  await client.connect();
  await client.query('select 1');

  await client.query(
    `create table if not exists public.${MIGRATION_TABLE} (
      name text primary key,
      applied_at timestamptz not null default now()
    );`,
  );

  const { rows } = await client.query(
    `select name from public.${MIGRATION_TABLE}`,
  );
  const applied = new Set(rows.map((row) => row.name));

  let files = await fs.readdir(migrationsDir);
  files = files.filter((file) => file.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    const trimmed = sql.trim();

    console.log(`[db] Применяем миграцию: ${file}`);
    await client.query('begin');
    try {
      if (trimmed) {
        await client.query(sql);
      }
      await client.query(
        `insert into public.${MIGRATION_TABLE} (name) values ($1)`,
        [file],
      );
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    }
  }

  await client.end();
}

if (require.main === module) {
  ensureDatabase()
    .then(() => {
      console.log('[db] Проверка соединения и миграции завершены');
    })
    .catch((err) => {
      console.error('[db] Ошибка проверки/миграции:', err);
      process.exit(1);
    });
}

module.exports = { ensureDatabase };
