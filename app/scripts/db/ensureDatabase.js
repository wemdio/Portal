/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Для продакшена используйте connection pooler Supabase (Transaction mode, порт 6543)
 * в SUPABASE_DB_URL, чтобы избежать ошибки "MaxClientsInSessionMode: max clients reached".
 * В дашборде: Project Settings → Database → Connection string → "Transaction" (port 6543).
 */
const path = require('path');
const fs = require('fs/promises');
const dns = require('dns').promises;
const dotenv = require('dotenv');
const { Client } = require('pg');

const MIGRATION_TABLE = 'portal_migrations';

const MAX_RETRIES = 4;
const RETRY_DELAY_MS = 3000;

function isRetryableDbError(err) {
  const msg = (err && err.message) ? String(err.message) : '';
  const code = err && err.code;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'ENETUNREACH' ||
    msg.includes('Connection terminated') ||
    msg.includes('MaxClientsInSessionMode') ||
    msg.includes('max clients reached')
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadEnvFiles() {
  const candidates = [
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '..', '.env.local'),
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

function resolveMigrationsDirCandidates() {
  if (process.env.DB_MIGRATIONS_DIR) return [process.env.DB_MIGRATIONS_DIR];

  // In local dev, cwd is usually `app/` → migrations are `../supabase/migrations`.
  // In Docker image we copy migrations into `/app/supabase/migrations`.
  return [
    path.resolve(process.cwd(), 'supabase', 'migrations'),
    path.resolve(process.cwd(), '..', 'supabase', 'migrations'),
  ];
}

/**
 * Преобразует hostname в IPv4, чтобы избежать ENETUNREACH на серверах без IPv6
 * (Supabase pooler по умолчанию может отдавать AAAA).
 */
async function connectionConfigWithIPv4(dbUrl, ssl) {
  try {
    const parsed = new URL(dbUrl);
    const hostname = parsed.hostname;
    const port = parsed.port || '5432';
    const database = (parsed.pathname || '/postgres').slice(1) || 'postgres';
    const user = decodeURIComponent(parsed.username || '');
    const password = decodeURIComponent(parsed.password || '');

    let host = hostname;
    try {
      const ips = await dns.resolve4(hostname);
      if (ips && ips[0]) {
        host = ips[0];
      }
    } catch {
      // оставляем hostname, пусть pg резолвит сам
    }

    return {
      host,
      port: Number(port),
      user,
      password,
      database,
      ssl,
    };
  } catch {
    return { connectionString: dbUrl, ssl };
  }
}

async function ensureDatabase() {
  loadEnvFiles();

  const dbUrl = resolveDbUrl();
  if (!dbUrl) {
    console.warn('[db] Не задан URL базы данных. Пропускаем миграции.');
    return;
  }

  const dirCandidates = resolveMigrationsDirCandidates();
  let migrationsDir = '';
  for (const dir of dirCandidates) {
    try {
      await fs.access(dir);
      migrationsDir = dir;
      break;
    } catch {
      // try next
    }
  }
  if (!migrationsDir) {
    console.warn(`[db] Папка миграций не найдена. Пробовали: ${dirCandidates.join(', ')}. Пропускаем.`);
    return;
  }
  const ssl = shouldUseSsl(dbUrl) ? { rejectUnauthorized: false } : undefined;
  const clientConfig = await connectionConfigWithIPv4(dbUrl, ssl);

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const client = new Client(clientConfig);
    try {
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
      return;
    } catch (err) {
      await client.end().catch(() => {});
      lastError = err;
      if (attempt < MAX_RETRIES && isRetryableDbError(err)) {
        console.warn(`[db] Подключение не удалось (попытка ${attempt}/${MAX_RETRIES}), повтор через ${RETRY_DELAY_MS} мс:`, err.message);
        await sleep(RETRY_DELAY_MS);
      } else {
        throw err;
      }
    }
  }
  throw lastError;
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
