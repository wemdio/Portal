#!/usr/bin/env node
/**
 * sync-portal-mirror.mjs — ночное зеркало портальных данных в instantly_dataset
 * («управленческий контур»: проекты, периоды, КПИ-история, задачи, спецы,
 * мост проект↔кампания, квалификации лидов, передачи клиентам).
 *
 * Источники:
 *   MAIN_DB_URL               — main-postgres Портала (обязателен; на проде добавляется
 *                               деплоем из /home/Portal/prod/.env DATABASE_URL)
 *   INSTANTLY_DATASET_DB_URL  — датасет (куда пишем); из него же выводится URL
 *                               операционной instantly-БД (тот же кластер, path=/instantly)
 *
 * Каждая таблица: DDL из 018 (идемпотентно) → TRUNCATE → bulk INSERT в одной транзакции.
 * Кураторский срез: НЕ тянем брифы/handoff/финансы/контакты сотрудников/тела переписки/TG-id.
 * Flags: --dry (только счётчики источников, без записи).
 */
import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const DRY = process.argv.includes('--dry');
function loadEnv() {
  if (process.env.INSTANTLY_DATASET_DB_URL) return process.env;
  try {
    const txt = readFileSync(new URL('../../../.env', import.meta.url), 'utf8');
    for (const l of txt.split('\n')) {
      if (!l.includes('=') || l.trim().startsWith('#')) continue;
      const i = l.indexOf('='); const k = l.slice(0, i).trim();
      if (!(k in process.env)) process.env[k] = l.slice(i + 1).trim();
    }
  } catch { /* prod: только process.env */ }
  return process.env;
}
const env = loadEnv();
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
if (!env.INSTANTLY_DATASET_DB_URL) { console.error('FATAL: INSTANTLY_DATASET_DB_URL missing'); process.exit(1); }
if (!env.MAIN_DB_URL) { console.error('FATAL: MAIN_DB_URL missing (main-postgres Портала)'); process.exit(1); }
const instUrl = new URL(env.INSTANTLY_DATASET_DB_URL); instUrl.pathname = '/instantly';

// [зеркальная таблица, источник ('main'|'inst'), SQL выборки из источника, колонки зеркала]
const JOBS = [
  ['portal_projects', 'main', `
    SELECT id, name, client, status, project_type, specialist, specialist_user_id, manager,
           kpi_plan, kpi_fact, contacts_obligation, contacts_done, contacts_done_synced_at,
           deadline, launch_date, contract_date, region, lead_source, work_format, created_at, updated_at
    FROM projects`,
    ['id','name','client','status','project_type','specialist','specialist_user_id','manager','kpi_plan','kpi_fact','contacts_obligation','contacts_done','contacts_done_synced_at','deadline','launch_date','contract_date','region','lead_source','work_format','created_at','updated_at']],
  ['portal_project_periods', 'main', `
    SELECT id, project_id, name, status, period_start, period_end,
           contacts_obligation, contacts_done, kpi_plan, kpi_fact, deadline, created_at
    FROM project_periods`,
    ['id','project_id','name','status','period_start','period_end','contacts_obligation','contacts_done','kpi_plan','kpi_fact','deadline','created_at']],
  ['portal_contacts_history', 'main', `
    SELECT id, project_id, period_id, recorded_at, contacts_done, kpi_fact FROM project_contacts_history`,
    ['id','project_id','period_id','recorded_at','contacts_done','kpi_fact']],
  ['portal_tasks', 'main', `
    SELECT id, project_id, title, status, specialist, deadline, board_id, column_id, created_at, updated_at FROM tasks`,
    ['id','project_id','title','status','specialist','deadline','board_id','column_id','created_at','updated_at']],
  ['portal_task_boards', 'main', `SELECT id, name, is_default, position, created_at FROM task_boards`,
    ['id','name','is_default','position','created_at']],
  ['portal_task_board_columns', 'main', `SELECT id, board_id, title, position, status, created_at FROM task_board_columns`,
    ['id','board_id','title','position','status','created_at']],
  ['portal_specialists', 'main', `SELECT id, full_name, role, created_at FROM profiles`,
    ['id','full_name','role','created_at']],
  ['portal_project_notes', 'main', `SELECT id, project_id, title, created_at FROM project_notes`,
    ['id','project_id','title','created_at']],
  ['portal_project_campaigns', 'inst', `
    SELECT pic.project_id, pic.campaign_id, pic.match_source, pic.match_confidence, pic.created_at
    FROM project_instantly_campaigns pic
    WHERE NOT EXISTS (SELECT 1 FROM project_instantly_campaigns_denylist d
                      WHERE d.project_id = pic.project_id AND d.campaign_id = pic.campaign_id)`,
    ['project_id','campaign_id','match_source','match_confidence','created_at']],
  ['portal_period_campaigns', 'inst', `
    SELECT project_id, period_id, campaign_id, baseline_contacts, created_at FROM project_period_instantly_campaigns`,
    ['project_id','period_id','campaign_id','baseline_contacts','created_at']],
  ['portal_lead_qualifications', 'inst', `
    SELECT id, campaign_id, campaign_name, lead_email, lead_name, company_name,
           status, left(coalesce(ai_reason,''), 300) AS ai_reason, ai_confidence,
           reply_timestamp, read_at, read_by, created_at
    FROM instantly_lead_qualifications`,
    ['id','campaign_id','campaign_name','lead_email','lead_name','company_name','status','ai_reason','ai_confidence','reply_timestamp','read_at','read_by','created_at']],
  ['portal_kb_documents', 'main', `
    SELECT id, title, category, description, content_text, source_type, token_count,
           user_id AS uploaded_by, created_at, updated_at
    FROM kb_documents
    WHERE status = 'ready' AND category IN ('cases','product_info')`,
    ['id','title','category','description','content_text','source_type','token_count','uploaded_by','created_at','updated_at']],
  // client_email НЕ тянем (аудит 06.07): в handoff-auto строках он равен handoff_email проекта.
  ['portal_forwarded_leads', 'inst', `
    SELECT id, campaign_id, campaign_name, lead_email, lead_name, company_name, status,
           client_user_id, forwarded_by, forwarded_via, reply_timestamp, created_at
    FROM client_forwarded_leads`,
    ['id','campaign_id','campaign_name','lead_email','lead_name','company_name','status','client_user_id','forwarded_by','forwarded_via','reply_timestamp','created_at']],
];

