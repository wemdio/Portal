/**
 * Печатает UUID профиля по email (основная БД portal).
 *
 * Запуск из папки app/ (или из корня — пути к .env резолвятся от файла скрипта):
 *   node scripts/get-user-id.mjs client@example.com
 *
 * UUID нужен, например, для BYO_MAILBOX_PILOT_USER_IDS в .env.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// .env в корне репозитория (../../.env от app/scripts) и app/.env.local
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const email = (process.argv[2] || '').trim().toLowerCase();
if (!email) {
  console.error('Usage: node scripts/get-user-id.mjs <email>');
  process.exit(1);
}

const conn = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!conn) {
  console.error('Не найден SUPABASE_DB_URL / DATABASE_URL в окружении (.env).');
  process.exit(1);
}

const client = new pg.Client({ connectionString: conn });
await client.connect();
try {
  const { rows } = await client.query(
    `select id, email, role, full_name, created_at
       from public.profiles
      where lower(email) = $1
      order by created_at desc`,
    [email],
  );
  if (!rows.length) {
    console.error(`Профиль с email "${email}" не найден.`);
    process.exit(2);
  }
  for (const r of rows) {
    console.log(`UUID: ${r.id}  | ${r.email} | role=${r.role} | ${r.full_name ?? ''}`);
  }
} finally {
  await client.end();
}
