/**
 * pull.mjs — Instantly → JSON cache (one-time full dump).
 *
 * Phases are idempotent. Cache files live in .tmp/instantly-cache/.
 * If a phase's main cache file already exists, the phase is skipped unless
 * you pass --refresh-<phase> (e.g. --refresh-emails).
 *
 * Per-campaign work (leads/emails/analytics) checkpoints to disk every N
 * campaigns so a network drop doesn't lose progress.
 *
 * Uses INSTANTLY_EXPORT_API_KEY. NB: лимит Instantly — workspace-wide ПОВЕРХ
 * ключей (отдельный ключ НЕ даёт отдельного бюджета — см. инцидент 22.05.2026 в
 * wiki/log.md, где этот скрипт задушил qualifier на другом ключе). Поэтому при
 * INSTANTLY_RATE_LIMITER_ENABLED=1 скрипт берёт общий токен через тот же
 * Postgres-бакет ('main'), что и portal/qualifier (см. acquireSharedToken ниже).
 *
 * Usage:
 *   cd app
 *   node scripts/instantly-dataset/pull.mjs [flags]
 *
 * Flags:
 *   --rpm=N                   global RPM cap (default 60; we measured single-key well above 18)
 *   --concurrency=N           parallel workers for per-campaign phases (default 4)
 *   --phase=NAME              run a single phase (campaigns|accounts|lead_lists|
 *                             email_templates|custom_tags|lead_labels|block_list|
 *                             webhooks|subsequences|warmup_analytics|overview|
 *                             daily|steps|leads|emails|all)  default: all
 *   --refresh-<phase>         ignore that phase's cache and re-pull
 *   --limit-campaigns=N       cap per-campaign phases (debug)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, statSync, readdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const CACHE_DIR = resolve(REPO_ROOT, '.tmp', 'instantly-cache');
mkdirSync(CACHE_DIR, { recursive: true });

// ─── env ─────────────────────────────────────────────────────────────────
const envText = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
const env = Object.fromEntries(
  envText.split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const KEY = env.INSTANTLY_EXPORT_API_KEY;
if (!KEY) { console.error('FATAL: INSTANTLY_EXPORT_API_KEY missing in .env'); process.exit(1); }

// ─── CLI ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name, def) {
  const a = args.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return def;
  if (a === `--${name}`) return true;
  return a.slice(name.length + 3);
}
const RPM         = Number(flag('rpm', 60));
const CONCURRENCY = Number(flag('concurrency', 4));
const LIMIT_CAMP  = flag('limit-campaigns') ? Number(flag('limit-campaigns')) : undefined;
const ONLY_PHASE  = flag('phase', 'all');

// ─── logger ─────────────────────────────────────────────────────────────
const LOG_FILE = join(CACHE_DIR, 'pull.log');
function log(...m) {
  const line = `[${new Date().toISOString()}] ${m.join(' ')}`;
  console.log(line);
  try { writeFileSync(LOG_FILE, line + '\n', { flag: 'a' }); } catch {}
}

// ─── global rate limiter — strict serial pacing ─────────────────────────
const MIN_INTERVAL_MS = Math.max(50, Math.round(60_000 / RPM));
let chain = Promise.resolve();
function rateLimit() {
  const next = chain.then(() => new Promise((r) => setTimeout(r, MIN_INTERVAL_MS)));
  chain = next.catch(() => undefined);
  return next;
}

// ─── shared workspace rate-limiter (общий Postgres token-bucket) ─────────
// pull.mjs делит workspace-лимит Instantly с qualifier/portal/outreach (лимит
// общий ПОВЕРХ ключей). При INSTANTLY_RATE_LIMITER_ENABLED=1 берём общий токен
// через RPC основной БД (PostgREST), уступая latency-sensitive потребителям.
// Batch-скрипт нечувствителен к задержке → ждём долго (а не пропускаем). Любая
// проблема лимитера → fail-open (идём как раньше, со своим rateLimit()).
const RL_URL     = (env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const RL_KEY     = env.SUPABASE_SERVICE_ROLE_KEY || '';
const RL_MAX_WAIT_MS = Number(env.INSTANTLY_PULL_RL_MAX_WAIT_MS || 300_000);
const RL_ON      = env.INSTANTLY_RATE_LIMITER_ENABLED === '1' && !!RL_URL && !!RL_KEY;

async function acquireSharedToken() {
  if (!RL_ON) return;
  const deadline = Date.now() + RL_MAX_WAIT_MS;
  for (;;) {
    let wait;
    try {
      const r = await fetch(`${RL_URL}/rest/v1/rpc/instantly_acquire_token`, {
        method: 'POST',
        headers: { apikey: RL_KEY, Authorization: `Bearer ${RL_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_account: 'main' }),
        signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) return;                      // RPC не накатан / ошибка → fail-open
      wait = Number(await r.json());
    } catch { return; }                       // таймаут/сеть → fail-open
    if (!Number.isFinite(wait) || wait <= 0) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) { log('  ~ shared rate-limiter: max wait reached, proceeding'); return; }
    await new Promise((res) => setTimeout(res, Math.min(remaining, Math.max(250, wait * 1000))));
  }
}

// ─── HTTP w/ retry on 429/5xx ───────────────────────────────────────────
async function call(path, opts = {}) {
  const url = new URL('https://api.instantly.ai/api/v2' + path);
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const init = { method: opts.method ?? 'GET', headers: { Authorization: `Bearer ${KEY}` } };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    await rateLimit();
    await acquireSharedToken();
    try {
      const r = await fetch(url.toString(), init);
      if (r.status === 429) {
        const wait = 15_000 + 5_000 * attempt;
        log(`  ! 429 on ${path} — sleeping ${wait}ms (attempt ${attempt + 1})`);
        await new Promise((res) => setTimeout(res, wait));
        continue;
      }
      if (r.status >= 500) {
        const wait = 3_000 * Math.pow(2, attempt);
        log(`  ! ${r.status} on ${path} — sleeping ${wait}ms (attempt ${attempt + 1})`);
        await new Promise((res) => setTimeout(res, wait));
        continue;
      }
      if (!r.ok) {
        const t = (await r.text()).slice(0, 200);
        // 4xx (other than 429) is a client error — don't retry, fail fast.
        const e = new Error(`HTTP ${r.status}: ${t}`);
        e.status = r.status;
        e.noRetry = r.status >= 400 && r.status < 500;
        throw e;
      }
      if (r.status === 204) return null;
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (e.noRetry) throw e;
      log(`  ! ${path} failed (${attempt + 1}/5): ${e.message}`);
      await new Promise((res) => setTimeout(res, 3000 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error(`Gave up on ${path}`);
}

async function paginateGet(path, params = {}, label) {
  const all = [];
  let after;
  let page = 0;
  do {
    const res = await call(path, { params: { limit: 100, ...params, starting_after: after } });
    if (res?.items?.length) all.push(...res.items);
    after = res?.next_starting_after || undefined;
    page++;
    if (page % 20 === 0) log(`  ${label}: page ${page}, total so far ${all.length}`);
  } while (after);
  return all;
}

async function paginatePost(path, body, label) {
  const all = [];
  let after;
  let page = 0;
  do {
    const res = await call(path, { method: 'POST', body: { limit: 100, ...body, starting_after: after } });
    if (res?.items?.length) all.push(...res.items);
    after = res?.next_starting_after || undefined;
    page++;
    if (page % 20 === 0) log(`  ${label}: page ${page}, total so far ${all.length}`);
  } while (after);
  return all;
}

// ─── concurrent worker pool that respects the global rate limiter ───────
async function runConcurrent(items, worker, concurrency, onProgress) {
  const results = new Array(items.length);
  let next = 0, done = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        try {
          results[i] = await worker(items[i], i);
        } catch (e) {
          log(`  ! worker error idx ${i} for ${items[i]?.id ?? items[i]}: ${e.message}`);
          results[i] = null;
        }
        done++;
        onProgress?.(done, items.length, results[i]);
      }
    }),
  );
  return results;
}

// ─── cache helpers ───────────────────────────────────────────────────────
function cachePath(name) { return join(CACHE_DIR, name); }
function readCache(name) {
  const p = cachePath(name);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}
function writeCache(name, data) {
  writeFileSync(cachePath(name), JSON.stringify(data));
}
function archiveCache(name) {
  const p = cachePath(name);
  if (!existsSync(p)) return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = p.replace(/\.json$/, `.${ts}.json`);
  renameSync(p, dest);
  log(`  archived old cache → ${dest}`);
}
function refreshFlag(phase) {
  return args.includes(`--refresh-${phase}`);
}
function should(phase) {
  return ONLY_PHASE === 'all' || ONLY_PHASE === phase;
}

// ============================================================================
//  Simple list phases (one paginated call each)
// ============================================================================

async function phaseCampaigns() {
  if (!should('campaigns')) return readCache('campaigns.json') ?? [];
  if (existsSync(cachePath('campaigns.json')) && !refreshFlag('campaigns')) {
    const c = readCache('campaigns.json');
    log(`✓ campaigns (cached): ${c.length}`);
    return c;
  }
  if (refreshFlag('campaigns')) archiveCache('campaigns.json');
  log('→ pulling /campaigns');
  const all = await paginateGet('/campaigns', {}, 'campaigns');
  writeCache('campaigns.json', all);
  log(`✓ campaigns: ${all.length}`);
  return all;
}

async function simpleListPhase(phaseName, cacheFile, method, path, body) {
  if (!should(phaseName)) return;
  if (existsSync(cachePath(cacheFile)) && !refreshFlag(phaseName)) {
    const c = readCache(cacheFile);
    log(`✓ ${phaseName} (cached): ${c.length}`);
    return c;
  }
  if (refreshFlag(phaseName)) archiveCache(cacheFile);
  log(`→ pulling ${path}`);
  const all = method === 'POST' ? await paginatePost(path, body ?? {}, phaseName)
                                : await paginateGet(path, {}, phaseName);
  writeCache(cacheFile, all);
  log(`✓ ${phaseName}: ${all.length}`);
  return all;
}

async function phaseAccounts()        { return simpleListPhase('accounts',         'accounts.json',         'GET',  '/accounts'); }
async function phaseLeadLists()       { return simpleListPhase('lead_lists',       'lead-lists.json',       'GET',  '/lead-lists'); }
async function phaseEmailTemplates()  { return simpleListPhase('email_templates',  'email-templates.json',  'GET',  '/email-templates'); }
async function phaseCustomTags()      { return simpleListPhase('custom_tags',      'custom-tags.json',      'GET',  '/custom-tags'); }
async function phaseLeadLabels()      { return simpleListPhase('lead_labels',      'lead-labels.json',      'GET',  '/lead-labels'); }
async function phaseBlockList()       { return simpleListPhase('block_list',       'block-list.json',       'GET',  '/block-lists-entries'); }
async function phaseWebhooks()        { return simpleListPhase('webhooks',         'webhooks.json',         'GET',  '/webhooks'); }

// /subsequences requires ?parent_campaign=<id> — per-campaign endpoint.
async function phaseSubsequences(campaigns) {
  return perCampaignMapPhase('subsequences', 'subsequences-by-campaign.json', campaigns,
    async (c) => paginateGet('/subsequences', { parent_campaign: c.id }, `subs ${c.id.slice(0, 8)}`));
}

async function phaseCustomTagMappings() {
  if (!should('custom_tags')) return;
  if (existsSync(cachePath('custom-tag-mappings.json')) && !refreshFlag('custom_tags')) {
    const c = readCache('custom-tag-mappings.json');
    log(`✓ custom_tag_mappings (cached): ${c.length}`);
    return c;
  }
  log('→ pulling /custom-tag-mappings');
  const all = await paginateGet('/custom-tag-mappings', {}, 'custom_tag_mappings');
  writeCache('custom-tag-mappings.json', all);
  log(`✓ custom_tag_mappings: ${all.length}`);
}

// ============================================================================
//  Warmup analytics — POST /accounts/warmup-analytics with all emails at once
// ============================================================================

async function phaseWarmupAnalytics(accountsArg) {
  if (!should('warmup_analytics')) return;
  if (existsSync(cachePath('warmup-analytics.json')) && !refreshFlag('warmup_analytics')) {
    log('✓ warmup_analytics (cached)');
    return;
  }
  // When isolated via --phase=warmup_analytics, the upstream phaseAccounts() call
  // returned undefined (because !should('accounts')). Fall back to the cached
  // accounts file so this phase still works standalone.
  const accounts = (accountsArg && accountsArg.length) ? accountsArg : (readCache('accounts.json') ?? []);
  if (!accounts.length) {
    log('  no accounts found (run --phase=accounts first) → skip warmup_analytics');
    return;
  }
  // Last 365 days for one-time historical dump
  const today = new Date().toISOString().slice(0, 10);
  const yearAgo = new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);
  const emails = accounts.map((a) => a.email).filter(Boolean);
  // chunk to avoid huge body
  const CHUNK = 50;
  const out = [];
  for (let i = 0; i < emails.length; i += CHUNK) {
    const slice = emails.slice(i, i + CHUNK);
    log(`  → /accounts/warmup-analytics for emails ${i + 1}-${i + slice.length}/${emails.length}`);
    try {
      const res = await call('/accounts/warmup-analytics', {
        method: 'POST',
        body: { emails: slice, start_date: yearAgo, end_date: today },
      });
      if (Array.isArray(res)) out.push(...res);
      else if (Array.isArray(res?.items)) out.push(...res.items);
      else if (res && typeof res === 'object') out.push(res);
    } catch (e) {
      log(`  ! warmup chunk ${i}: ${e.message}`);
    }
  }
  writeCache('warmup-analytics.json', out);
  log(`✓ warmup_analytics: ${out.length} entries`);
}

// ============================================================================
//  Per-campaign phases — checkpoint after every campaign
// ============================================================================

/**
 * Per-campaign DIRECTORY phase. Writes one file per campaign in
 * .tmp/instantly-cache/<dirName>/<campaignId>.json. Use for phases whose
 * combined output could exceed V8's ~500MB string-size limit (emails!).
 */
