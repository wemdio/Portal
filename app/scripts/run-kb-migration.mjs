import 'dotenv/config';
import pg from 'pg';
import { readFileSync } from 'fs';

const sql = readFileSync('../supabase/migrations/20260320_0004_kb_update_categories.sql', 'utf8');

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query(sql);
  console.log('Migration applied successfully');
} catch (e) {
  console.error('Migration error:', e.message);
} finally {
  await client.end();
}
