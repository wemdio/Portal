/** Exact-manifest queue administration. Defaults to read-only status.
 * Read docs/ssh-access.md first. Never deploys, migrates, deletes or calls AI.
 * Production apply requires the deployed archive guard and explicit flags.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SSH = ['-i', '/Users/cybermart/.ssh/portal_hostkey_mac_ed25519',
  '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
  '-o', 'StrictHostKeyChecking=yes', 'root@139.60.162.24'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ELIGIBLE = ['pending', 'needs_review', 'error'];

function remote(command, input = '') {
  const result = spawnSync('ssh', [...SSH, command], {
    input, encoding: 'utf8', timeout: 35_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    // Do not echo SQL/body/credentials from arbitrary remote error output.
    throw new Error(`SSH diagnostic failed (${result.error?.code ?? result.status}); no success assumed`);
  }
  return result.stdout;
}

function sql(query, { main = false, write = false } = {}) {
  const target = main ? 'main-postgres psql -X -U postgres -d postgres'
    : 'instantly-postgres-prod psql -X -U instantly -d instantly';
  const text = remote(`docker exec -i ${target} -v ON_ERROR_STOP=1 -qAt`,
    `${write ? 'BEGIN' : 'BEGIN READ ONLY'}; SET LOCAL statement_timeout='20s'; SET LOCAL lock_timeout='3s';\n${query}\n${write ? 'COMMIT' : 'ROLLBACK'};`);
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function literal(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function idArray(ids) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 5000 ||
    ids.some(id => typeof id !== 'string' || !UUID.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error('Expected 1–5000 unique qualification UUIDs');
  }
  return `ARRAY[${ids.map(id => `${literal(id)}::uuid`).join(',')}]::uuid[]`;
}
export function manifestDigest(ids) { return createHash('sha256').update([...ids].sort().join('\n')).digest('hex'); }
export function validateManifest(manifest) {
  if (!manifest || manifest.version !== 1 || !UUID.test(manifest.batch_id ?? '') ||
    !Array.isArray(manifest.rows) || !Number.isFinite(Date.parse(manifest.cutoff ?? '')) ||
    typeof manifest.reason !== 'string' || manifest.reason.trim().length < 10 || manifest.reason.length > 500) {
    throw new Error('Invalid archive manifest');
  }
  const ids = manifest.rows.map(row => row.id);
  idArray(ids);
  if (manifest.sha256 !== manifestDigest(ids) || manifest.rows.some(row =>
    !ELIGIBLE.includes(row.status) || !Number.isFinite(Date.parse(row.created_at)) ||
    Date.parse(row.created_at) > Date.parse(manifest.cutoff))) throw new Error('Manifest scope/digest mismatch');
  return ids;
}

function specialistDeliveries(ids) {
  if (!ids.length) return [];
  return sql(`SELECT jsonb_build_object('id',entity_id,'sent',tg_sent,'message_id',tg_message_id)
    FROM deadline_notification_log WHERE entity_type='lead_qualification' AND level='specialist'
    AND entity_id::text = ANY(${idArray(ids)}::text[])
    AND (tg_sent IS TRUE OR tg_message_id IS NOT NULL OR tg_sent IS NULL);`, { main: true });
}

function runtime({ full = false } = {}) {
  const program = 'const fs=require("fs");const p="/app/workers/instantlyLeads.js";const s=fs.readFileSync(p,"utf8");console.log(JSON.stringify({archiveGuard:s.includes("queue_archived_at"),payloadFix:s.includes("_portal_reply_intake_gzip_v1")}));';
  const result = JSON.parse(remote('docker exec -i portal-worker-instantly-leads node', program));
  if (!full) return result;
  // Apply-only bounded scan of the deployed Next server bundles, not source
  // files in a checkout. Unknown layout or an incomplete rollout fails closed.
  const appProbe = `
    const fs=require('fs'),path=require('path');
    const root='/app/.next/server', found=new Set();let files=0,bytes=0;
    const markers=['queue_archive_batch_id','Ответ снят с обработки и сохранён в архиве; действия недоступны','Ответ снят с обработки и сохранён в архиве; передача недоступна'];
    function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
      if(e.isSymbolicLink())continue;const p=path.join(dir,e.name);
      if(e.isDirectory())walk(p);else if(e.isFile()&&e.name.endsWith('.js')){
        bytes+=fs.statSync(p).size;if(++files>6000||bytes>256*1024*1024)throw Error('bundle scan limit');
        const s=fs.readFileSync(p,'utf8');for(const m of markers)if(s.includes(m))found.add(m);
      }
    }}walk(root);console.log(JSON.stringify({archiveGuard:markers.every(m=>found.has(m))}));`;
  result.app = JSON.parse(remote('docker exec -i portal node', appProbe));
  const running = remote("docker ps --format '{{.Names}}'").trim().split('\n');
  result.monolith = { running: running.includes('portal-worker'), archiveGuard: null };
  if (result.monolith.running) {
    const probe = 'const s=require("fs").readFileSync("/app/workers/index.js","utf8");console.log(JSON.stringify({archiveGuard:s.includes("queue_archived_at")}));';
    result.monolith.archiveGuard = JSON.parse(remote('docker exec -i portal-worker node', probe)).archiveGuard;
  }
  return result;
}

function archiveSchema() {
  return sql(`SELECT jsonb_build_object('archive_schema', EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='instantly_lead_qualifications' AND column_name='queue_archived_at'));`)[0];
}

function status() {
  const schema = archiveSchema();
  const archiveField = schema.archive_schema ? 'queue_archived_at' : 'NULL::timestamptz';
  const metrics = sql(`
    SELECT jsonb_build_object('kind','qualification','at',now(),'status',status,'archived',archived,
      'count',count(*),'oldest_created',min(created_at),'oldest_reply',min(reply_timestamp),
      'over_2h',count(*) FILTER(WHERE created_at < now()-interval '2 hours'))
    FROM (SELECT status,created_at,reply_timestamp,(${archiveField} IS NOT NULL) AS archived
      FROM instantly_lead_qualifications WHERE status IN ('pending','processing','needs_review','error')) q GROUP BY status,archived;
    SELECT jsonb_build_object('kind','intake','account',account_id,'state',state,'count',count(*),'oldest_created',min(created_at),'oldest_source',min(reply_timestamp)) FROM instantly_reply_intake GROUP BY account_id,state;
    SELECT jsonb_build_object('kind','discovery','account',account_id,'updated_at',updated_at,'last_completed_at',last_completed_at,'last_failure_at',last_failure_at,'sweep_since',sweep_since,'pages_staged',pages_staged,'cursor',sweep_cursor) FROM instantly_reply_discovery;
  `);
  const delivery = sql(`SELECT jsonb_build_object('kind','telegram_30m','sent',tg_sent,'count',count(*))
    FROM deadline_notification_log WHERE entity_type='lead_qualification' AND level='specialist'
    AND coalesce(tg_sent_at,created_at)>now()-interval '30 minutes' GROUP BY tg_sent;`, { main: true });
  return { captured_at: new Date().toISOString(), schema, runtime: runtime(), metrics, delivery };
}

function snapshot(options) {
  if (!options.cutoff || !options.out || !Number.isFinite(Date.parse(options.cutoff))) throw new Error('Snapshot requires --cutoff ISO and --out path');
  const cutoff = new Date(options.cutoff).toISOString();
  const schema = archiveSchema();
  const rows = sql(`SELECT jsonb_build_object('id',id,'status',status,'created_at',created_at,'updated_at',updated_at)
    FROM instantly_lead_qualifications WHERE status IN ('pending','needs_review','error')
    ${schema.archive_schema ? 'AND queue_archived_at IS NULL' : ''}
    AND created_at <= ${literal(cutoff)}::timestamptz ORDER BY id LIMIT 5001;`);
  if (!rows.length || rows.length > 5000) throw new Error('Snapshot is empty or exceeds 5000; no manifest written');
  const delivered = new Set(specialistDeliveries(rows.map(row => row.id)).map(row => row.id));
  const candidates = rows.filter(row => !delivered.has(row.id));
  const manifest = { version: 1, batch_id: randomUUID(), cutoff, captured_at: new Date().toISOString(),
    reason: 'User approved administrative retirement of the pre-cutoff qualification backlog; not a lead verdict.',
    rows: candidates, excluded_delivered_ids: [...delivered], sha256: manifestDigest(candidates.map(row => row.id)) };
  validateManifest(manifest);
  writeFileSync(options.out, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { manifest: options.out, batch_id: manifest.batch_id, candidates: candidates.length,
    excluded_delivered: delivered.size, cutoff, mutation: false };
}

function apply(options) {
  if (!options.manifest) throw new Error('Apply requires --manifest path');
  // Do not mix an irreversible remote result with a later local wx failure.
  // Apply prints its receipt to stdout; the immutable batch is also in the DB.
  if (options.out) throw new Error('--out is not supported with apply; no archive applied');
  const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'));
  const ids = validateManifest(manifest);
  if (options['confirm-batch-id'] !== manifest.batch_id || Number(options['expect-count']) !== ids.length ||
    options['confirm-deployed'] !== true || options['confirm-archive'] !== true) {
    throw new Error('Apply requires matching --confirm-batch-id, --expect-count, --confirm-deployed and --confirm-archive');
  }
  const deployed = runtime({ full: true });
  if (!archiveSchema().archive_schema || !deployed.archiveGuard || !deployed.payloadFix ||
    !deployed.app.archiveGuard || (deployed.monolith.running && !deployed.monolith.archiveGuard)) {
    throw new Error('Archive migration/app/worker rollout is incomplete; no archive applied');
  }
  const deliveries = specialistDeliveries(ids);
  if (deliveries.length) throw new Error(`${deliveries.length} manifest rows acquired a specialist delivery; review the manifest before applying`);
  let result;
  try {
    const responses = sql(`SELECT public.archive_instantly_qualification_queue(${literal(manifest.batch_id)}::uuid,
      ${idArray(ids)},${literal(manifest.reason)});`, { write: true });
    [result] = responses;
    if (responses.length !== 1 || result?.batch_id !== manifest.batch_id.toLowerCase() ||
      result.requested !== ids.length || !Number.isInteger(result.archived) || result.archived < 0 ||
      !Number.isInteger(result.skipped) || result.skipped < 0 || result.archived + result.skipped !== ids.length) {
      throw new Error('Invalid archive receipt');
    }
  } catch {
    throw new Error(`Archive batch ${manifest.batch_id}: transaction outcome unconfirmed. Inspect the batch ledger; retry only this exact manifest/batch, never create a new batch to retry.`);
  }
  // A replayed RPC result describes the original operation, possibly followed
  // by an explicit restore. Never advertise its historical count as live state.
  let current;
  try {
    const responses = sql(`SELECT jsonb_build_object('archived_now',count(*) FILTER(WHERE queue_archived_at IS NOT NULL),
      'active_now',count(*) FILTER(WHERE queue_archived_at IS NULL AND status IN ('pending','processing','needs_review','error')),
      'terminal_now',count(*) FILTER(WHERE queue_archived_at IS NULL AND status NOT IN ('pending','processing','needs_review','error')),
      'missing_now',${ids.length}-count(*))
      FROM instantly_lead_qualifications WHERE id=ANY(${idArray(ids)});`);
    [current] = responses;
    const counts = ['archived_now', 'active_now', 'terminal_now', 'missing_now'].map(key => current?.[key]);
    if (responses.length !== 1 || counts.some(value => !Number.isInteger(value) || value < 0) ||
      counts.reduce((sum, value) => sum + value, 0) !== ids.length) throw new Error('Invalid current queue state');
  } catch {
    throw new Error(`Archive RPC committed for batch ${manifest.batch_id}, but the live-state recheck failed. Do not assume nothing changed; inspect this batch before further action.`);
  }
  return { operation: result, current_manifest_state: current, mutation: true };
}

export function parseOptions(args) {
  const options = {};
  const allowed = new Set(['mode','out','cutoff','manifest','confirm-batch-id','expect-count','confirm-deployed','confirm-archive']);
  for (let index = 0; index < args.length; index++) {
    const name = args[index].replace(/^--/, '');
    if (!args[index].startsWith('--') || !allowed.has(name) || Object.hasOwn(options, name)) throw new Error('Unknown or repeated option');
    if (['confirm-deployed','confirm-archive'].includes(name)) options[name] = true;
    else {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for --${name}`);
      options[name] = args[++index];
    }
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const mode = options.mode ?? 'status';
    const result = mode === 'status' ? status() : mode === 'snapshot' ? snapshot(options) : mode === 'apply' ? apply(options) : (() => { throw new Error('Unknown mode'); })();
    if (options.out && mode !== 'snapshot') writeFileSync(options.out, JSON.stringify(result, null, 2) + '\n', {flag:'wx',mode:0o600});
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