async function perCampaignDirPhase(phaseName, dirName, campaigns, fetcher) {
  if (!should(phaseName)) return;
  const dir = cachePath(dirName);
  mkdirSync(dir, { recursive: true });
  const refresh = refreshFlag(phaseName);
  const existing = new Set();
  if (!refresh) {
    try {
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.json')) existing.add(f.slice(0, -5));
      }
    } catch { /* empty */ }
  }
  const todo = campaigns.filter((c) => !existing.has(c.id));
  log(`→ ${phaseName} (dir): cached ${existing.size}, to pull ${todo.length}`);
  if (todo.length === 0) { log(`✓ ${phaseName}: all cached`); return; }

  const tStart = Date.now();
  let lastLog = Date.now();
  await runConcurrent(
    todo,
    async (c) => {
      try {
        const data = await fetcher(c);
        writeFileSync(join(dir, `${c.id}.json`), JSON.stringify(data));
      } catch (e) {
        writeFileSync(join(dir, `${c.id}.json`), JSON.stringify({ __error: e.message }));
      }
      return null;
    },
    CONCURRENCY,
    (done, total) => {
      if (done % 25 === 0 || done === total || Date.now() - lastLog > 30_000) {
        lastLog = Date.now();
        const elapsed = (Date.now() - tStart) / 1000;
        const rate = done / elapsed;
        const eta = (total - done) / rate / 60;
        log(`  ${phaseName} progress: ${done}/${total} (${(done / total * 100).toFixed(1)}%) | ${rate.toFixed(2)}/s | ETA ${eta.toFixed(1)} min`);
      }
    },
  );
  log(`✓ ${phaseName}: ${existing.size + todo.length} total on disk`);
}