(async () => {
  const t0 = Date.now();
  const main = new Client({ connectionString: env.MAIN_DB_URL, statement_timeout: 120_000 });
  const inst = new Client({ connectionString: instUrl.toString(), statement_timeout: 120_000 });
  const ds = new Client({ connectionString: env.INSTANTLY_DATASET_DB_URL, statement_timeout: 0 });
  await Promise.all([main.connect(), inst.connect(), ds.connect()]);
  try {
    if (!DRY) {
      await ds.query(readFileSync(new URL('./018_portal_mirror.sql', import.meta.url), 'utf8'));
      log('DDL 018 applied (idempotent)');
    }
    for (const [table, srcName, sql, cols] of JOBS) {
      const src = srcName === 'main' ? main : inst;
      const { rows } = await src.query(sql);
      if (DRY) { log(`[dry] ${table}: source ${rows.length} rows`); continue; }
      await ds.query('BEGIN');
      try {
        await ds.query(`TRUNCATE ${table}`);
        const CHUNK = Math.max(1, Math.floor(60000 / cols.length / 10) * 10);
        for (let i = 0; i < rows.length; i += CHUNK) {
          const chunk = rows.slice(i, i + CHUNK);
          const vals = []; const params = []; let p = 1;
          for (const r of chunk) {
            vals.push(`(${cols.map(() => `$${p++}`).join(',')})`);
            for (const col of cols) params.push(r[col]);
          }
          if (vals.length) await ds.query(
            `INSERT INTO ${table} (${cols.join(',')}) VALUES ${vals.join(',')}`, params);
        }
        await ds.query(
          `INSERT INTO portal_mirror_meta (table_name, rows, synced_at) VALUES ($1,$2, now())
           ON CONFLICT (table_name) DO UPDATE SET rows=EXCLUDED.rows, synced_at=now()`,
          [table, rows.length]);
        await ds.query('COMMIT');
        log(`${table}: ${rows.length} rows`);
      } catch (e) { await ds.query('ROLLBACK'); throw e; }
    }
    log(`DONE in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  } finally { await Promise.allSettled([main.end(), inst.end(), ds.end()]); }
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
