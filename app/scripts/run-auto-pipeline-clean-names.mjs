#!/usr/bin/env node
/**
 * One-shot CLI: backfill ОЧИЩЕННЫХ названий (company_name) для уже собранных
 * dry-run строк клиента. Чистит ТЕМ ЖЕ AI, что кнопка «Очистить названия».
 *
 * Использование:
 *   cd app
 *   npm run build:workers           # один раз, чтобы собрать бандл
 *   node --env-file=../.env scripts/run-auto-pipeline-clean-names.mjs <client_user_id>
 *
 * Печатает total / updated / changed / errors. changed≈total → чистка работает;
 * changed=0 → prod-AI не отвечает (ключ/модель/квота).
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.resolve(__dirname, '..', 'dist', 'workers', 'autoPipelineCleanNamesCli.js');
const bundleUrl = pathToFileURL(bundlePath).href;

let runNameBackfill;
let supabaseAdmin;
try {
  const mod = await import(bundleUrl);
  runNameBackfill = mod.runNameBackfill;
  supabaseAdmin = mod.supabaseAdmin;
} catch (err) {
  console.error('');
  console.error('FATAL: не нашёл bundled-версию.');
  console.error('Сначала собери: npm run build:workers');
  console.error('');
  console.error('Detail:', err.message);
  process.exit(1);
}

if (!supabaseAdmin) {
  console.error('FATAL: supabaseAdmin не инициализирован. Проверь .env');
  process.exit(1);
}

const clientId = process.argv[2];
if (!clientId) {
  console.error('FATAL: укажи client_user_id первым аргументом.');
  process.exit(1);
}

console.log(`Backfill очистки названий для клиента ${clientId}...`);
try {
  const r = await runNameBackfill(clientId);
  console.log('');
  console.log(`  total:   ${r.total}    ← готовых строк без company_name`);
  console.log(`  updated: ${r.updated}    ← записано в company_name`);
  console.log(`  changed: ${r.changed}    ← имя РЕАЛЬНО изменилось (AI сработал)`);
  console.log(`  errors:  ${r.errors}`);
  console.log('');
  if (r.total > 0 && r.changed === 0) {
    console.log('⚠️  Ни одно имя не изменилось — prod-AI чистки не отвечает. Проверь OPENROUTER_CLEANUP_API_KEY / модель policy/cleanup.');
  }
} catch (err) {
  console.error('💥 crashed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}

process.exit(0);
