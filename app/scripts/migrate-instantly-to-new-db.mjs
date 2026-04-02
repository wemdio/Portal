/**
 * Скрипт переноса данных Instantly-таблиц из prod → PolzaInstantlyDB.
 *
 * Предварительно: схема уже создана в новой БД (через Dashboard SQL Editor).
 * Скрипт переносит только данные через supabase-js REST API.
 *
 * Запуск:
 *   node app/scripts/migrate-instantly-to-new-db.mjs
 */

import { createRequire } from 'module';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const { config } = require('dotenv');
config({ path: resolve(__dirname, '../../.env') });

const { createClient } = require('@supabase/supabase-js');

// ─── Credentials ──────────────────────────────────────────────────────────────

const PROD_URL = 'https://whhkkmfcmstawodnghzw.supabase.co';
const PROD_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndoaGtrbWZjbXN0YXdvZG5naHp3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjUzODEwOCwiZXhwIjoyMDgyMTE0MTA4fQ.DLCzyTF-yRX57MFT_xHKPXcl3xsuPUACGARWnVi5i6k';

const NEW_URL = process.env.INSTANTLY_SUPABASE_URL;
const NEW_KEY = process.env.INSTANTLY_SUPABASE_SERVICE_ROLE_KEY;

if (!NEW_URL || !NEW_KEY) {
  console.error('❌ INSTANTLY_SUPABASE_URL или INSTANTLY_SUPABASE_SERVICE_ROLE_KEY не заданы в .env');
  process.exit(1);
}

const prod = createClient(PROD_URL, PROD_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const newDb = createClient(NEW_URL, NEW_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── Tables: order matters (webhook_events before qualifications) ─────────────

const TABLES = [
  {
    name: 'instantly_campaign_catalog',
    select: 'id,name,status,timestamp_created,timestamp_updated,synced_at,emails_sent_count,open_count,reply_count,new_leads_contacted_count,bounced_count,unsubscribed_count,analytics_synced_at',
    conflictCol: 'id',
  },
  {
    name: 'instantly_webhook_events',
    select: 'id,event_type,campaign_id,lead_email,thread_id,email_id,payload,processed,created_at',
    conflictCol: 'id',
  },
  {
    name: 'instantly_lead_qualifications',
    select: 'id,webhook_event_id,campaign_id,campaign_name,lead_email,lead_name,company_name,thread_id,reply_subject,reply_preview,reply_body,last_outbound_preview,last_outbound_ue_type,status,proposal_seen,interest_signals,ai_reason,ai_confidence,error_message,instantly_email_id,instantly_lead_id,reply_timestamp,created_at,updated_at',
    conflictCol: 'id',
  },
  {
    name: 'user_instantly_campaign_preferences',
    select: 'id,user_id,campaign_id,created_at',
    conflictCol: 'id',
  },
  {
    name: 'client_instantly_access',
    select: 'id,client_user_id,resource_type,resource_id,created_by,created_at,leads_synced_at',
    conflictCol: 'id',
  },
  {
    name: 'client_campaign_leads',
    select: 'id,client_user_id,campaign_id,email,first_name,last_name,company_name,website,linkedin_url,synced_at',
    conflictCol: 'id',
  },
  {
    name: 'instantly_lead_imports',
    select: 'id,project_id,campaign_id,campaign_name,lead_list_id,lead_list_name,leads_count,imported_by,tab_name,created_at',
    conflictCol: 'id',
  },
];

const PAGE_SIZE = 1000;

function log(msg) {
  console.log(`[migrate] ${msg}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function readAllRows(client, tableName, selectCols) {
  const all = [];
  let from = 0;

  for (;;) {
    const { data, error } = await client
      .from(tableName)
      .select(selectCols)
      .range(from, from + PAGE_SIZE - 1);

    if (error) throw new Error(`SELECT ${tableName}: ${error.message}`);
    if (!data || data.length === 0) break;

    all.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return all;
}

async function upsertBatched(client, tableName, rows, conflictCol) {
  const BATCH = 500;
  let total = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await client
      .from(tableName)
      .upsert(batch, { onConflict: conflictCol, ignoreDuplicates: true });

    if (error) throw new Error(`UPSERT ${tableName}: ${error.message}`);
    total += batch.length;
  }

  return total;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('Проверяю подключения...');

  // Проверка prod
  const { error: prodErr } = await prod.from('instantly_campaign_catalog').select('id').limit(1);
  if (prodErr) throw new Error(`Prod недоступен: ${prodErr.message}`);
  log('✅ Prod-БД: подключено');

  // Проверка новой БД
  const { error: newErr } = await newDb.from('instantly_campaign_catalog').select('id').limit(1);
  if (newErr) throw new Error(`Новая БД недоступна: ${newErr.message}. Убедитесь, что схема создана в Dashboard.`);
  log('✅ Новая БД: подключено\n');

  // ── Перенос данных ────────────────────────────────────────────────────────

  const results = [];

  for (const table of TABLES) {
    log(`→ ${table.name}`);

    const rows = await readAllRows(prod, table.name, table.select);
    log(`  Прочитано из prod: ${rows.length} строк`);

    if (rows.length === 0) {
      results.push({ table: table.name, prod: 0, migrated: 0 });
      log(`  ⏭  Пусто, пропускаю`);
      continue;
    }

    const migrated = await upsertBatched(newDb, table.name, rows, table.conflictCol);
    log(`  ✅ Вставлено: ${migrated} строк`);
    results.push({ table: table.name, prod: rows.length, migrated });
  }

  // ── Верификация ───────────────────────────────────────────────────────────

  log('\n🔍 Верификация (COUNT):\n');

  for (const table of TABLES) {
    const { count: prodCount } = await prod
      .from(table.name)
      .select('*', { count: 'exact', head: true });
    const { count: newCount } = await newDb
      .from(table.name)
      .select('*', { count: 'exact', head: true });

    const ok = prodCount === newCount ? '✅' : '⚠️ ';
    console.log(`  ${ok} ${table.name}: prod=${prodCount ?? '?'}, new=${newCount ?? '?'}`);
  }

  log('\n🎉 Перенос данных завершён!\n');
}

main().catch((err) => {
  console.error('❌ Ошибка:', err.message);
  process.exit(1);
});
