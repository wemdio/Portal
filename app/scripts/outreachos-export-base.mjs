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

  const outName = `outreachos-base-${(job.file_name || job.id).replace(/[^a-z0-9-]/gi, '_')}.csv`;
  writeFileSync(outName, toCsv(grid), 'utf8');

  console.log('\n=== База ===');
  console.log(`  job ${job.id} (${job.file_name}, status=${job.status})`);
  console.log(`  строк: ${grid.length - 1}, колонки: ${grid[0]?.join(' | ')}`);
  console.log(`  → ${outName}`);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
