/**
 * sync.mjs — daily incremental refresh of instantly_dataset.
 *
 * Designed for nightly cron at 00:00 МСК (= 21:00 UTC; crontab on the prod host runs
 * in MSK), when the qualification worker is essentially idle and we have the
 * rate-limit budget to ourselves.
 *
 * What it does each run:
 *   1. Re-pulls all "small list" entities and UPSERTs them (campaigns,
 *      accounts, lead_lists, email_templates, custom_tags, lead_labels,
 *      block_list, webhooks). Total <100 API calls.
 *   2. Emails DELTA: paginates /emails from most-recent, stops when an
 *      entire page contains only ids we already have. Typical: 5-30 min.
 *   3. Analytics OVERVIEW: refreshes overview-per-campaign for any campaign
 *      that received new emails this night (or all if first run / --full).
 *   4. WEEKLY FULL (Sunday UTC runs, i.e. the night Sun→Mon): overview is
 *      refreshed for ALL campaigns (lifetime counters get a weekly history
 *      point — without this 85%+ of campaigns freeze at their last snapshot),
 *      then lifetime counters are diffed against each campaign's previous
 *      snapshot and steps+daily are re-pulled ONLY for campaigns that moved
 *      (catches late opens/replies on finished campaigns without re-storing
 *      immutable daily history for dead ones). Analytics endpoints run at
 *      their own faster pace (--analytics-rpm, default 60) — the strict
 *      10 RPM workspace budget applies to /emails, not analytics (verified:
 *      one-time daily backfill 2026-06-11 ran ~66 rpm with zero 429s).
 *   5. LEADS CAPTURE (last phase, since 2026-08-17): snapshots lead cards of
 *      every campaign that still has leads (leads_count>0 in
 *      /campaigns/analytics) into raw_leads via UPSERT, never deleting. Why:
 *      the team constantly purges contacts from campaigns to save plan seats,
 *      so a lead card lives ~4–8 weeks in Instantly (measured 2026-08-17: of
 *      2 576 campaigns only 304 still had leads; everything older than June
 *      was at zero). Emails survive the purge, cards don't — this phase keeps
 *      the last snapshot (opens/replies/status/company_domain/upload payload).
 *      Cost control: campaigns whose analytics counters didn't move since the
 *      last capture are skipped (fingerprint in lead_capture_state); a page cap
 *      protects the night window (dropped campaigns are logged, never silent).
 *      Applies 022_leads_capture.sql at startup if present (idempotent DDL).
 *
 * Each run inserts a row into `dataset_snapshots` with mode='delta'. If the
 * script crashes mid-run, that row stays ok=false so it's visible.
 *
 * Usage:
 *   node sync.mjs                    # default daily delta (+weekly full on Sundays)
 *   node sync.mjs --full             # refresh ALL overviews + steps + daily, no diff
 *   node sync.mjs --no-weekly-full   # suppress the Sunday auto-full
 *   node sync.mjs --skip-emails      # debug: skip emails phase
 *   node sync.mjs --emails-only      # only emails delta
 *   node sync.mjs --rpm=N            # override emails RPM (default 10)
 *   node sync.mjs --analytics-rpm=N  # override analytics RPM (default 60)
 *   node sync.mjs --dry-run          # don't write anything to DB
 *   node sync.mjs --skip-leads       # debug: skip leads capture phase
 *   node sync.mjs --leads-only       # only leads capture (first full run / debug)
 *   node sync.mjs --leads-full       # ignore fingerprints, re-capture every campaign with leads
 *   node sync.mjs --leads-rpm=N      # /leads/list pace (default 20 — measured with zero 429s)
 *   node sync.mjs --leads-max-pages=N        # cap on /leads/list pages per night (default 6000)
 *   node sync.mjs --leads-limit-campaigns=N  # debug: capture at most N campaigns
 */
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

// ─── env ─────────────────────────────────────────────────────────────────
function loadEnv(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, 'utf8').split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
  );
}
const env = { ...loadEnv(resolve(REPO_ROOT, '.env')), ...process.env };

const KEY = env.INSTANTLY_EXPORT_API_KEY || env.INSTANTLY_PORTAL_API_KEY || env.INSTANTLY_API_KEY;
const DB_URL = env.INSTANTLY_DATASET_DB_URL;
if (!KEY) { console.error('FATAL: no Instantly API key in env'); process.exit(1); }
if (!DB_URL) { console.error('FATAL: no INSTANTLY_DATASET_DB_URL in env'); process.exit(1); }

// ─── CLI ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name, def) {
  const a = args.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return def;
  if (a === `--${name}`) return true;
  return a.slice(name.length + 3);
}
const RPM = Number(flag('rpm', 10));
const ANALYTICS_RPM = Number(flag('analytics-rpm', 60)); // analytics endpoints have a laxer budget than /emails
const SKIP_EMAILS = !!flag('skip-emails', false);
const EMAILS_ONLY = !!flag('emails-only', false);
const FULL = !!flag('full', false);
const DRY = !!flag('dry-run', false);
// Sunday-UTC runs (night Sun→Mon, lowest send volume) auto-refresh analytics
// for ALL campaigns. Disable with --no-weekly-full.
const WEEKLY_FULL = !flag('no-weekly-full', false) && new Date().getUTCDay() === 0;
// Leads capture (phase 5). 20 RPM = measured with zero 429s on 2026-08-17 while
// /emails at 10 RPM was already catching 429s that night (shared workspace budget).
// Raise via --leads-rpm after a clean night; 429 backoff lives in callApi.
const LEADS_RPM = Number(flag('leads-rpm', 20));
const SKIP_LEADS = !!flag('skip-leads', false);
const LEADS_ONLY = !!flag('leads-only', false);
const LEADS_FULL = !!flag('leads-full', false);
const LEADS_MAX_PAGES = Number(flag('leads-max-pages', 6000));
const LEADS_LIMIT_CAMPAIGNS = Number(flag('leads-limit-campaigns', 0));

