/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * SUPABASE_DB_URL — прямое подключение к Postgres для миграций.
 *
 * ВАЖНО: используйте Transaction pooler (порт 6543), НЕ Session pooler (5432).
 * Session mode ограничен pool_size подключениями — при нескольких сервисах
 * (portal + workers) возникает MaxClientsInSessionMode.
 *
 * Supabase Dashboard → Connect → "Transaction" (порт 6543).
 * Формат: postgres://user:pass@...pooler.supabase.com:6543/postgres
 *
 * Для второй Instantly DB используется INSTANTLY_DATABASE_URL.
 * Если переменная не задана — миграции для Instantly DB пропускаются.
 */
const path = require('path');
const fs = require('fs/promises');
const dns = require('dns');
const dnsPromises = dns.promises;
const dotenv = require('dotenv');
const { Client } = require('pg');

const MAX_RETRIES = 6;
const RETRY_DELAY_MS = 5000;
const MAX_CLIENTS_HINT = `
[db] FIX: MaxClientsInSessionMode — исчерпан лимит подключений Session pooler.
Используйте Transaction pooler (порт 6543):
  Supabase Dashboard → Connect → Transaction pooler
  Замените в SUPABASE_DB_URL порт 5432 на 6543.
`;

if (typeof dns.setDefaultResultOrder === 'function') {
  const order = (process.env.DB_DNS_RESULT_ORDER || 'ipv4first').toLowerCase();
  if (order === 'ipv4first' || order === 'verbatim') {
    dns.setDefaultResultOrder(order);
  } else {
    dns.setDefaultResultOrder('ipv4first');
  }
}

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
    msg.includes('max clients reached') ||
    msg.includes('Tenant or user not found')
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

function resolveMigrationsDirCandidates(subdir) {
  if (subdir === 'migrations' && process.env.DB_MIGRATIONS_DIR) {
    return [process.env.DB_MIGRATIONS_DIR];
  }

  // In local dev, cwd is usually `app/` → migrations are `../supabase/<subdir>`.
  // In Docker image we copy migrations into `/app/supabase/<subdir>`.
  return [
    path.resolve(process.cwd(), 'supabase', subdir),
    path.resolve(process.cwd(), '..', 'supabase', subdir),
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
      const ips = await dnsPromises.resolve4(hostname);
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

/**
 * Применяет все непримененные SQL-файлы из migrationsDir к указанной БД.
 * Состояние применённых миграций хранится в таблице trackingTable.
 */
async function runMigrations(dbUrl, migrationsDir, trackingTable) {
  if (!dbUrl) {
    console.warn(`[db] Не задан URL базы данных (${trackingTable}). Пропускаем миграции.`);
    return;
  }

  try {
    await fs.access(migrationsDir);
  } catch {
    console.warn(`[db] Папка миграций не найдена: ${migrationsDir}. Пропускаем.`);
    return;
  }

  if (process.env.NODE_ENV === 'production' && dbUrl.includes(':5432') && !dbUrl.includes(':6543')) {
    console.warn(`[db] ВНИМАНИЕ (${trackingTable}): используется порт 5432 (Session pooler). Рекомендуется 6543 (Transaction pooler).`);
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
        `create table if not exists public.${trackingTable} (
          name text primary key,
          applied_at timestamptz not null default now()
        );`,
      );

      const { rows } = await client.query(
        `select name from public.${trackingTable}`,
      );
      const applied = new Set(rows.map((row) => row.name));

      let files = await fs.readdir(migrationsDir);
      files = files.filter((file) => file.endsWith('.sql')).sort();

      for (const file of files) {
        if (applied.has(file)) continue;
        const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
        const trimmed = sql.trim();

        console.log(`[db] Применяем миграцию (${trackingTable}): ${file}`);
        await client.query('begin');
        try {
          if (trimmed) {
            await client.query(sql);
          }
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
        const isMaxClients = (err && err.message && String(err.message).includes('MaxClientsInSessionMode'));
        if (isMaxClients && attempt === 1) console.warn(MAX_CLIENTS_HINT);
        console.warn(`[db] Подключение не удалось (${trackingTable}, попытка ${attempt}/${MAX_RETRIES}), повтор через ${RETRY_DELAY_MS} мс:`, err.message);
        await sleep(RETRY_DELAY_MS);
      } else {
        if (lastError && lastError.message && String(lastError.message).includes('MaxClientsInSessionMode')) {
          console.error(MAX_CLIENTS_HINT);
        }
        throw lastError;
      }
    }
  }
  throw lastError;
}

async function ensureDatabase() {
  loadEnvFiles();

  // ── Основная БД ──────────────────────────────────────────────────────────────
  const mainDbUrl = resolveDbUrl();
  const mainMigrationsDirCandidates = resolveMigrationsDirCandidates('migrations');
  let mainMigrationsDir = '';
  for (const dir of mainMigrationsDirCandidates) {
    try {
      await fs.access(dir);
      mainMigrationsDir = dir;
      break;
    } catch {
      // try next
    }
  }

  if (!mainDbUrl) {
    console.warn('[db] Не задан URL базы данных. Пропускаем миграции.');
  } else if (!mainMigrationsDir) {
    console.warn(`[db] Папка миграций не найдена. Пробовали: ${mainMigrationsDirCandidates.join(', ')}. Пропускаем.`);
  } else {
    await runMigrations(mainDbUrl, mainMigrationsDir, 'portal_migrations');
  }

  // ── Instantly DB ─────────────────────────────────────────────────────────────
  const instantlyDbUrl = (process.env.INSTANTLY_DATABASE_URL || '').trim();
  if (instantlyDbUrl) {
    const instantlyMigrationsDirCandidates = resolveMigrationsDirCandidates('instantly-migrations');
    let instantlyMigrationsDir = '';
    for (const dir of instantlyMigrationsDirCandidates) {
      try {
        await fs.access(dir);
        instantlyMigrationsDir = dir;
        break;
      } catch {
        // try next
      }
    }

    if (!instantlyMigrationsDir) {
      console.warn(`[db] Папка instantly-migrations не найдена. Пробовали: ${instantlyMigrationsDirCandidates.join(', ')}. Пропускаем.`);
    } else {
      await runMigrations(instantlyDbUrl, instantlyMigrationsDir, 'portal_instantly_migrations');
    }
  }
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
