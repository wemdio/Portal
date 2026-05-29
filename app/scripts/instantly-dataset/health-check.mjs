/**
 * health-check.mjs — daily per-client health questions (Tier-1, pure SQL).
 *
 * 1. Syncs dims from operational DBs into instantly_dataset:
 *    - dim_projects            ← main-postgres.projects
 *    - dim_project_campaigns   ← instantly.project_instantly_campaigns
 *    - dim_lead_qualifications ← instantly.instantly_lead_qualifications
 * 2. For each ACTIVE client (status В работе / Тестирование), computes the 7
 *    fixed health questions and UPSERTs into client_health_snapshots.
 *
 * Deterministic. No LLM. Run daily; weekly LLM pass enriches narratives later.
 *
 * Usage: node scripts/instantly-dataset/health-check.mjs [--date=YYYY-MM-DD] [--dry-run]
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const env = Object.fromEntries(
  readFileSync(resolve(REPO_ROOT, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const args = process.argv.slice(2);
const flag = (n, d) => { const a = args.find(x => x === `--${n}` || x.startsWith(`--${n}=`)); return !a ? d : (a === `--${n}` ? true : a.slice(n.length + 3)); };
const SNAPSHOT_DATE = flag('date', new Date().toISOString().slice(0, 10));
const DRY = !!flag('dry-run', false);
const ACTIVE_STATUSES = ['В работе', 'Тестирование'];

const log = (...m) => console.log(`[${new Date().toISOString()}]`, ...m);

const DATASET_URL = env.INSTANTLY_DATASET_DB_URL;
const INSTANTLY_URL = DATASET_URL.replace('/instantly_dataset', '/instantly');
const MAIN_PG = { host: '144.31.54.166', port: 35434, user: 'supabase_admin', password: 'II4HByZJGNzDA5xq6vBtDvrvuqNDipha', database: 'postgres' };

function pct(n, d) { return d > 0 ? (n / d) : null; }
function deltaPct(cur, prior) { return (prior && prior > 0) ? ((cur - prior) / prior * 100) : null; }
function round(x, p = 2) { return x == null ? null : Number(x.toFixed(p)); }

// ─── dim sync ──────────────────────────────────────────────────────────────

async function syncDims(ds) {
  log('Syncing dimensions…');

  // projects from main-postgres
  const main = new Client(MAIN_PG); await main.connect();
  const projects = (await main.query(`SELECT id, client, name, status FROM projects`)).rows;
  await main.end();
  for (const p of projects) {
    await ds.query(
      `INSERT INTO dim_projects (project_id, client, project_name, status, synced_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (project_id) DO UPDATE SET client=EXCLUDED.client, project_name=EXCLUDED.project_name, status=EXCLUDED.status, synced_at=now()`,
      [p.id, p.client, p.name, p.status]
    );
  }
  log(`  dim_projects: ${projects.length}`);

  // mappings + qualifications from instantly DB
  const inst = new Client({ connectionString: INSTANTLY_URL }); await inst.connect();

  const maps = (await inst.query(`SELECT project_id, campaign_id, match_confidence FROM project_instantly_campaigns`)).rows;
  // refresh fully (mappings can be removed)
  if (!DRY) await ds.query('TRUNCATE dim_project_campaigns');
  for (const m of maps) {
    await ds.query(
      `INSERT INTO dim_project_campaigns (project_id, campaign_id, match_confidence, synced_at)
       VALUES ($1,$2,$3, now()) ON CONFLICT (project_id, campaign_id) DO UPDATE SET match_confidence=EXCLUDED.match_confidence, synced_at=now()`,
      [m.project_id, m.campaign_id, m.match_confidence]
    );
  }
  log(`  dim_project_campaigns: ${maps.length}`);

  const quals = (await inst.query(
    `SELECT id, campaign_id, lead_email, status, created_at FROM instantly_lead_qualifications`
  )).rows;
  await inst.end();
  let qn = 0;
  for (const q of quals) {
    await ds.query(
      `INSERT INTO dim_lead_qualifications (id, campaign_id, lead_email, status, created_at, synced_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, synced_at=now()`,
      [q.id, q.campaign_id, q.lead_email, q.status, q.created_at]
    );
    qn++;
  }
  log(`  dim_lead_qualifications: ${qn}`);
}

// ─── the 7 questions ─────────────────────────────────────────────────────────

async function campaignsFor(ds, projectId) {
  const r = await ds.query(`SELECT campaign_id FROM dim_project_campaigns WHERE project_id=$1`, [projectId]);
  return r.rows.map(x => x.campaign_id);
}

// Q1 volume
async function qVolume(ds, cids) {
  const r = await ds.query(`
    SELECT
      count(*) FILTER (WHERE ue_type=1 AND timestamp_email > now()-interval '7 days')                                          AS sent_7d,
      count(*) FILTER (WHERE ue_type=1 AND timestamp_email > now()-interval '14 days' AND timestamp_email <= now()-interval '7 days') AS sent_prior_7d
    FROM raw_emails WHERE campaign_id = ANY($1)`, [cids]);
  const { sent_7d, sent_prior_7d } = r.rows[0];
  const a = +sent_7d, b = +sent_prior_7d;
  let severity = 'ok';
  if (a === 0 && b > 0) severity = 'critical';
  else if (b > 0 && a < b * 0.5) severity = 'warning';
  const structured = { last_7d: a, prior_7d: b, delta_pct: round(deltaPct(a, b)), direction: a >= b ? 'up' : 'down' };
  const narrative = a === 0 && b > 0
    ? `Отправка остановилась: 0 писем за 7д (было ${b}). Проверить статус кампаний и mailbox-ов.`
    : `${a} писем за 7д (${structured.delta_pct ?? '—'}% к прошлой неделе ${b}).`;
  return { structured, narrative, severity };
}

// Q3 reply rate (precise from raw_emails)
async function qReplyRate(ds, cids) {
  const r = await ds.query(`
    SELECT
      count(*) FILTER (WHERE ue_type=1 AND timestamp_email > now()-interval '7 days') AS sent_7d,
      count(*) FILTER (WHERE ue_type=2 AND timestamp_email > now()-interval '7 days') AS replies_7d,
      count(*) FILTER (WHERE ue_type=1 AND timestamp_email > now()-interval '30 days') AS sent_30d,
      count(*) FILTER (WHERE ue_type=2 AND timestamp_email > now()-interval '30 days') AS replies_30d
    FROM raw_emails WHERE campaign_id = ANY($1)`, [cids]);
  const x = r.rows[0];
  const rate7 = pct(+x.replies_7d, +x.sent_7d);
  const base = pct(+x.replies_30d, +x.sent_30d);
  let severity = 'ok';
  if (+x.sent_7d === 0) severity = 'no_data';
  else if (rate7 != null && rate7 < 0.005) severity = 'warning';
  const structured = { sent_7d: +x.sent_7d, replies_7d: +x.replies_7d, reply_rate_7d: round(rate7 && rate7 * 100), baseline_30d: round(base && base * 100) };
  const narrative = +x.sent_7d === 0 ? 'Нет отправок за 7д — reply rate не считается.'
    : `Reply rate 7д: ${structured.reply_rate_7d}% (${x.replies_7d}/${x.sent_7d}), baseline 30д: ${structured.baseline_30d}%.`;
  return { structured, narrative, severity };
}

// Q4 qualified leads
async function qLeads(ds, cids) {
  const r = await ds.query(`
    SELECT
      count(*) FILTER (WHERE status='lead' AND created_at > now()-interval '7 days')                                       AS leads_7d,
      count(*) FILTER (WHERE status='lead' AND created_at > now()-interval '14 days' AND created_at <= now()-interval '7 days') AS leads_prior_7d
    FROM dim_lead_qualifications WHERE campaign_id = ANY($1)`, [cids]);
  const a = +r.rows[0].leads_7d, b = +r.rows[0].leads_prior_7d;
  let severity = 'ok';
  if (a === 0 && b > 0) severity = 'critical';
  else if (b > 0 && a < b * 0.5) severity = 'warning';
  const structured = { last_7d: a, prior_7d: b, delta_pct: round(deltaPct(a, b)), direction: a >= b ? 'up' : 'down' };
  const narrative = a === 0 && b > 0 ? `0 лидов за 7д (было ${b}). Резкое падение результата.`
    : `${a} квалифицированных лидов за 7д (прошлая неделя: ${b}).`;
  return { structured, narrative, severity };
}

// Q5 mailbox health
async function qMailbox(ds, cids) {
  // Resolve senders via v_campaign_mailboxes (handles BOTH email_list and tag-based
  // email_tag_list — most campaigns use tags). Eval-loop fix, query_log id=2.
  const r = await ds.query(`
    WITH mb AS (SELECT DISTINCT email FROM v_campaign_mailboxes WHERE campaign_id = ANY($1))
    SELECT count(*) AS total,
           count(*) FILTER (WHERE a.status < 0 OR a.warmup_status < 0) AS degraded
    FROM mb LEFT JOIN raw_accounts a ON a.email = mb.email`, [cids]);
  const total = +r.rows[0].total, degraded = +r.rows[0].degraded;
  let severity = 'ok';
  if (total > 0 && degraded / total > 0.3) severity = 'critical';
  else if (degraded > 0) severity = 'warning';
  const structured = { total_mailboxes: total, degraded, degraded_pct: round(pct(degraded, total) && pct(degraded, total) * 100) };
  const narrative = total === 0 ? 'Нет привязанных mailbox-ов в данных.'
    : `${degraded}/${total} mailbox-ов в проблемном статусе (warmup/account < 0).`;
  return { structured, narrative, severity };
}

// Q2 open rate + Q6 bounce/unsub — from overview snapshot diff (baseline vs latest per campaign)
async function qSnapshotDiff(ds, cids) {
  // latest overview row per campaign, and baseline (earliest = full pull) per campaign
  const r = await ds.query(`
    WITH ranked AS (
      SELECT o.*, s.started_at,
             row_number() OVER (PARTITION BY o.campaign_id ORDER BY s.started_at DESC) AS rn_latest,
             row_number() OVER (PARTITION BY o.campaign_id ORDER BY s.started_at ASC)  AS rn_first
      FROM raw_campaign_analytics_overview_snap o
      JOIN dataset_snapshots s ON s.id = o.snapshot_id
      WHERE o.campaign_id = ANY($1)
    ),
    latest AS (SELECT campaign_id, emails_sent_count, open_count_unique, bounced_count, unsubscribed_count, reply_count FROM ranked WHERE rn_latest=1),
    first  AS (SELECT campaign_id, emails_sent_count, open_count_unique, bounced_count, unsubscribed_count FROM ranked WHERE rn_first=1)
    SELECT
      coalesce(sum(l.emails_sent_count - f.emails_sent_count),0)        AS sent_window,
      coalesce(sum(l.open_count_unique - f.open_count_unique),0)        AS opens_window,
      coalesce(sum(l.bounced_count - f.bounced_count),0)               AS bounced_window,
      coalesce(sum(l.unsubscribed_count - f.unsubscribed_count),0)     AS unsub_window,
      coalesce(sum(l.emails_sent_count),0)                             AS sent_lifetime,
      coalesce(sum(l.open_count_unique),0)                             AS opens_lifetime,
      coalesce(sum(l.bounced_count),0)                                 AS bounced_lifetime
    FROM latest l JOIN first f USING (campaign_id)`, [cids]);
  return r.rows[0];
}

function buildOpenRate(diff) {
  const sw = +diff.sent_window, ow = +diff.opens_window;
  const lifeRate = pct(+diff.opens_lifetime, +diff.sent_lifetime);
  const winRate = sw > 0 ? pct(ow, sw) : null;
  let severity = 'ok';
  if (sw <= 0) severity = 'no_data';
  else if (winRate != null && winRate < 0.10) severity = 'critical';
  else if (winRate != null && winRate < 0.20) severity = 'warning';
  const structured = { window_sent: sw, window_opens_unique: ow, window_open_rate: round(winRate && winRate * 100), lifetime_open_rate: round(lifeRate && lifeRate * 100) };
  const narrative = sw <= 0 ? 'Недостаточно свежих снапшотов для WoW open rate (накапливается).'
    : `Open rate в окне: ${structured.window_open_rate}% (${ow}/${sw}). Lifetime: ${structured.lifetime_open_rate}%.`;
  return { structured, narrative, severity };
}

function buildBounceUnsub(diff) {
  const sw = +diff.sent_window, bw = +diff.bounced_window, uw = +diff.unsub_window;
  const bounceRate = sw > 0 ? pct(bw, sw) : null;
  const lifeBounce = pct(+diff.bounced_lifetime, +diff.sent_lifetime);
  let severity = 'ok';
  if (sw <= 0) severity = 'no_data';
  else if (bounceRate != null && bounceRate > 0.05) severity = 'critical';
  else if (bounceRate != null && bounceRate > 0.03) severity = 'warning';
  const structured = { window_sent: sw, window_bounced: bw, window_unsub: uw, window_bounce_rate: round(bounceRate && bounceRate * 100), lifetime_bounce_rate: round(lifeBounce && lifeBounce * 100) };
  const narrative = sw <= 0 ? 'Недостаточно свежих снапшотов для WoW bounce (накапливается).'
    : `Bounce ${structured.window_bounce_rate}% (${bw}/${sw}), unsub ${uw}. Lifetime bounce: ${structured.lifetime_bounce_rate}%.`;
  return { structured, narrative, severity };
}

// Q7 subjects
async function qSubjects(ds, cids) {
  const r = await ds.query(`
    SELECT subject, sent, reply_rate_pct, open_rate_pct
    FROM v_subject_performance
    WHERE campaign_id = ANY($1) AND subject IS NOT NULL AND subject <> '' AND sent >= 50
    ORDER BY reply_rate_pct DESC NULLS LAST`, [cids]);
  if (!r.rows.length) return { structured: { note: 'no subjects with sent>=50' }, narrative: 'Нет тем с достаточным объёмом (sent>=50).', severity: 'no_data' };
  const best = r.rows[0], worst = r.rows[r.rows.length - 1];
  const structured = {
    best: { subject: best.subject?.slice(0, 80), sent: +best.sent, reply_rate: +best.reply_rate_pct },
    worst: { subject: worst.subject?.slice(0, 80), sent: +worst.sent, reply_rate: +worst.reply_rate_pct },
    subjects_evaluated: r.rows.length
  };
  const narrative = `Лучшая тема: «${structured.best.subject}» (${structured.best.reply_rate}% reply). Худшая: «${structured.worst.subject}» (${structured.worst.reply_rate}%).`;
  return { structured, narrative, severity: 'ok' };
}

// ─── store ───────────────────────────────────────────────────────────────────

async function store(ds, p, qid, res) {
  if (DRY) return;
  await ds.query(`
    INSERT INTO client_health_snapshots (snapshot_date, project_id, client, project_name, question_id, structured, narrative, severity)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (snapshot_date, project_id, question_id)
    DO UPDATE SET structured=EXCLUDED.structured, narrative=EXCLUDED.narrative, severity=EXCLUDED.severity, created_at=now()`,
    [SNAPSHOT_DATE, p.project_id, p.client, p.project_name, qid, JSON.stringify(res.structured), res.narrative, res.severity]);
}

// ─── main ────────────────────────────────────────────────────────────────────

(async () => {
  const tStart = Date.now();
  const ds = new Client({ connectionString: DATASET_URL }); await ds.connect();
  log(`Health check for ${SNAPSHOT_DATE}. dry=${DRY}`);

  await syncDims(ds);

  const active = (await ds.query(
    `SELECT project_id, client, project_name, status FROM dim_projects WHERE status = ANY($1) ORDER BY client`,
    [ACTIVE_STATUSES]
  )).rows;
  log(`Active clients: ${active.length}`);

  const sevTally = { ok: 0, warning: 0, critical: 0, no_data: 0 };
  let processed = 0;
  for (const p of active) {
    const cids = await campaignsFor(ds, p.project_id);
    if (!cids.length) { log(`  ${p.client}: no campaigns mapped, skip`); continue; }

    const diff = await qSnapshotDiff(ds, cids);
    const results = {
      volume:          await qVolume(ds, cids),
      open_rate:       buildOpenRate(diff),
      reply_rate:      await qReplyRate(ds, cids),
      qualified_leads: await qLeads(ds, cids),
      mailbox_health:  await qMailbox(ds, cids),
      bounce_unsub:    buildBounceUnsub(diff),
      subjects:        await qSubjects(ds, cids),
    };
    for (const [qid, res] of Object.entries(results)) {
      await store(ds, p, qid, res);
      sevTally[res.severity] = (sevTally[res.severity] ?? 0) + 1;
    }
    processed++;
    const worst = Object.values(results).some(r => r.severity === 'critical') ? '🔴'
                : Object.values(results).some(r => r.severity === 'warning') ? '🟡' : '🟢';
    log(`  ${worst} ${p.client} (${cids.length} camp): leads7d=${results.qualified_leads.structured.last_7d}, sent7d=${results.volume.structured.last_7d}, reply=${results.reply_rate.structured.reply_rate_7d}%`);
  }

  log(`\nDONE in ${((Date.now()-tStart)/1000).toFixed(0)}s. Clients processed: ${processed}`);
  log(`Severity tally (across all questions): ${JSON.stringify(sevTally)}`);
  await ds.end();
})().catch(e => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