async function perCampaignMapPhase(phaseName, cacheFile, campaigns, fetcher, opts = {}) {
  if (!should(phaseName)) return;
  const map = readCache(cacheFile) ?? {};
  const existingKeys = new Set(Object.keys(map));
  const refresh = refreshFlag(phaseName);
  if (refresh) {
    archiveCache(cacheFile);
    for (const k of [...existingKeys]) delete map[k];
    existingKeys.clear();
  }
  const todo = campaigns.filter((c) => !existingKeys.has(c.id));
  log(`→ ${phaseName}: cached ${existingKeys.size}, to pull ${todo.length}`);
  if (todo.length === 0) { log(`✓ ${phaseName}: all cached`); return; }

  let lastSave = Date.now();
  const tStart = Date.now();
  await runConcurrent(
    todo,
    async (c) => {
      try {
        const v = await fetcher(c);
        map[c.id] = v;
      } catch (e) {
        map[c.id] = { __error: e.message };
      }
      return null;
    },
    CONCURRENCY,
    (done, total) => {
      if (done % 25 === 0 || done === total || Date.now() - lastSave > 30_000) {
        writeCache(cacheFile, map);
        lastSave = Date.now();
        const elapsed = (Date.now() - tStart) / 1000;
        const rate = done / elapsed;
        const eta = (total - done) / rate / 60;
        log(`  ${phaseName} progress: ${done}/${total} (${(done / total * 100).toFixed(1)}%) | ${rate.toFixed(2)}/s | ETA ${eta.toFixed(1)} min`);
      }
    },
  );
  writeCache(cacheFile, map);
  log(`✓ ${phaseName}: ${Object.keys(map).length} total`);
}

