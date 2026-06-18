#!/usr/bin/env node
/**
 * blocklist-candidates.mjs — F) отчёт повторно отписавшихся (см. каталог 2026-06-19).
 *
 * Адреса, которые отписались (label='unsubscribe') в >=2 разных кампаниях с разницей
 * стартов >=7 дней и ещё НЕ в блок-листе Instantly — мы их повторно тревожим письмами
 * (compliance/репутация). Это РЕВЬЮ-список: добавлять в блок ТОЛЬКО после проверки
 * человеком (unsubscribe — LLM-метка, не истина). Домены НЕ предлагаем (free-mail вроде
 * mail.ru несёт тысячи позитивных лидов). Только чтение.
 *
 * Usage: node blocklist-candidates.mjs            (топ по числу кампаний)
 *        node blocklist-candidates.mjs --json     (для пайпа)
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(readFileSync(resolve(__dirname, '../../../.env'), 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const JSON_OUT = process.argv.includes('--json');

(async () => {
  const c = new Client({ connectionString: env.INSTANTLY_DATASET_DB_URL });
  await c.connect();
  const rows = (await c.query(
    `SELECT email, n_campaigns, camp_span_days, campaigns
     FROM v_blocklist_candidates
     ORDER BY n_campaigns DESC, camp_span_days DESC`,
  )).rows;
  await c.end();

  if (JSON_OUT) { console.log(JSON.stringify(rows)); return; }

  console.log(`\nКАНДИДАТЫ В БЛОК-ЛИСТ (отписались в >=2 кампаниях, разница стартов >=7д, ещё не в блоке): ${rows.length}\n`);
  console.log('Это ревью-список — добавлять в Instantly-блок ТОЛЬКО после проверки человеком.\n');
  for (const r of rows) {
    console.log(`• ${r.email.padEnd(34)} отписался в ${r.n_campaigns} кампаниях (разброс ${r.camp_span_days}д)`);
    console.log(`    ${(r.campaigns || []).slice(0, 4).join(' · ')}`);
  }
  console.log('');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