// ─── logger ──────────────────────────────────────────────────────────────
function log(...m) {
  console.log(`[${new Date().toISOString()}]`, ...m);
}

// ─── rate-limited HTTP ───────────────────────────────────────────────────
const MIN_INTERVAL_MS = Math.round(60_000 / RPM);
const ANALYTICS_INTERVAL_MS = Math.round(60_000 / ANALYTICS_RPM);
const LEADS_INTERVAL_MS = Math.round(60_000 / LEADS_RPM);
let chain = Promise.resolve();
function rateLimit(intervalMs = MIN_INTERVAL_MS) {
  const next = chain.then(() => new Promise((r) => setTimeout(r, intervalMs)));
  chain = next.catch(() => undefined);
  return next;
}

async function callApi(path, opts = {}) {
  const url = new URL('https://api.instantly.ai/api/v2' + path);
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const init = { method: opts.method ?? 'GET', headers: { Authorization: `Bearer ${KEY}` } };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    await rateLimit(opts.intervalMs ?? (opts.fastPace ? ANALYTICS_INTERVAL_MS : MIN_INTERVAL_MS));
    try {
      const r = await fetch(url.toString(), init);
      if (r.status === 429) {
        const wait = 15_000 + 5_000 * attempt;
        log(`  ! 429 on ${path} — sleep ${wait}ms`);
        await new Promise((res) => setTimeout(res, wait));
        continue;
      }
      if (r.status >= 500) {
        const wait = 3_000 * Math.pow(2, attempt);
        await new Promise((res) => setTimeout(res, wait));
        continue;
      }
      if (!r.ok) {
        const t = (await r.text()).slice(0, 200);
        const e = new Error(`HTTP ${r.status}: ${t}`);
        e.noRetry = r.status >= 400 && r.status < 500;
        throw e;
      }
      if (r.status === 204) return null;
      return await r.json();
    } catch (e) {
      if (e.noRetry) throw e;
      log(`  ! ${path} attempt ${attempt + 1}/5: ${e.message}`);
      await new Promise((res) => setTimeout(res, 3000 * (attempt + 1)));
    }
  }
  throw new Error(`Gave up on ${path}`);
}

async function paginateGet(path, params = {}, label) {
  const all = [];
  let after;
  let page = 0;
  do {
    const res = await callApi(path, { params: { limit: 100, ...params, starting_after: after } });
    if (res?.items?.length) all.push(...res.items);
    after = res?.next_starting_after || undefined;
    page++;
  } while (after);
  log(`  ${label}: ${all.length} items (${page} pages)`);
  return all;
}

// ─── DB helpers ──────────────────────────────────────────────────────────
const toTs = (v) => (v ? new Date(v) : null);
const stripNul = (s) => (typeof s === 'string' ? s.replace(/ /g, '') : s);
const toText = (v) => (v == null ? null : stripNul(typeof v === 'string' ? v : String(v)));
const toJson = (v) => {
  if (v == null) return null;
  return JSON.stringify(v).replace(/\\u0000/g, '');
};
const toInt = (v) => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const toBool = (v) => (v == null ? null : Boolean(v));
// Instantly returns step/variant idx as strings, with aggregate rows as null/"null"/"\N".
function parseIdx(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || s === 'null' || s === '\\N' || s === 'N/A') return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

