#!/usr/bin/env node
/**
 * client-insights.mjs — сводка по клиенту: то, что фича будет показывать на «Проектах».
 *
 * Источники: канонический слой (012) + исходы (013, v_reply_outcomes).
 * Те же принципы честности, что и campaign-health.mjs: CI, гейты, отказы, грейды.
 *
 * Usage: node client-insights.mjs "<client>"        # имя из dim_campaign_client
 *        node client-insights.mjs --list            # топ клиентов по активности
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(readFileSync(resolve(__dirname, '../../../.env'), 'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const db = new Client({ connectionString: env.INSTANTLY_DATASET_DB_URL });

const pct = (x, d = 1) => x == null ? '—' : (100 * Number(x)).toFixed(d) + '%';
const SPARK = '▁▂▃▄▅▆▇█';
const spark = (vals) => { const mx = Math.max(...vals, 1); return vals.map(v => SPARK[Math.min(7, Math.floor((v / mx) * 7.999))]).join(''); };

(async () => {
  await db.connect();
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    const r = await db.query(`
      SELECT h.client, count(*) campaigns,
             count(*) FILTER (WHERE h.status_label IN ('active','running_subsequences')) active,
             sum(d.sent14)::int sent_14d
      FROM v_campaign_health h
      LEFT JOIN (SELECT campaign_id, sum(sent) sent14 FROM v_campaign_daily_canonical WHERE date >= current_date - 14 GROUP BY 1) d
        ON d.campaign_id = h.campaign_id
      WHERE h.client IS NOT NULL
      GROUP BY 1 HAVING sum(d.sent14) > 0 ORDER BY 4 DESC NULLS LAST LIMIT 15`);
    console.log('Клиенты с активностью за 14 дней (sent_14d):');
    r.rows.forEach(x => console.log(`  ${String(x.sent_14d).padStart(7)}  ${x.client}  (кампаний: ${x.campaigns}, активных: ${x.active})`));
    await db.end(); return;
  }
  const client = args.join(' ').trim();
  if (!client) { console.log('Usage: node client-insights.mjs "<client>" | --list'); process.exit(1); }

  const camps = (await db.query(`SELECT * FROM v_campaign_health WHERE client = $1`, [client])).rows;
  if (!camps.length) { console.log(`Клиент «${client}» не найден в dim_campaign_client`); await db.end(); return; }
  const ids = camps.map(c => c.campaign_id);

  const L = [];
  L.push('█'.repeat(80));
  L.push(`ПРОЕКТ: ${client}`);
  const act = camps.filter(c => ['active', 'running_subsequences'].includes(c.status_label));
  L.push(`кампаний: ${camps.length} (активных: ${act.length}, завершённых: ${camps.filter(c => c.status_label === 'completed').length}) · email-данные: ${camps.filter(c => c.universe === 'email').length}, только-агрегаты: ${camps.filter(c => c.universe === 'snapshot_only').length}`);
  L.push('─'.repeat(80));

  // ── общий тренд 12 недель ──
  const wk = (await db.query(`
    SELECT date_trunc('week', date)::date wk, sum(sent)::int sent, sum(unique_replies)::int repl
    FROM v_campaign_daily_canonical WHERE campaign_id = ANY($1) AND date >= current_date - 84
    GROUP BY 1 ORDER BY 1`, [ids])).rows;
  if (wk.length) {
    L.push(`ДИНАМИКА 12 НЕДЕЛЬ:  отправки ${spark(wk.map(r => r.sent))}  ответы ${spark(wk.map(r => r.repl))}`);
    L.push(`  последняя неделя: ${wk.at(-1).sent} отправок, ${wk.at(-1).repl} ответов`);
  }

  // ── исходы (v_reply_outcomes: LLM ∪ Instantly) ──
  const out = (await db.query(`
    SELECT count(*) repliers,
           count(*) FILTER (WHERE positive) positives,
           count(*) FILTER (WHERE label_source IS NOT NULL) labeled,
           count(*) FILTER (WHERE label_source LIKE 'llm%') by_llm
    FROM v_reply_outcomes WHERE campaign_id = ANY($1)`, [ids])).rows[0];
  L.push(`ИСХОДЫ: ${out.repliers} уник. ответивших · позитивных ${out.positives} · размечено ${out.labeled} (${pct(out.labeled / Math.max(1, out.repliers), 0)}, из них LLM: ${out.by_llm})`);
  L.push('─'.repeat(80));

  // ── таблица кампаний (top по объёму retained) ──
  const top = camps.filter(c => c.universe === 'email').sort((a, b) => (b.sent_retained || 0) - (a.sent_retained || 0)).slice(0, 8);
  if (top.length) {
    L.push('КАМПАНИИ (email-данные, топ по объёму):');
    L.push('  отправок  ответ%            bounce  статус    название');
    for (const c of top) {
      const rr = c.reply_rate != null ? `${pct(c.reply_rate)} [${pct(c.reply_rate_ci_low)}–${pct(c.reply_rate_ci_high)}]` : 'n<200    ';
      L.push(`  ${String(c.sent_retained).padStart(8)}  ${rr.padEnd(17)} ${pct(c.bounce_rate_lifetime).padStart(6)}  ${String(c.status_label || '').padEnd(9)} ${String(c.name).slice(0, 38)}`);
    }
  }
  const zombies = camps.filter(c => c.universe === 'snapshot_only').length;
  if (zombies) L.push(`  + ${zombies} кампаний без email-истории (ретеншен) —只 lifetime-агрегаты`);

  // ── находки по клиенту ──
  L.push('─'.repeat(80));
  L.push('НАХОДКИ:');
  const f = [];
  for (const c of camps) {
    if (c.bounce_rate_lifetime != null && Number(c.bounce_rate_lifetime) > 0.05 && ['active', 'paused'].includes(c.status_label))
      f.push(`[B] «${String(c.name).slice(0, 45)}»: bounce ${pct(c.bounce_rate_lifetime)} > 5% — чистить список перед продолжением.`);
  }
  // упавшая/нулевая неделя при активных кампаниях
  if (act.length && wk.length >= 2 && wk.at(-1).sent === 0 && wk.at(-2).sent > 0)
    f.push(`[A] Активных кампаний ${act.length}, но отправок на этой неделе 0 — конвейер встал.`);
  // сравнение с сегментом (если у клиента есть доминирующий сегмент)
  const segs = {};
  camps.forEach(c => { if (c.segment) segs[c.segment] = (segs[c.segment] || 0) + 1; });
  const mainSeg = Object.entries(segs).sort((a, b) => b[1] - a[1])[0];
  if (mainSeg) {
    const bench = (await db.query(`
      SELECT count(*) n, percentile_cont(0.5) WITHIN GROUP (ORDER BY reply_rate) med
      FROM v_campaign_health WHERE segment = $1 AND universe = 'email' AND reply_rate IS NOT NULL`, [mainSeg[0]])).rows[0];
    const own = top.filter(c => c.reply_rate != null).map(c => Number(c.reply_rate));
    if (Number(bench.n) >= 10 && own.length) {
      const ownMed = own.sort((a, b) => a - b)[Math.floor(own.length / 2)];
      f.push(`[B] Медианный reply rate клиента ${pct(ownMed)} vs медиана сегмента «${mainSeg[0]}» ${pct(bench.med)} (n=${bench.n} кампаний) — ${ownMed >= Number(bench.med) ? 'на уровне или выше пиров' : 'ниже пиров — смотреть оффер/базу'}.`);
    }
  }
  if (!f.length) f.push('Статистически обоснованных находок нет — это честный результат.');
  f.forEach(x => L.push('  • ' + x));
  L.push('  Грейды: A = прямой факт/причинный, B = корреляционный с контролем.');
  console.log(L.join('\n'));
  await db.end();
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
