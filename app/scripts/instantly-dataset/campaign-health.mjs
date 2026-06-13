#!/usr/bin/env node
/**
 * campaign-health.mjs — честная карточка здоровья кампании.
 *
 * Прототип фичи campaign-insights поверх канонического слоя (миграция 012).
 * Принципы (см. wiki/analyses/2026-06-11-dataset-objectivity-audit.md):
 *   - каждая доля с 95% Wilson CI; ниже гейта по n — «недостаточно данных», не цифра
 *   - ответившие = DISTINCT (campaign, lead) — v_reply_facts (без дублей автоответчиков)
 *   - universe-теги: email-метрики и lifetime-агрегаты не смешиваются
 *   - причинный язык ТОЛЬКО для within-campaign A/B (же аудитория/клиент/ящики)
 *   - рекомендации только из сработавших детекторов, с грейдом доказательности
 *
 * Usage:
 *   node campaign-health.mjs <campaign_id>
 *   node campaign-health.mjs --top 3        # топ активных по объёму за 14 дней
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');
const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(readFileSync(resolve(__dirname, '../../../.env'), 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.trim().startsWith('#'))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const db = new Client({ connectionString: env.INSTANTLY_DATASET_DB_URL });

const pct = (x, d = 1) => x == null ? '—' : (100 * Number(x)).toFixed(d) + '%';
const ci = (lo, hi) => (lo == null || hi == null) ? '' : ` [${pct(lo)}–${pct(hi)}]`;
const SPARK = '▁▂▃▄▅▆▇█';
const spark = (vals) => {
  const mx = Math.max(...vals, 1);
  return vals.map(v => SPARK[Math.min(7, Math.floor((v / mx) * 7.999))]).join('');
};
// two-proportion z-test (pooled)
function twoPropZ(k1, n1, k2, n2) {
  if (!n1 || !n2) return null;
  const p1 = k1 / n1, p2 = k2 / n2, p = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return null;
  const z = (p1 - p2) / se;
  const phi = (x) => 0.5 * (1 + Math.tanh(Math.sqrt(Math.PI / 8) * x)); // approx
  return { z, p: 2 * (1 - phi(Math.abs(z))), p1, p2 };
}

async function healthCard(cid) {
  const h = (await db.query(`SELECT * FROM v_campaign_health WHERE campaign_id = $1`, [cid])).rows[0];
  if (!h) { console.log(`Кампания ${cid} не найдена`); return; }
  const L = [];
  const ageDays = h.campaign_created ? Math.floor((Date.now() - new Date(h.campaign_created)) / 86400e3) : null;
  L.push('═'.repeat(78));
  L.push(`${h.name}`);
  L.push(`${h.status_label || h.status} · клиент: ${h.client || 'не атрибуцирован ⚠️'} · сегмент: ${h.segment || '—'} · возраст: ${ageDays != null ? ageDays + 'д' : '—'}`);
  L.push('─'.repeat(78));

  // ── volume + 12-week sparkline from canonical daily (16-month source) ──
  const daily = (await db.query(`
    SELECT date_trunc('week', date)::date wk, sum(sent)::int sent, sum(unique_replies)::int repl, sum(bounced)::int bounced
    FROM v_campaign_daily_canonical WHERE campaign_id = $1 GROUP BY 1 ORDER BY 1`, [cid])).rows;
  if (daily.length) {
    const last12 = daily.slice(-12);
    L.push(`ОБЪЁМ (Instantly daily, история с ${daily[0].wk.toISOString().slice(0, 10)}):`);
    L.push(`  отправки/нед  ${spark(last12.map(r => r.sent))}  последняя: ${last12.at(-1).sent}`);
    L.push(`  ответы/нед    ${spark(last12.map(r => r.repl))}  последняя: ${last12.at(-1).repl}`);
  }

  // ── canonical email-derived metrics ──
  if (h.universe === 'email') {
    const trunc = h.left_truncated ? ' ⚠️ left-truncated (начало истории срезано ретеншеном)' : '';
    L.push(`ПИСЬМА (наш архив${trunc}): ${h.sent_retained} отправок ${h.sent_from.toISOString().slice(0, 10)} → ${h.sent_to.toISOString().slice(0, 10)}`);
    L.push(`  ответили (уник. лиды): ${h.repliers ?? 0}` + (h.reply_rate != null
      ? ` → reply rate ${pct(h.reply_rate)}${ci(h.reply_rate_ci_low, h.reply_rate_ci_high)}`
      : ` → reply rate: недостаточно данных (${h.sent_retained}/200 отправок)`));
    if (h.lead_rate_labeled != null) {
      L.push(`  заинтересованные: ${h.interested_repliers}/${h.labeled_repliers} размеченных → lead rate ${pct(h.lead_rate_labeled)}${ci(h.lead_rate_ci_low, h.lead_rate_ci_high)} (размечено ${pct(h.label_coverage, 0)} ответов${Number(h.label_coverage) < 0.25 ? ' ⚠️ низкое покрытие — метрика ненадёжна' : ''})`);
    } else {
      L.push(`  lead rate: недостаточно размеченных ответов (${h.labeled_repliers ?? 0}/20)`);
    }
  } else if (h.universe === 'snapshot_only') {
    L.push(`ПИСЬМА: история отправок стёрта ретеншеном Instantly — email-метрики недоступны (это отказ, а не ноль).`);
  }

  // ── lifetime (other universe — explicitly labeled) ──
  if (h.lifetime_sent != null) {
    L.push(`LIFETIME (агрегат Instantly, as-of ${h.snapshot_as_of.toISOString().slice(0, 10)}): ${h.lifetime_sent} отправок, ${h.lifetime_replies_instantly} ответов (по версии Instantly), bounce ${pct(h.bounce_rate_lifetime)}`);
  }

  // ── detectors → findings ──
  const findings = [];
  // D1: bounce
  if (h.bounce_rate_lifetime != null && Number(h.bounce_rate_lifetime) > 0.05) {
    findings.push({ grade: 'B', text: `Bounce ${pct(h.bounce_rate_lifetime)} > 5% — проблема качества списка/доставляемости. Рекомендация: верификация базы перед отправкой, проверить домены ящиков. (корреляционный уровень)` });
  }
  // D2/D3: trend last 7 full days vs prior 21 (daily canonical)
  const tr = (await db.query(`
    WITH d AS (SELECT date, sent, unique_replies FROM v_campaign_daily_canonical WHERE campaign_id = $1 AND date < current_date)
    SELECT
      (SELECT coalesce(sum(sent),0)           FROM d WHERE date >= current_date - 7)  k7s,
      (SELECT coalesce(sum(unique_replies),0) FROM d WHERE date >= current_date - 7)  k7r,
      (SELECT coalesce(sum(sent),0)           FROM d WHERE date >= current_date - 28 AND date < current_date - 7) k21s,
      (SELECT coalesce(sum(unique_replies),0) FROM d WHERE date >= current_date - 28 AND date < current_date - 7) k21r`, [cid])).rows[0];
  const active = ['active', 'running_subsequences'].includes(h.status_label) || h.status === 1;
  if (active && Number(tr.k7s) === 0 && Number(tr.k21s) > 0) {
    findings.push({ grade: 'A', text: `Кампания активна, но за 7 дней 0 отправок (было ${tr.k21s} за прошлые 3 нед) — отправка встала: проверить ящики/лимиты/расписание.` });
  }
  if (Number(tr.k7s) >= 500 && Number(tr.k21s) >= 500) {
    const t = twoPropZ(+tr.k7r, +tr.k7s, +tr.k21r, +tr.k21s);
    if (t && t.p < 0.01) {
      const dir = t.p1 > t.p2 ? 'ВЫРОС' : 'УПАЛ';
      findings.push({ grade: 'B', text: `Reply rate ${dir}: ${pct(t.p1)} за 7д vs ${pct(t.p2)} за предыдущие 21д (z=${t.z.toFixed(2)}, p=${t.p.toExponential(1)}). ${t.p1 < t.p2 ? 'Проверить доставляемость/усталость сегмента базы.' : 'Посмотреть, что изменилось — и закрепить.'}`});
    }
  } else if (Number(tr.k7s) > 0) {
    findings.push({ grade: '—', text: `Тренд reply rate: недостаточно объёма для вывода (нужно ≥500 отправок в каждом окне; есть ${tr.k7s}/${tr.k21s}).` });
  }
  // D4: within-campaign subject A/B (the only causal zone)
  const ab = (await db.query(`SELECT subject, sent, unique_replies AS replies FROM v_subject_ab_within_campaign WHERE campaign_id = $1 AND step_n = 0 ORDER BY sent DESC LIMIT 6`, [cid])).rows;
  if (ab.length >= 2) {
    const [a, b] = ab;
    if (+a.sent >= 1000 && +b.sent >= 1000) {
      const t = twoPropZ(+a.replies, +a.sent, +b.replies, +b.sent);
      if (t && t.p < 0.01) {
        const w = t.p1 > t.p2 ? a : b, l = t.p1 > t.p2 ? b : a;
        findings.push({ grade: 'A', text: `A/B тем (та же аудитория — причинный вывод разрешён): «${w.subject.slice(0, 50)}» бьёт «${l.subject.slice(0, 50)}» — ${pct(Math.max(t.p1, t.p2))} vs ${pct(Math.min(t.p1, t.p2))} (p=${t.p.toExponential(1)}). Рекомендация: перевести трафик на победителя; эффект подтверждать на следующей кампании.` });
      } else if (t) {
        findings.push({ grade: '—', text: `A/B тем: победителя НЕТ (${pct(t.p1)} vs ${pct(t.p2)}, p=${t.p.toFixed(2)} ≥ 0.01) — различие неотличимо от шума при текущем объёме.` });
      }
    } else {
      findings.push({ grade: '—', text: `A/B тем: ${ab.length} вариантов, но <1000 отправок на вариант (${ab.map(x => x.sent).join('/')}) — вердикт невозможен, это норма для малых кампаний.` });
    }
  }
  // D5: attribution gap
  if (!h.client) findings.push({ grade: '—', text: 'Кампания не привязана к клиенту (dim_campaign_client) — не попадает в клиентские отчёты. Стоит домаппить.' });

  L.push('─'.repeat(78));
  L.push('ДИАГНОСТИКА И РЕКОМЕНДАЦИИ (только статистически обоснованные):');
  if (findings.length === 0) L.push('  • Аномалий не обнаружено; статистически обоснованных рекомендаций нет — это честный результат, а не недоработка.');
  for (const f of findings) L.push(`  • [${f.grade}] ${f.text}`);
  L.push('  Грейды: A = причинный (рандомизированное сравнение / прямой факт), B = корреляционный с контролем, — = отказ/наблюдение.');
  console.log(L.join('\n') + '\n');
}

(async () => {
  await db.connect();
  const args = process.argv.slice(2);
  let ids = [];
  const topIdx = args.indexOf('--top');
  if (topIdx >= 0) {
    const n = parseInt(args[topIdx + 1] || '3', 10);
    ids = (await db.query(`
      SELECT d.campaign_id FROM v_campaign_daily_canonical d
      JOIN v_campaign_health h ON h.campaign_id = d.campaign_id AND h.universe = 'email'
      WHERE d.date >= current_date - 14
      GROUP BY 1 ORDER BY sum(d.sent) DESC LIMIT $1`, [n])).rows.map(r => r.campaign_id);
  } else {
    ids = args.filter(a => /^[0-9a-f-]{36}$/i.test(a));
  }
  if (!ids.length) { console.log('Usage: node campaign-health.mjs <campaign_id> | --top N'); process.exit(1); }
  for (const id of ids) await healthCard(id);
  await db.end();
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
