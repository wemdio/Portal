/** GET-only export. See docs/ve2-cost-measurement.md. */
import { readFile, writeFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import { buildVeCostReport, type VeCostJob, type VeCostLog } from '../src/lib/verticalEngineV2/costReport';

async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(['project', 'base', 'mode', 'env-file', 'out', 'serper-usd-per-1000']);
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !allowed.has(key) || !args[i + 1] || options[key] !== undefined) throw new Error('Invalid arguments; see docs/ve2-cost-measurement.md.');
    options[key] = args[i + 1];
  }
  const projectId = options.project;
  const baseId = options.base;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!uuid.test(projectId ?? '') || (baseId !== undefined && !uuid.test(baseId))) throw new Error('Invalid project or base UUID.');
  const mode = options.mode ?? (baseId ? 'collection' : 'all');
  if (mode !== 'collection' && mode !== 'research' && mode !== 'all') throw new Error('Invalid mode.');
  const tariff = options['serper-usd-per-1000'] === undefined ? undefined : Number(options['serper-usd-per-1000']);
  if (tariff !== undefined && (!Number.isFinite(tariff) || tariff < 0)) throw new Error('Invalid Serper tariff.');
  const env = options['env-file'] ? parse(await readFile(options['env-file'])) : {};
  const key = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is missing.');

  // Never use stale env hosts or mutating application GET routes.
  const read = async (table: 've_jobs' | 've_bases' | 'application_logs', params: Record<string, string>) => {
    const url = new URL(`https://polza-portal.ru/rest/v1/${table}`);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    const response = await fetch(url, { method: 'GET', redirect: 'error',
      headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Portal accounting GET failed: ${table}, HTTP ${response.status}.`);
    const rows: unknown = await response.json();
    if (!Array.isArray(rows)) throw new Error('Invalid accounting response shape.');
    const totalText = response.headers.get('content-range')?.split('/')[1];
    const total = totalText !== undefined && /^\d+$/.test(totalText) ? Number(totalText) : null;
    return { rows: rows as Record<string, unknown>[], total };
  };
  const pages = async (table: 've_jobs' | 'application_logs', params: Record<string, string>) => {
    const rows: Record<string, unknown>[] = [];
    let expectedTotal: number | null = null;
    for (let page = 0; page < 100; page++) {
      const batch = await read(table, { ...params, order: 'created_at.asc,id.asc', limit: '1000', offset: String(rows.length) });
      rows.push(...batch.rows);
      if (batch.total === null || (expectedTotal !== null && expectedTotal !== batch.total)) return { rows, truncated: true };
      expectedTotal = batch.total;
      if (rows.length === expectedTotal) return { rows, truncated: false };
      if (!batch.rows.length || rows.length > expectedTotal) return { rows, truncated: true };
    }
    return { rows, truncated: true };
  };
  const cutoff = new Date().toISOString();
  const [journal, jobPage, bases] = await Promise.all([
    pages('application_logs', { select: 'id,created_at,event,context', source: 'eq.ve_provider_usage',
      request_id: `eq.${projectId}`, created_at: `lte.${cutoff}`, ...(baseId ? { 'context->>baseId': `eq.${baseId}` } : {}) }),
    pages('ve_jobs', { select: 'id,project_id,base_id:payload->>base_id,origin_run_id:payload->provider_usage_origin->>runId,stage,status,started_at,created_at,updated_at',
      project_id: `eq.${projectId}`, created_at: `lte.${cutoff}`, ...(baseId ? { 'payload->>base_id': `eq.${baseId}` } : {}) }),
    baseId ? read('ve_bases', { select: 'id,project_id,status,row_count,created_at,updated_at,ready_rows:collect_info->target_progress->>ready_rows,launchable_rows:collect_info->stats->>launchable_rows,target_status:collect_info->target_progress->>status,collection_mode:collect_info->>collection_mode,ready_target:collect_info->>ready_target',
      id: `eq.${baseId}`, project_id: `eq.${projectId}`, limit: '1' }).then((result) => result.rows) : Promise.resolve([]),
  ]);
  if (baseId && bases.length !== 1) throw new Error('Invalid base: not found in the requested project.');
  const base = bases[0];
  const count = (value: unknown) => value !== null && value !== undefined && value !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  const readyProgress = count(base?.ready_rows);
  const readyStats = count(base?.launchable_rows);
  const readyCountConflict = readyProgress !== null && readyStats !== null && readyProgress !== readyStats;
  const advanced = (value: unknown) => typeof value === 'string' && Date.parse(value) > Date.parse(cutoff);
  const snapshotAdvanced = advanced(base?.updated_at) || jobPage.rows.some((job) => advanced(job.updated_at));
  const report = buildVeCostReport({ projectId, baseId, mode,
    logs: journal.rows as unknown as VeCostLog[], jobs: jobPage.rows as unknown as VeCostJob[],
    readyCount: readyCountConflict ? null : readyProgress ?? readyStats,
    logsTruncated: journal.truncated || jobPage.truncated, serperUsdPer1000: tariff, snapshotAdvanced });
  const output = JSON.stringify({ capturedAt: cutoff, readOnly: true, productionWrites: 0, paidProviderCalls: 0,
    snapshotIsTransactional: false, base: base ?? null, readyCountConflict,
    note: 'Journal through capturedAt; live base/job state may advance during export. Earlier or expired costs remain unknown.', ...report }, null, 2);
  if (options.out) await writeFile(options.out, `${output}\n`, { encoding: 'utf8', mode: 0o600 });
  else process.stdout.write(`${output}\n`);
}

main().catch((error: unknown) => {
  // Never print fetch causes, request headers or environment values.
  process.stderr.write(`${error instanceof Error && /^(Invalid |SUPABASE_|Portal accounting GET)/.test(error.message) ? error.message : 'Read-only accounting export failed.'}\n`);
  process.exitCode = 1;
});
