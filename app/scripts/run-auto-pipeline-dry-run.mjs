#!/usr/bin/env node
/**
 * One-shot CLI runner for the HH auto-pipeline в DRY-RUN режиме.
 *
 * Использование:
 *
 *   1. Подготовь .env с креденшалами prod-DB (либо подложи рядом
 *      ../.env). Нужны минимум:
 *        - NEXT_PUBLIC_SUPABASE_URL
 *        - SUPABASE_SERVICE_ROLE_KEY
 *        - INSTANTLY_SUPABASE_URL
 *        - INSTANTLY_SUPABASE_SERVICE_ROLE_KEY  (нужен только для loadConfig
 *          пути, dry-run в Instantly не лезет)
 *
 *   2. Убедись что в БД у клиента стоит dry_run=true и enabled=true
 *      (см. instructions в migration 0007).
 *
 *   3. Запусти:
 *        cd app
 *        node --env-file=../.env scripts/run-auto-pipeline-dry-run.mjs <client_user_id>
 *
 *      или без аргумента — пройдёт по всем eligible-клиентам:
 *        node --env-file=../.env scripts/run-auto-pipeline-dry-run.mjs
 *
 * Что делает:
 *   1. Загружает eligible-клиентов (auto_pipeline_enabled + configs.enabled)
 *   2. Для каждого вызывает runAutoPipelineForClient
 *   3. Печатает воронку с цифрами:
 *        parsed → new → with_site → with_score → with_email → email_valid
 *
 * Что НЕ делает (в dry_run mode):
 *   ❌ Не создаёт кампании в Instantly
 *   ❌ Не грузит лидов в Instantly
 *   ❌ Не отправляет писем
 *
 * Все собранные домены/email/scores пишутся в БД
 * client_auto_pipeline_seen_employers со status='dry_run', их потом можно
 * вытаскивать SQL'ом для аналитики или CSV-выгрузки.
 *
 * Запускается через esbuild-bundled версию — потому что напрямую TS не
 * исполняется из node. Перед первым запуском нужен один раз `npm run build:workers`.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.resolve(__dirname, '..', 'dist', 'workers', 'autoPipelineDryRunCli.js');
const bundleUrl = pathToFileURL(bundlePath).href;

let runAutoPipelineForClient;
let supabaseAdmin;
try {
  const mod = await import(bundleUrl);
  runAutoPipelineForClient = mod.runAutoPipelineForClient;
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

const specificClientId = process.argv[2];

async function listEligibleClients() {
  const { data: configs } = await supabaseAdmin
    .from('client_auto_pipeline_configs')
    .select('client_user_id, dry_run, enabled')
    .eq('enabled', true);
  if (!configs?.length) return [];

  const ids = configs.map((c) => c.client_user_id);
  const { data: profiles } = await supabaseAdmin
    .from('profiles')
    .select('id, email')
    .in('id', ids)
    .eq('auto_pipeline_enabled', true);

  return (profiles ?? []).map((p) => {
    const cfg = configs.find((c) => c.client_user_id === p.id);
    return { id: p.id, email: p.email, dry_run: cfg?.dry_run ?? false };
  });
}

const eligible = specificClientId
  ? [{ id: specificClientId, email: '(by argv)', dry_run: 'unknown' }]
  : await listEligibleClients();

if (eligible.length === 0) {
  console.log('Нет eligible-клиентов. Проверь что profiles.auto_pipeline_enabled=true и configs.enabled=true');
  process.exit(0);
}

console.log(`Прогон для ${eligible.length} клиент(ов):`);
for (const c of eligible) {
  console.log(`  - ${c.id}  (${c.email}, dry_run=${c.dry_run})`);
}
console.log('');

for (const client of eligible) {
  const t0 = Date.now();
  console.log(`╔════ ${client.email} (${client.id}) ════════════════════════════`);
  try {
    const summary = await runAutoPipelineForClient(client.id);
    const elapsedSec = Math.round((Date.now() - t0) / 1000);
    if (summary.status === 'completed') {
      console.log(`║ STATUS: ✅ completed in ${elapsedSec}s (dry_run=${summary.wasDryRun})`);
      console.log('║');
      console.log('║ Воронка:');
      console.log(`║   HH parsed:     ${String(summary.parsed).padStart(5)}    ← всего работодателей с HH за 24ч`);
      console.log(`║   new (dedupe):  ${String(summary.new).padStart(5)}    ← уникальных, ещё не виденных`);
      console.log(`║   with_site:     ${String(summary.withSite).padStart(5)}    ← есть site_url`);
      console.log(`║   with_score:    ${String(summary.withScore).padStart(5)}    ← Mailganer вернул score`);
      console.log(`║   with_email:    ${String(summary.withEmail).padStart(5)}    ← скрейп нашёл email`);
      console.log(`║   email_valid:   ${String(summary.emailValid).padStart(5)}    ← прошли DNS+MX${process.env.SMTP_PROXY_URLS ? '+SMTP' : ' (без SMTP — нет прокси)'}`);
      if (!summary.wasDryRun) {
        console.log('║');
        console.log(`║   routed (sent): ${String(summary.routed).padStart(5)}    ← попали в Instantly`);
        console.log(`║   stored:        ${String(summary.stored).padStart(5)}    ← bucket с пустой цепочкой`);
        console.log(`║   skipped:       ${String(summary.skipped).padStart(5)}    ← без email/score`);
        console.log(`║   failed:        ${String(summary.failed).padStart(5)}    ← Instantly ошибки`);
      }
      console.log('║');
      console.log(`║ Run id: ${summary.runId}`);
    } else {
      console.log(`║ STATUS: ❌ failed in ${elapsedSec}s`);
      console.log(`║ Error:  ${summary.error}`);
    }
  } catch (err) {
    console.log(`║ STATUS: 💥 crashed`);
    console.log(`║ Error:  ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log('╚══════════════════════════════════════════════════════════════');
  console.log('');
}

process.exit(0);