const BATCH = 500;
// keepFirst: колонки «когда впервые увидели» — при конфликте берём старое значение,
// если оно есть, иначе новое (COALESCE). Иначе строки майского слепка, попавшие в
// захват, навсегда остались бы с NULL.
async function upsertBatch(client, table, cols, conflictTarget, rows, { keepFirst = [] } = {}) {
  if (!rows.length) return 0;
  let total = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const params = [];
    let p = 1;
    const valueRows = slice.map((r) => {
      const placeholders = cols.map(() => `$${p++}`).join(', ');
      for (const c of cols) params.push(r[c] === undefined ? null : r[c]);
      return `(${placeholders})`;
    });
    const updateSet = cols.filter((c) => !conflictTarget.includes(c))
      .map((c) => keepFirst.includes(c) ? `${c} = COALESCE(${table}.${c}, EXCLUDED.${c})` : `${c} = EXCLUDED.${c}`).join(', ');
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${valueRows.join(', ')}
                 ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updateSet}`;
    if (DRY) { total += slice.length; continue; }
    try {
      const res = await client.query(sql, params);
      total += res.rowCount;
    } catch (e) {
      log(`  ! batch failed on ${table}: ${e.message.slice(0, 120)} (skip ${slice.length})`);
      try { await client.query('SELECT 1'); } catch {}
    }
  }
  return total;
}

// ─── entity sync phases ──────────────────────────────────────────────────

async function syncCampaigns(client) {
  log('→ campaigns');
  const data = await paginateGet('/campaigns', {}, 'campaigns');
  const rows = data.map((c) => ({
    id: c.id, name: toText(c.name), status: toInt(c.status),
    timestamp_created: toTs(c.timestamp_created),
    timestamp_updated: toTs(c.timestamp_updated),
    daily_limit: toInt(c.daily_limit),
    daily_max_leads: toInt(c.daily_max_leads),
    email_gap: toInt(c.email_gap),
    is_evergreen: toBool(c.is_evergreen),
    open_tracking: toBool(c.open_tracking),
    link_tracking: toBool(c.link_tracking),
    stop_on_reply: toBool(c.stop_on_reply),
    email_list: c.email_list ?? null,
    email_tag_list: c.email_tag_list ?? null,
    campaign_schedule: toJson(c.campaign_schedule),
    sequences: toJson(c.sequences),
    raw_payload: toJson(c),
  }));
  const cols = ['id','name','status','timestamp_created','timestamp_updated','daily_limit','daily_max_leads','email_gap','is_evergreen','open_tracking','link_tracking','stop_on_reply','email_list','email_tag_list','campaign_schedule','sequences','raw_payload'];
  const n = await upsertBatch(client, 'raw_campaigns', cols, 'id', rows);
  log(`  raw_campaigns: ${n} upserted`);

  // Re-explode steps (cheap, do it always)
  const stepRows = [];
  for (const c of data) {
    const sequences = c.sequences ?? [];
    sequences.forEach((seq, seqIdx) => {
      const steps = seq?.steps ?? [];
      steps.forEach((step, stepIdx) => {
        const variants = step?.variants?.length ? step.variants : [{ subject: step?.subject, body: step?.body }];
        variants.forEach((v, varIdx) => {
          stepRows.push({
            campaign_id: c.id, sequence_n: seqIdx, step_n: stepIdx, variant_n: varIdx,
            subject: toText(v.subject), body_text: toText(extractText(v.body ?? step?.body)),
            wait_days: toInt(step?.wait_days), delay: toInt(step?.delay),
            delay_unit: step?.delay_unit ?? null, step_type: step?.type ?? 'email',
            raw_payload: toJson({ step, variant: v }),
          });
        });
      });
    });
  }
  if (stepRows.length) {
    const stepCols = ['campaign_id','sequence_n','step_n','variant_n','subject','body_text','wait_days','delay','delay_unit','step_type','raw_payload'];
    const ns = await upsertBatch(client, 'raw_campaign_steps', stepCols, 'campaign_id, sequence_n, step_n, variant_n', stepRows);
    log(`  raw_campaign_steps: ${ns} upserted`);
  }
  return data;
}

function extractText(body) {
  if (body == null) return null;
  if (typeof body === 'string') return body;
  if (body.text) return body.text;
  if (body.html) {
    return body.html
      .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
      .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
  }
  return null;
}

async function syncAccounts(client) {
  log('→ accounts');
  const data = await paginateGet('/accounts', {}, 'accounts');
  const rows = data.map((a) => ({
    email: a.email, first_name: toText(a.first_name), last_name: toText(a.last_name),
    organization: toText(a.organization), provider_code: toInt(a.provider_code),
    status: toInt(a.status), warmup_status: toInt(a.warmup_status),
    daily_limit: toInt(a.daily_limit), sending_gap: toInt(a.sending_gap),
    setup_pending: toBool(a.setup_pending), is_managed_account: toBool(a.is_managed_account),
    tracking_domain_name: toText(a.tracking_domain_name),
    tracking_domain_status: toText(a.tracking_domain_status),
    stat_warmup_score: a.stat_warmup_score ?? null, warmup_pool_id: a.warmup_pool_id ?? null,
    timestamp_created: toTs(a.timestamp_created),
    timestamp_updated: toTs(a.timestamp_updated),
    timestamp_last_used: toTs(a.timestamp_last_used),
    timestamp_warmup_start: toTs(a.timestamp_warmup_start),
    warmup: toJson(a.warmup), status_message: toJson(a.status_message),
    raw_payload: toJson(a),
  }));
  const cols = ['email','first_name','last_name','organization','provider_code','status','warmup_status','daily_limit','sending_gap','setup_pending','is_managed_account','tracking_domain_name','tracking_domain_status','stat_warmup_score','warmup_pool_id','timestamp_created','timestamp_updated','timestamp_last_used','timestamp_warmup_start','warmup','status_message','raw_payload','pulled_at'];
  const pulledAt = new Date();
  for (const r of rows) r.pulled_at = pulledAt; // «когда видели в последний раз»
  const n = await upsertBatch(client, 'raw_accounts', cols, 'email', rows);
  log(`  raw_accounts: ${n} upserted`);

  // Soft-delete удалённых в Instantly почт. В ОТЛИЧИЕ от маппингов, /accounts
  // стабилен (замер: 1014 в 9 пулах подряд), поэтому отсутствие в пуле = ящик
  // удалён. HARD-delete нельзя — на email смотрит история raw_emails.eaccount.
  //
  // СТРАХОВКА (урок Зиккурата, где deleteMissing по усечённому пулу маппингов снёс
  // живое): помечаем удалёнными ТОЛЬКО если пул покрывает >=90% текущих живых.
  // Битый/усечённый пул → пропускаем, ждём здоровой ночи. Плюс обратная разметка:
  // вернулся в пул → снимаем метку (ложный soft-delete самолечится). Дашборды
  // фильтруют deleted_at IS NULL.
  const liveEmails = rows.map((r) => r.email).filter(Boolean);
  if (!liveEmails.length || DRY) return;
  try {
    const { rows: [{ n: liveNow }] } = await client.query(
      `SELECT count(*)::int AS n FROM raw_accounts WHERE deleted_at IS NULL`);
    const back = await client.query(
      `UPDATE raw_accounts SET deleted_at = NULL
       WHERE deleted_at IS NOT NULL AND email = ANY($1::text[])`, [liveEmails]);
    if (back.rowCount) log(`  raw_accounts: ${back.rowCount} восстановлено (снова видны)`);
    if (liveEmails.length >= 0.9 * liveNow) {
      const del = await client.query(
        `UPDATE raw_accounts SET deleted_at = now()
         WHERE deleted_at IS NULL AND NOT (email = ANY($1::text[]))`, [liveEmails]);
      if (del.rowCount) log(`  raw_accounts: ${del.rowCount} помечено удалёнными (нет в /accounts)`);
    } else {
      log(`  ! accounts: пул ${liveEmails.length} < 90% от ${liveNow} живых — soft-delete пропущен (усечённый пул?)`);
    }
  } catch (e) {
    log(`  ! accounts soft-delete failed: ${e.message.slice(0, 120)}`);
  }
}

// ⛔ НИКАКОГО DELETE по составу одного пула. Инцидент 15.07: paginateGet молча
// обрывается на любой ошибке страницы (rate-limit Instantly ~10 RPM, а тут 20
// страниц подряд) — `after` становится undefined и цикл выходит БЕЗ ошибки, отдав
// обрезанный список. deleteMissing поверх такого пула удалил 200 живых маппингов
// за одну ночь (у тега «Зиккурат» осталось 5 привязок из 16 → потолок считался по
// 2 ящикам вместо 16 → «142% перебор»).
//
// Вместо удаления — «когда видели в последний раз» (pulled_at) + PARTIAL-детект:
// исчезновение строки становится видимым, но НЕ разрушительным. Потребитель
// (дашборд) сам решает, что считать протухшим; неполный пул самолечится следующей
// ночью, потому что upsert только добавляет.
async function syncSimpleList(client, label, table, path, conflict, mapper) {
  log(`→ ${label}`);
  const data = await paginateGet(path, {}, label);
  // pulled_at обновляем при каждом синке → семантика «когда видели в последний раз»
  const pulledAt = new Date();
  const rows = data.map(mapper).map((r) => ({ ...r, pulled_at: pulledAt }));
  const cols = Object.keys(rows[0] || {});
  if (!cols.length) { log(`  ${table}: 0`); return; }
  const n = await upsertBatch(client, table, cols, conflict, rows);
  log(`  ${table}: ${n} upserted`);
}

// ─── emails DELTA ────────────────────────────────────────────────────────

async function syncEmailsDelta(client) {
  log('→ emails (delta)');
  const seenIds = new Set();
  let totalNew = 0;
  let totalPages = 0;
  const newByCampaign = new Map(); // for analytics refresh

  let after;
  let consecutiveAllKnown = 0;
  const STOP_AFTER_ALL_KNOWN_PAGES = 2;

  while (true) {
    totalPages++;
    const res = await callApi('/emails', { params: { limit: 100, starting_after: after } });
    const items = res?.items ?? [];
    if (!items.length) break;

    const ids = items.map((e) => e.id).filter(Boolean);
    // Bulk check: which of these are already in raw_emails?
    const { rows: existing } = await client.query(
      `SELECT id FROM raw_emails WHERE id = ANY($1::text[])`, [ids]
    );
    const existingSet = new Set(existing.map((r) => r.id));
    const newOnes = items.filter((e) => e.id && !existingSet.has(e.id));

    if (newOnes.length === 0) {
      consecutiveAllKnown++;
      log(`  page ${totalPages}: all ${items.length} already known (streak ${consecutiveAllKnown}/${STOP_AFTER_ALL_KNOWN_PAGES})`);
      if (consecutiveAllKnown >= STOP_AFTER_ALL_KNOWN_PAGES) {
        log(`  → reached known-data boundary, stopping delta`);
        break;
      }
    } else {
      consecutiveAllKnown = 0;
      const rows = newOnes.map((e) => ({
        id: e.id, campaign_id: e.campaign_id ?? null,
        lead_id: e.lead ?? null, thread_id: e.thread_id ?? null,
        eaccount: toText(e.eaccount), ue_type: toInt(e.ue_type),
        subject: toText(e.subject), body_text: toText(extractText(e.body)),
        content_preview: toText(e.content_preview),
        from_email: toText(e.from_address_email), to_email: toText(e.to_address_email_list),
        from_address_json: toJson(e.from_address_json),
        to_address_json: toJson(e.to_address_json),
        i_status: toInt(e.i_status), ai_interest_value: toInt(e.ai_interest_value),
        timestamp_email: toTs(e.timestamp_email),
        timestamp_created: toTs(e.timestamp_created),
        raw_payload: toJson(e),
      }));
      const cols = ['id','campaign_id','lead_id','thread_id','eaccount','ue_type','subject','body_text','content_preview','from_email','to_email','from_address_json','to_address_json','i_status','ai_interest_value','timestamp_email','timestamp_created','raw_payload'];
      const n = await upsertBatch(client, 'raw_emails', cols, 'id', rows);
      totalNew += n;
      for (const e of newOnes) {
        if (e.campaign_id) newByCampaign.set(e.campaign_id, (newByCampaign.get(e.campaign_id) ?? 0) + 1);
      }
      log(`  page ${totalPages}: +${n} new emails (running total ${totalNew})`);
    }

    after = res.next_starting_after;
    if (!after) break;
  }

  log(`  ✓ emails delta: ${totalNew} new emails across ${newByCampaign.size} active campaigns (${totalPages} pages scanned)`);
  return newByCampaign;
}

// ─── analytics refresh for active campaigns ──────────────────────────────

async function syncAnalyticsOverview(client, snapshotId, activeCampaignIds) {
  log(`→ overview analytics for ${activeCampaignIds.length} campaigns`);
  if (!activeCampaignIds.length) return;
  let done = 0, failed = 0;
  const rows = [];
  for (const id of activeCampaignIds) {
    try {
      const payload = await callApi('/campaigns/analytics/overview', { params: { id }, fastPace: true });
      if (!payload) continue;
      rows.push({
        snapshot_id: snapshotId, campaign_id: id,
        campaign_name: toText(payload.campaign_name),
        emails_sent_count: toInt(payload.emails_sent_count),
        contacted_count: toInt(payload.contacted_count),
        new_leads_contacted_count: toInt(payload.new_leads_contacted_count),
        open_count: toInt(payload.open_count),
        open_count_unique: toInt(payload.open_count_unique),
        reply_count: toInt(payload.reply_count),
        bounced_count: toInt(payload.bounced_count),
        unsubscribed_count: toInt(payload.unsubscribed_count),
        leads_count: toInt(payload.leads_count),
        raw_payload: toJson(payload),
      });
      done++;
      if (done % 50 === 0) log(`  overview progress: ${done}/${activeCampaignIds.length}`);
    } catch (e) {
      failed++;
      log(`  ! overview ${id.slice(0, 8)} failed: ${e.message.slice(0, 80)}`);
    }
  }
  if (rows.length) {
    const cols = ['snapshot_id','campaign_id','campaign_name','emails_sent_count','contacted_count','new_leads_contacted_count','open_count','open_count_unique','reply_count','bounced_count','unsubscribed_count','leads_count','raw_payload'];
    const n = await upsertBatch(client, 'raw_campaign_analytics_overview_snap', cols, 'snapshot_id, campaign_id', rows);
    log(`  raw_campaign_analytics_overview_snap: ${n} inserted (${failed} failed)`);
  }
  return rows;
}

// Step analytics — feeds v_subject_performance. WITHOUT this, subject metrics
// rot to the last full pull (eval-loop finding, query_log id=2).
async function syncStepAnalytics(client, snapshotId, activeCampaignIds) {
  log(`→ step analytics for ${activeCampaignIds.length} campaigns`);
  if (!activeCampaignIds.length) return;
  let failed = 0;
  const rows = [];
  for (const id of activeCampaignIds) {
    try {
      const list = await callApi('/campaigns/analytics/steps', { params: { campaign_id: id }, fastPace: true });
      if (!Array.isArray(list)) continue;
      for (const s of list) {
        const stepN = parseIdx(s.step ?? s.step_n);
        if (stepN == null) continue; // skip aggregate "no step" rows
        rows.push({
          snapshot_id: snapshotId, campaign_id: id,
          step_n: stepN, variant_n: parseIdx(s.variant ?? s.variant_n) ?? 0,
          sent: toInt(s.sent), opened: toInt(s.opened), unique_opened: toInt(s.unique_opened ?? s.opened_unique),
          replies: toInt(s.replies), unique_replies: toInt(s.unique_replies ?? s.replies_unique),
          clicks: toInt(s.clicks), unique_clicks: toInt(s.unique_clicks ?? s.clicks_unique),
          opportunities: toInt(s.opportunities), raw_payload: toJson(s),
        });
      }
    } catch (e) { failed++; }
  }
  if (rows.length) {
    const cols = ['snapshot_id','campaign_id','step_n','variant_n','sent','opened','unique_opened','replies','unique_replies','clicks','unique_clicks','opportunities','raw_payload'];
    const n = await upsertBatch(client, 'raw_campaign_step_analytics_snap', cols, 'snapshot_id, campaign_id, step_n, variant_n', rows);
    log(`  raw_campaign_step_analytics_snap: ${n} inserted (${failed} failed)`);
  }
}

// Daily analytics — feeds trend lines.
async function syncDailyAnalytics(client, snapshotId, activeCampaignIds) {
  log(`→ daily analytics for ${activeCampaignIds.length} campaigns`);
  if (!activeCampaignIds.length) return;
  let failed = 0;
  const rows = [];
  for (const id of activeCampaignIds) {
    try {
      const payload = await callApi('/campaigns/analytics/daily', { params: { campaign_id: id }, fastPace: true }); // daily filters by campaign_id, NOT id (id → workspace-wide). Fixed 2026-05-30.
      const days = Array.isArray(payload) ? payload : (payload?.items || payload?.data || []);
      for (const d of days) {
        const dateStr = d.date || d.day;
        if (!dateStr) continue;
        rows.push({
          snapshot_id: snapshotId, campaign_id: id, date: dateStr,
          sent: toInt(d.sent), opened: toInt(d.opened), unique_opened: toInt(d.unique_opened ?? d.opened_unique),
          replies: toInt(d.replies), unique_replies: toInt(d.unique_replies ?? d.replies_unique),
          clicks: toInt(d.clicks), unique_clicks: toInt(d.unique_clicks ?? d.clicks_unique),
          bounced: toInt(d.bounced ?? d.bounces), unsubscribed: toInt(d.unsubscribed), raw_payload: toJson(d),
        });
      }
    } catch (e) { failed++; }
  }
  if (rows.length) {
    const cols = ['snapshot_id','campaign_id','date','sent','opened','unique_opened','replies','unique_replies','clicks','unique_clicks','bounced','unsubscribed','raw_payload'];
    const n = await upsertBatch(client, 'raw_campaign_analytics_daily_snap', cols, 'snapshot_id, campaign_id, date', rows);
    log(`  raw_campaign_analytics_daily_snap: ${n} inserted (${failed} failed)`);
  }
}

// ─── leads capture (phase 5) ─────────────────────────────────────────────
//
// Карточка лида в Instantly живёт 4–8 недель: команда постоянно чистит кампании
// от контактов ради места по тарифу (замер 17.08.2026: из 2 576 кампаний лиды
// остались в 304, всё старше июня — в ноль). Письма чистку переживают, карточки
// нет. Здесь снимаем карточки всех кампаний с leads_count>0 и UPSERT-им в
// raw_leads. ⛔ НИКАКИХ удалений: после чистки у нас остаётся последний снимок
// (открытия/ответы/статус/домен/upload_payload). Повторы режем по отпечатку
// счётчиков кампании (lead_capture_state): не двигались — карточки не трогаем.

// Идемпотентный DDL рядом со скриптом (deploy-sync.sh кладёт 022 в /opt/...).
async function applyLeadsCaptureDdl(client) {
  const p = resolve(__dirname, '022_leads_capture.sql');
  if (!existsSync(p)) { log('  022_leads_capture.sql not found next to sync.mjs — DDL skipped'); return false; }
  if (DRY) { log('  (dry) 022_leads_capture.sql present, not applied'); return true; }
  await client.query(readFileSync(p, 'utf8'));
  return true;
}

function leadRow(l, campId, pulledAt) {
  const payload = l.payload && typeof l.payload === 'object' ? l.payload : null;
  return {
    id: l.id, email: toText(l.email),
    campaign_id: l.campaign ?? l.campaign_id ?? campId,
    lead_list_id: l.list_id ?? l.lead_list_id ?? null,
    first_name: toText(l.first_name), last_name: toText(l.last_name),
    company_name: toText(l.company_name), title: toText(l.title),
    phone: toText(l.phone), website: toText(l.website), linkedin_url: toText(l.linkedin_url),
    interest_status: toInt(l.lt_interest_status ?? l.interest_status),
    interest_value: toText(l.interest_value),
    custom_variables: toJson(l.custom_variables),
    timestamp_created: toTs(l.timestamp_created), timestamp_updated: toTs(l.timestamp_updated),
    raw_payload: toJson(l), pulled_at: pulledAt, first_pulled_at: pulledAt,
    status: toInt(l.status),
    email_open_count: toInt(l.email_open_count), email_reply_count: toInt(l.email_reply_count),
    email_click_count: toInt(l.email_click_count),
    email_opened_step: toInt(l.email_opened_step), email_replied_step: toInt(l.email_replied_step),
    company_domain: toText(l.company_domain),
    verification_status: toInt(l.verification_status), esp_code: toInt(l.esp_code),
    upload_method: toText(l.upload_method), uploaded_by_user: toText(l.uploaded_by_user),
    personalization: toText(l.personalization), upload_payload: toJson(payload),
    timestamp_last_contact: toTs(l.timestamp_last_contact), timestamp_last_open: toTs(l.timestamp_last_open),
    timestamp_last_reply: toTs(l.timestamp_last_reply), timestamp_last_click: toTs(l.timestamp_last_click),
    timestamp_last_touch: toTs(l.timestamp_last_touch),
  };
}
const LEAD_COLS = ['id','email','campaign_id','lead_list_id','first_name','last_name','company_name','title','phone','website','linkedin_url','interest_status','interest_value','custom_variables','timestamp_created','timestamp_updated','raw_payload','pulled_at','first_pulled_at','status','email_open_count','email_reply_count','email_click_count','email_opened_step','email_replied_step','company_domain','verification_status','esp_code','upload_method','uploaded_by_user','personalization','upload_payload','timestamp_last_contact','timestamp_last_open','timestamp_last_reply','timestamp_last_click','timestamp_last_touch'];

async function syncLeadsCapture(client, counts) {
  log(`→ leads capture (rpm=${LEADS_RPM}, max-pages=${LEADS_MAX_PAGES}, full=${LEADS_FULL})`);
  if (!(await applyLeadsCaptureDdl(client)) && !DRY) { log('  ! leads capture skipped: no DDL'); return; }

  // 1. Один вызов: кто сейчас держит лидов + счётчики для отпечатка
  let an = await callApi('/campaigns/analytics', { fastPace: true });
  if (!Array.isArray(an)) an = an?.items ?? [];
  const holders = an.filter((c) => c?.campaign_id && (toInt(c.leads_count) ?? 0) > 0);
  const zeroed = an.filter((c) => c?.campaign_id && (toInt(c.leads_count) ?? 0) === 0).map((c) => c.campaign_id);
  log(`  /campaigns/analytics: ${an.length} campaigns, ${holders.length} with leads (${holders.reduce((s, c) => s + toInt(c.leads_count), 0)} leads)`);
  counts.leads_holders = holders.length;

  // 2. Отпечатки прошлых захватов (таблицы может ещё не быть в --dry-run)
  const state = new Map();
  try {
    const r = await client.query(`SELECT campaign_id, fingerprint FROM lead_capture_state`);
    for (const s of r.rows) state.set(s.campaign_id, s.fingerprint);
  } catch (e) {
    if (!DRY) throw e;
    log(`  (dry) lead_capture_state unreadable (${e.message.slice(0, 60)}) — считаем, что захватов не было`);
  }
  // Кампанию вычистили → фиксируем момент (первый раз), больше ничего.
  if (!DRY && zeroed.length) {
    const r = await client.query(
      `UPDATE lead_capture_state SET cleaned_at = now()
       WHERE cleaned_at IS NULL AND leads_count > 0 AND campaign_id = ANY($1::text[])`, [zeroed]);
    if (r.rowCount) log(`  ${r.rowCount} campaigns purged since last capture (cleaned_at set)`);
  }

  // 3. Отбор: не изменившиеся — пропускаем; никогда не снятые — первыми (их
  //    вычистят раньше всего), затем изменившиеся; внутри группы — старшие первыми.
  const created = new Map((await client.query(`SELECT id, timestamp_created FROM raw_campaigns`)).rows
    .map((r) => [r.id, r.timestamp_created ? new Date(r.timestamp_created).getTime() : 0]));
  const fp = (c) => ['leads_count', 'emails_sent_count', 'open_count', 'reply_count', 'bounced_count'].map((k) => toInt(c[k]) ?? 0).join(':');
  let candidates = holders.map((c) => ({
    id: c.campaign_id, leads: toInt(c.leads_count), fingerprint: fp(c),
    never: !state.has(c.campaign_id), changed: state.get(c.campaign_id) !== fp(c),
    pages: Math.ceil(toInt(c.leads_count) / 100), created: created.get(c.campaign_id) ?? 0, src: c,
  }));
  const unchanged = candidates.filter((c) => !LEADS_FULL && !c.never && !c.changed);
  candidates = candidates.filter((c) => LEADS_FULL || c.never || c.changed)
    .sort((a, b) => (b.never - a.never) || (a.created - b.created));
  if (!DRY && unchanged.length) {
    await client.query(`UPDATE lead_capture_state SET last_seen_leads_at = now() WHERE campaign_id = ANY($1::text[])`,
      [unchanged.map((c) => c.id)]);
  }
  if (LEADS_LIMIT_CAMPAIGNS > 0) candidates = candidates.slice(0, LEADS_LIMIT_CAMPAIGNS);
  let budget = LEADS_MAX_PAGES, dropped = 0, droppedPages = 0;
  const selected = [];
  for (const c of candidates) {
    if (c.pages <= budget) { selected.push(c); budget -= c.pages; }
    else { dropped++; droppedPages += c.pages; }
  }
  const estPages = selected.reduce((s, c) => s + c.pages, 0);
  log(`  selected ${selected.length} campaigns (~${estPages} pages ≈ ${Math.round(estPages / LEADS_RPM)} min), unchanged skipped ${unchanged.length}` +
      (dropped ? `, ⚠ DROPPED by page cap: ${dropped} campaigns / ~${droppedPages} pages (next night: they go first if still unchanged-never)` : ''));
  counts.leads_skipped_unchanged = unchanged.length;
  counts.leads_dropped_by_cap = dropped;

  // 4. Захват
  const pulledAt = new Date();
  let totalLeads = 0, totalPages = 0, done = 0, failed = 0, empty = 0;
  for (const c of selected) {
    let after, pages = 0, upserted = 0;
    try {
      do {
        const res = await callApi('/leads/list', {
          method: 'POST', intervalMs: LEADS_INTERVAL_MS,
          body: { campaign: c.id, limit: 100, starting_after: after },
        });
        const items = res?.items ?? [];
        pages++;
        if (items.length) {
          const rows = items.filter((l) => l?.id).map((l) => leadRow(l, c.id, pulledAt));
          upserted += await upsertBatch(client, 'raw_leads', LEAD_COLS, 'id', rows, { keepFirst: ['first_pulled_at'] });
        }
        after = res?.next_starting_after || undefined;
      } while (after);
      // Аналитика говорит leads_count>0, а /leads/list пуст (лидов вычистили между
      // обновлением счётчика и нашим вызовом) — отпечаток НЕ пишем, чтобы кампания
      // перепроверилась следующей ночью (цена — одна страница).
      if (upserted === 0 && c.leads > 0) {
        empty++; totalPages += pages;
        log(`  ~ leads ${c.id.slice(0, 8)}: analytics says ${c.leads}, /leads/list returned 0 — state not recorded`);
        continue;
      }
      if (!DRY) {
        await client.query(
          `INSERT INTO lead_capture_state (campaign_id, leads_count, emails_sent_count, open_count, reply_count, bounced_count,
                                           fingerprint, leads_pulled, pages, first_captured_at, last_captured_at, last_seen_leads_at, cleaned_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), now(), now(), NULL)
           ON CONFLICT (campaign_id) DO UPDATE SET
             leads_count = EXCLUDED.leads_count, emails_sent_count = EXCLUDED.emails_sent_count,
             open_count = EXCLUDED.open_count, reply_count = EXCLUDED.reply_count, bounced_count = EXCLUDED.bounced_count,
             fingerprint = EXCLUDED.fingerprint, leads_pulled = EXCLUDED.leads_pulled, pages = EXCLUDED.pages,
             last_captured_at = now(), last_seen_leads_at = now(), cleaned_at = NULL`,
          [c.id, c.leads, toInt(c.src.emails_sent_count), toInt(c.src.open_count), toInt(c.src.reply_count),
           toInt(c.src.bounced_count), c.fingerprint, upserted, pages]);
      }
      done++; totalLeads += upserted; totalPages += pages;
      if (done % 25 === 0) log(`  leads progress: ${done}/${selected.length} campaigns, ${totalLeads} leads, ${totalPages} pages`);
    } catch (e) {
      // Отпечаток НЕ обновляем → следующей ночью кампания пойдёт заново.
      failed++; totalPages += pages;
      log(`  ! leads ${c.id.slice(0, 8)} failed after ${pages} pages: ${e.message.slice(0, 100)}`);
    }
  }
  log(`  ✓ leads capture: ${totalLeads} leads upserted from ${done} campaigns (${totalPages} pages, ${failed} failed, ${empty} empty)`);
  counts.leads_captured = totalLeads;
  counts.leads_campaigns = done;
  counts.leads_pages = totalPages;
  counts.leads_failed = failed;
  counts.leads_empty = empty;
}

// ─── main ────────────────────────────────────────────────────────────────

(async () => {
  const tStart = Date.now();
  log(`Starting daily sync. rpm=${RPM} analytics-rpm=${ANALYTICS_RPM} leads-rpm=${LEADS_RPM} dry=${DRY} emails-only=${EMAILS_ONLY} leads-only=${LEADS_ONLY} full=${FULL} weekly-full=${WEEKLY_FULL}`);
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  // open snapshot row
  let snapshotId = null;
  if (!DRY) {
    const r = await client.query(
      `INSERT INTO dataset_snapshots (mode, notes) VALUES ('delta', $1) RETURNING id`,
      [`${LEADS_ONLY ? 'leads-only sync' : 'daily sync'} ${new Date().toISOString()}`]
    );
    snapshotId = r.rows[0].id;
    log(`Snapshot opened: ${snapshotId}`);
  }

  const counts = {};
  try {
    if (!EMAILS_ONLY && !LEADS_ONLY) {
      // 1. entities
      await syncCampaigns(client);
      await syncAccounts(client);
      await syncSimpleList(client, 'lead_lists', 'raw_lead_lists', '/lead-lists', 'id',
        (l) => ({ id: l.id, name: toText(l.name), timestamp_created: toTs(l.timestamp_created), timestamp_updated: toTs(l.timestamp_updated), raw_payload: toJson(l) }));
      await syncSimpleList(client, 'email_templates', 'raw_email_templates', '/email-templates', 'id',
        (t) => ({ id: t.id, name: toText(t.name), subject: toText(t.subject), body: extractText(t.body),
                  timestamp_created: toTs(t.timestamp_created), timestamp_updated: toTs(t.timestamp_updated),
                  raw_payload: toJson(t) }));
      await syncSimpleList(client, 'custom_tags', 'raw_custom_tags', '/custom-tags', 'id',
        (t) => ({ id: t.id, name: toText(t.name ?? t.label), description: toText(t.description),
                  timestamp_created: toTs(t.timestamp_created), timestamp_updated: toTs(t.timestamp_updated),
                  raw_payload: toJson(t) }));
      await syncSimpleList(client, 'custom_tag_mappings', 'raw_custom_tag_mappings', '/custom-tag-mappings', 'id',
        (m) => ({ id: m.id, tag_id: m.tag_id, resource_id: m.resource_id, resource_type: m.resource_type,
                  raw_payload: toJson(m) }));
      await syncSimpleList(client, 'lead_labels', 'raw_lead_labels', '/lead-labels', 'id',
        (l) => ({ id: l.id, name: toText(l.name), color: toText(l.color),
                  timestamp_created: toTs(l.timestamp_created), timestamp_updated: toTs(l.timestamp_updated),
                  raw_payload: toJson(l) }));
      await syncSimpleList(client, 'block_list', 'raw_block_list', '/block-lists-entries', 'id',
        (b) => ({ id: b.id, value: toText(b.value), type: toText(b.type),
                  timestamp_created: toTs(b.timestamp_created), timestamp_updated: toTs(b.timestamp_updated),
                  raw_payload: toJson(b) }));
      // webhooks intentionally NOT synced — table was dropped in migration 002 (operational, not analytical)
    }

    // 2. emails delta
    let newByCampaign = new Map();
    if (!SKIP_EMAILS && !LEADS_ONLY) {
      newByCampaign = await syncEmailsDelta(client);
      counts.new_emails = [...newByCampaign.values()].reduce((a, b) => a + b, 0);
      counts.active_campaigns = newByCampaign.size;
    }

    // 3. analytics: nightly — campaigns with new emails; Sunday/--full — all
    if (!EMAILS_ONLY && !LEADS_ONLY) {
      const activeIds = [...newByCampaign.keys()];
      let overviewIds = activeIds;
      if (FULL || WEEKLY_FULL) {
        const r = await client.query('SELECT id FROM raw_campaigns');
        overviewIds = r.rows.map((x) => x.id);
        log(`${FULL ? '--full' : 'weekly full (Sunday)'}: overview for all ${overviewIds.length} campaigns at ${ANALYTICS_RPM} rpm`);
      }
      const LIMIT = flag('limit-campaigns') ? Number(flag('limit-campaigns')) : 0;
      if (LIMIT > 0) overviewIds = overviewIds.slice(0, LIMIT);
      const overviewRows = await syncAnalyticsOverview(client, snapshotId, overviewIds) ?? [];

      // steps+daily scope. Weekly full: campaigns whose lifetime counters
      // moved since their previous snapshot (late opens/replies on finished
      // campaigns) + tonight's active ones. Daily history of unchanged
      // campaigns is immutable — re-storing it weekly would only bloat the DB.
      let stepDailyIds = activeIds;
      if (FULL) {
        stepDailyIds = overviewIds;
      } else if (WEEKLY_FULL && overviewRows.length) {
        const prev = await client.query(
          `SELECT DISTINCT ON (o.campaign_id) o.campaign_id, o.emails_sent_count, o.open_count, o.reply_count, o.bounced_count, o.leads_count
           FROM raw_campaign_analytics_overview_snap o
           JOIN dataset_snapshots ds ON ds.id = o.snapshot_id
           WHERE o.snapshot_id <> $1
           ORDER BY o.campaign_id, ds.started_at DESC`, [snapshotId]);
        const prevBy = new Map(prev.rows.map((p) => [p.campaign_id, p]));
        const KEYS = ['emails_sent_count', 'open_count', 'reply_count', 'bounced_count', 'leads_count'];
        const changed = overviewRows
          .filter((r) => { const p = prevBy.get(r.campaign_id); return !p || KEYS.some((k) => toInt(p[k]) !== toInt(r[k])); })
          .map((r) => r.campaign_id);
        stepDailyIds = [...new Set([...changed, ...activeIds])];
        counts.weekly_full = true;
        counts.weekly_changed = changed.length;
        log(`  weekly full: ${changed.length} campaigns with moved counters → steps+daily refresh`);
      }
      await syncStepAnalytics(client, snapshotId, stepDailyIds);   // feeds v_subject_performance
      await syncDailyAnalytics(client, snapshotId, stepDailyIds);  // feeds trend lines
      counts.overview_refreshed = overviewIds.length;
    }

    // 5. leads capture — последней: самая долгая и наименее критичная фаза;
    //    падение здесь не трогает уже записанные письма/аналитику. Свой try —
    //    чтобы ошибка захвата не пометила всю ночь как FAILED.
    if (!SKIP_LEADS && !EMAILS_ONLY) {
      try {
        await syncLeadsCapture(client, counts);
      } catch (e) {
        log(`  ✗ leads capture FAILED: ${e.message.slice(0, 200)}`);
        counts.leads_error = e.message.slice(0, 200);
      }
    }

    if (!DRY) {
      await client.query(
        `UPDATE dataset_snapshots SET ok = true, finished_at = now(), counts = $1 WHERE id = $2`,
        [JSON.stringify(counts), snapshotId]
      );
    }
    log(`✓ sync DONE in ${((Date.now() - tStart) / 1000).toFixed(0)}s. snapshot=${snapshotId}`);
    log(`Counts: ${JSON.stringify(counts)}`);
  } catch (err) {
    log(`✗ sync FAILED: ${err.stack || err.message}`);
    if (!DRY && snapshotId) {
      await client.query(
        `UPDATE dataset_snapshots SET notes = notes || ' | FAILED: ' || $1, finished_at = now() WHERE id = $2`,
        [err.message.slice(0, 200), snapshotId]
      );
    }
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