async function phaseOverviewAnalytics(campaigns) {
  return perCampaignMapPhase('overview', 'analytics-overview-by-campaign.json', campaigns,
    (c) => call('/campaigns/analytics/overview', { params: { id: c.id } }));
}

async function phaseDailyAnalytics(campaigns) {
  return perCampaignMapPhase('daily', 'analytics-daily-by-campaign.json', campaigns,
    (c) => call('/campaigns/analytics/daily', { params: { campaign_id: c.id } })); // campaign_id, NOT id (id → workspace-wide). Fixed 2026-05-30.
}

async function phaseStepAnalytics(campaigns) {
  return perCampaignMapPhase('steps', 'analytics-steps-by-campaign.json', campaigns,
    (c) => call('/campaigns/analytics/steps', { params: { campaign_id: c.id } }));
}

// Per-campaign DIR (one file per campaign) — emails+leads can exceed V8 string
// limits if stored as one big map. emails crashed at ~646 MB; leads at 158 MB
// would have, too, with a year of further growth. Stay safe.
async function phaseLeads(campaigns) {
  return perCampaignDirPhase('leads', 'leads', campaigns,
    async (c) => paginatePost('/leads/list', { campaign: c.id }, `leads ${c.id.slice(0, 8)}`));
}

async function phaseEmails(campaigns) {
  return perCampaignDirPhase('emails', 'emails', campaigns,
    async (c) => paginateGet('/emails', { campaign_id: c.id }, `emails ${c.id.slice(0, 8)}`));
}

