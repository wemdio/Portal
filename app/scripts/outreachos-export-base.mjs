#!/usr/bin/env node
/**
 * Выгрузка готовой базы OutreachOS-прогона в CSV.
 *
 * После measure/боевого прогона финальная сетка конструктора баз лежит в
 * base_constructor_jobs.data (jsonb, грид string[][]). Этот скрипт тянет её и
 * пишет CSV с UTF-8 BOM (Excel-friendly для кириллицы), плюс печатает воронку
 * последнего прогона из outreachos_pipeline_runs.
 *
 * Только main-DB — никакого Instantly.
 *
 * Использование:
 *   cd app
 *   node --env-file=../.env scripts/outreachos-export-base.mjs            # последний outreachos-* job
 *   node --env-file=../.env scripts/outreachos-export-base.mjs <jobId>    # конкретный job
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'node:fs';

function need(name) {
  const v = process.env[name];
  if (!v) { console.error(`FATAL: нет env ${name}`); process.exit(1); }
  return v;
}

const db = createClient(need('NEXT_PUBLIC_SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
});

function toCsv(grid) {
  // RFC4180-ish: оборачиваем в кавычки, удваиваем внутренние кавычки.
  const esc = (cell) => {
    const s = String(cell ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + grid.map((row) => row.map(esc).join(',')).join('\r\n');
}

// HR/recruiting локалпарты — отсев для OutreachOS. ДЕРЖАТЬ В СИНХРОНЕ с
// src/lib/outreachos/excludeLocalParts.ts (standalone .mjs не импортит .ts).
const HR_LOCALPARTS = new Set([
  'hr','hrd','hrm','hrbp','hrgroup','recruit','recruiter','recruiters','recruitment','recruiting',
  'podbor','kadry','kadri','personnel','vacancy','vacancies','vakansia','vakansiya','vakansii',
  'job','jobs','career','careers','rabota',
]);
function isHrEmail(email) {
  const at = String(email ?? '').indexOf('@');
  if (at <= 0) return false;
  const local = String(email).slice(0, at).trim().toLowerCase();
  if (HR_LOCALPARTS.has(local)) return true;
  const m = local.match(/^([a-z]+)(?=[._+\-0-9])/);
  return !!m && HR_LOCALPARTS.has(m[1]);
}
function emailColIdx(header) {
  const lower = (header || []).map((h) => String(h).trim().toLowerCase());
  for (const n of ['email', 'e-mail', 'почта', 'mail']) { const i = lower.indexOf(n); if (i >= 0) return i; }
  return -1;
}

async function main() {
  const jobIdArg = process.argv.find((a) => !a.startsWith('-') && a.length > 20 && a.includes('-'));

  // 1. Воронка последнего прогона.
  const { data: runs } = await db
    .from('outreachos_pipeline_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(1);
  const run = runs?.[0];
  if (run) {
    console.log('=== Последний прогон outreachos_pipeline_runs ===');
    console.log(
      `  status=${run.status} parsed=${run.parsed} new=${run.new_employers} ` +
        `valid=${run.valid_contacts} appended=${run.appended} skipped=${run.skipped}`,
    );
    if (run.error_message) console.log(`  error: ${run.error_message}`);
    console.log(`  base_job_id: ${run.base_job_id ?? '—'}`);
  } else {
    console.log('(в outreachos_pipeline_runs пока нет прогонов)');
  }

  // 2. Грид базы.
  const jobId = jobIdArg || run?.base_job_id;
  let job;
  if (jobId) {
    const { data } = await db
      .from('base_constructor_jobs')
      .select('id, file_name, status, data, result_stats, completed_at')
      .eq('id', jobId)
      .maybeSingle();
    job = data;
  } else {
    const { data } = await db
      .from('base_constructor_jobs')
      .select('id, file_name, status, data, result_stats, completed_at')
      .like('file_name', 'outreachos-%')
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    job = data;
  }

  if (!job) { console.error('\nНе нашёл base_constructor_jobs (job/outreachos-*).'); process.exit(1); }
  const grid = Array.isArray(job.data) ? job.data : null;
  if (!grid || grid.length < 1) { console.error(`\nJob ${job.id} без data-грида (status=${job.status}).`); process.exit(1); }

  // HR-отсев: считаем разбивку и пишем CSV БЕЗ HR-ящиков (как в live-пайплайне).
  const header = grid[0];
  const eIdx = emailColIdx(header);
  const body = grid.slice(1);
  const ready = eIdx >= 0 ? body.filter((r) => !isHrEmail(r[eIdx])) : body;
  const hrDropped = body.length - ready.length;

  const outName = `outreachos-base-${(job.file_name || job.id).replace(/[^a-z0-9-]/gi, '_')}.csv`;
  writeFileSync(outName, toCsv([header, ...ready]), 'utf8');

  console.log('\n=== База ===');
  console.log(`  job ${job.id} (${job.file_name}, status=${job.status})`);
  console.log(`  колонки: ${header?.join(' | ')}`);
  console.log(`  всего валидных: ${body.length} | HR-отсев: ${hrDropped} | готовых (без HR): ${ready.length}`);
  console.log(`  → ${outName} (без HR-ящиков)`);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