// ============================================================================
//  Main
// ============================================================================

(async () => {
  const tStart = Date.now();
  log(`Starting pull. rpm=${RPM} concurrency=${CONCURRENCY} phase=${ONLY_PHASE}`);

  // 0. campaigns (everything else depends on the campaign list)
  const campaigns = await phaseCampaigns();
  const campaignsForPerCamp = LIMIT_CAMP ? campaigns.slice(0, LIMIT_CAMP) : campaigns;

  // 1. light list phases (run sequentially; they're tiny)
  const accounts = await phaseAccounts();
  await phaseLeadLists();
  await phaseEmailTemplates();
  await phaseCustomTags();
  await phaseCustomTagMappings();
  await phaseLeadLabels();
  await phaseBlockList();
  await phaseWebhooks();
  await phaseSubsequences(campaignsForPerCamp);

  // 2. warmup analytics (depends on accounts list)
  await phaseWarmupAnalytics(accounts);

  // 3. per-campaign analytics (3 endpoints)
  await phaseOverviewAnalytics(campaignsForPerCamp);
  await phaseStepAnalytics(campaignsForPerCamp);
  await phaseDailyAnalytics(campaignsForPerCamp);

  // 4. per-campaign heavy phases
  await phaseLeads(campaignsForPerCamp);
  await phaseEmails(campaignsForPerCamp);

  const mins = ((Date.now() - tStart) / 60_000).toFixed(1);
  log(`DONE in ${mins} min.`);
})().catch((e) => {
  log(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
