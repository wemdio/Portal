#!/usr/bin/env node
/**
 * Opt-in comparison using the CURRENT stepTAScore prompt, batching, retries,
 * parser, deduplication and row ordering. This never imports a worker or DB.
 *
 * Dry (no key/network): node scripts/base-constructor-ta-model-eval.mjs
 *   --fixtures /absolute/private/fixtures.json --out /absolute/private/new-run
 * Live: add --live --budget-usd 5 --max-calls 60; supply the existing Requesty
 * key only via TA_MODEL_EVAL_API_KEY. This script never loads an environment file.
 * Input: {schema_version:1,cases:[{id,brief,data:string[][]}]}.
 *
 * Both profiles use concurrency=2 and the production max_tokens=8000, JSON mode
 * and temperature=0.2. Only the candidate model/reasoning_effort are overridden.
 * The baseline uses the actual policy/gemini-flash route (not a guessed provider).
 * All fixtures, prompts and raw responses stay in a NEW private directory outside
 * Git. Stdout contains aggregates only. A dry result is never a model verdict.
 *
 * Client cost protection is not a provider hard billing cap: timeouts and policy
 * fallback attempts may be billed without a disclosed cost. Reserve at least $0.05
 * per unknown/failed/policy request, and use reported usage.cost when available.
 * Requesty's configured key budget is the only provider-side spending boundary.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const HARNESS = fileURLToPath(import.meta.url);
const APP = path.resolve(path.dirname(HARNESS), '..');
const REPO = path.dirname(APP);
const ENDPOINT = 'https://router.requesty.ai/v1/chat/completions';
const PROFILES = [
  { id: 'current-policy', model: 'policy/gemini-flash' },
  { id: 'gemini-3.8-flash-low', model: 'vertex/gemini-3.8-flash', reasoning_effort: 'low' },
];
const MAX_RUN_MS = 15 * 60_000;
const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const copy = (value) => JSON.parse(JSON.stringify(value));
const privateJson = async (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });

function parseArgs(argv) {
  const args = { live: false, maxCalls: 60, budgetUsd: 5, limitCases: 3 };
  const fields = { '--fixtures': 'fixtures', '--out': 'out', '--max-calls': 'maxCalls',
    '--budget-usd': 'budgetUsd', '--limit-cases': 'limitCases' };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--live') args.live = true;
    else if (flag === '--help') args.help = true;
    else if (fields[flag] && argv[index + 1] && !argv[index + 1].startsWith('--')) args[fields[flag]] = argv[++index];
    else throw new Error(`Unknown or incomplete option: ${flag}`);
  }
  if (args.help) return args;
  if (!args.fixtures || !args.out || !path.isAbsolute(args.fixtures) || !path.isAbsolute(args.out)) {
    throw new Error('--fixtures and --out must be explicit absolute paths; output must be NEW');
  }
  for (const field of ['maxCalls', 'limitCases']) {
    args[field] = Number(args[field]);
    if (!Number.isSafeInteger(args[field]) || args[field] < 1) throw new Error(`Invalid ${field}`);
  }
  args.budgetUsd = Number(args.budgetUsd);
  if (args.maxCalls > 60 || args.limitCases > 10 || !Number.isFinite(args.budgetUsd) || args.budgetUsd <= 0 || args.budgetUsd > 5) {
    throw new Error('Safety maximums: 60 calls, 10 cases, $5 client budget');
  }
  if (args.live && !process.env.TA_MODEL_EVAL_API_KEY) throw new Error('Missing TA_MODEL_EVAL_API_KEY');
  return args;
}

async function makeOutput(requested) {
  const out = path.join(await realpath(path.dirname(requested)), path.basename(requested));
  // Reject every worktree of this repository, including the parent checkout.
  try {
    execFileSync('git', ['-C', path.dirname(out), 'rev-parse', '--show-toplevel'], { stdio: 'ignore' });
    throw new Error('Output must be outside all Git worktrees');
  } catch (error) {
    if (error.message === 'Output must be outside all Git worktrees') throw error;
  }
  await mkdir(out, { mode: 0o700 }); // Existing directory/symlink is never reused.
  await chmod(out, 0o700);
  return out;
}

function validateFixtures(value, limit) {
  if (value?.schema_version !== 1 || !Array.isArray(value.cases) || !value.cases.length) throw new Error('Invalid fixture schema');
  const cases = value.cases.slice(0, limit);
  const ids = new Set();
  for (const entry of cases) {
    if (typeof entry.id !== 'string' || !/^[\w.-]{1,100}$/.test(entry.id) || ids.has(entry.id)) throw new Error('Case IDs must be unique safe identifiers');
    ids.add(entry.id);
    if (typeof entry.brief !== 'string' || !entry.brief.trim() || entry.brief.length > 100_000) throw new Error('Invalid brief');
    if (!Array.isArray(entry.data) || entry.data.length < 2 || entry.data.length > 201 ||
        !entry.data.every((row) => Array.isArray(row) && row.length <= 80 && row.every((cell) => typeof cell === 'string' && cell.length <= 20_000)) ||
        !entry.data[0].length) throw new Error('Expected 1-200 rows with string cells and a header');
    if (entry.data[0].some((cell) => /^(ца\s*балл|ta\s*score|ца\s*причина|ta\s*reason)$/i.test(cell.trim()))) {
      throw new Error('Remove previous TA score/reason columns before evaluation: production would resume them instead of calling AI');
    }
  }
  return cases;
}

async function buildScorer() {
  const source = path.join(APP, 'src/lib/tools/processingSteps.ts');
  const purePaths = new Map([
    ['./dfybUtils', 'src/lib/tools/dfybUtils.ts'],
    ['./checkpointGate', 'src/lib/tools/checkpointGate.ts'],
    ['./baseConstructorCheckpoint', 'src/lib/tools/baseConstructorCheckpoint.ts'],
    ['./supportEmails', 'src/lib/tools/supportEmails.ts'],
    ['@/lib/nameCleanupProtocol', 'src/lib/nameCleanupProtocol.ts'],
  ]);
  const blocked = 'throw new Error("EVALUATION_BLOCKED_NON_TA_DEPENDENCY");';
  const stubs = {
    '@/lib/enrich/emailScraper': `export function scrapeEmails(){${blocked}}`,
    '@/lib/enrich/websiteParser': `export function fetchAndExtract(){${blocked}}`,
    '@/lib/emailValidation/validator': `export function validateEmail(){${blocked}}`,
    './personalizationCompletion': `export function generatePersonalizationCompletion(){${blocked}} export function personalizationFailureMessage(){${blocked}} export function buildPersonalizationTable(){${blocked}} export class PersonalizationCancelledError extends Error {}`,
  };
  const files = new Map();
  const bundled = await build({ entryPoints: [source], bundle: true, write: false, platform: 'node',
    target: 'node22', format: 'cjs', logLevel: 'silent', plugins: [{ name: 'ta-eval-boundary', setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return { path: source };
        if (Object.hasOwn(stubs, args.path)) return { path: args.path, namespace: 'blocked' };
        if (purePaths.has(args.path)) return { path: path.join(APP, purePaths.get(args.path)) };
        throw new Error(`Unapproved TA dependency: ${args.path}`);
      });
      plugin.onLoad({ filter: /.*/, namespace: 'blocked' }, (args) => ({ contents: stubs[args.path], loader: 'js' }));
      plugin.onLoad({ filter: /\.ts$/ }, async (args) => {
        const contents = await readFile(args.path, 'utf8');
        files.set(path.relative(REPO, args.path), hash(contents));
        return { contents, loader: 'ts', resolveDir: path.dirname(args.path) };
      });
    } }] });
  return { code: bundled.outputFiles[0].text, sourceHashes: Object.fromEntries(files), bundleHash: hash(bundled.outputFiles[0].text) };
}

function scorerFrom(bundle, fetchHandler, deadlineAt) {
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports, Response, AbortController,
    process: { env: { OPENROUTER_BRIEF_API_KEY: 'evaluation-placeholder-not-a-secret', BASE_TA_SCORING_CONCURRENCY: '2' } },
    fetch: fetchHandler,
    setTimeout: (callback, ms, ...args) => setTimeout(callback, Math.max(0, Math.min(ms, deadlineAt - Date.now())), ...args),
    clearTimeout,
    // Production error logs can contain response snippets. Raw data is recorded
    // privately by the intercept; never pass these logs through to stdout.
    console: { log() {}, warn() {}, error() {}, info() {} },
  };
  runInNewContext(bundle.code, sandbox, { timeout: 5000, filename: 'isolated-ta-scorer.cjs' });
  if (typeof module.exports.stepTAScore !== 'function') throw new Error('Missing production stepTAScore export');
  return module.exports.stepTAScore;
}

function requestPayload(url, init) {
  if (String(url) !== ENDPOINT || init?.method !== 'POST' || typeof init.body !== 'string') throw new Error('Blocked non-TA request');
  const body = JSON.parse(init.body);
  if (body.model !== 'policy/gemini-flash' || body.temperature !== 0.2 || body.max_tokens !== 8000 ||
      body.response_format?.type !== 'json_object' || !Array.isArray(body.messages) || body.messages.length !== 2 ||
      !body.messages.every((message) => typeof message.content === 'string') ||
      Object.keys(body).some((key) => !['model', 'messages', 'temperature', 'max_tokens', 'response_format'].includes(key))) {
    throw new Error('Production TA payload changed; review this harness before calling the provider');
  }
  const marker = '\n\nКомпании:\n';
  const user = body.messages[1].content;
  const companies = JSON.parse(user.slice(user.lastIndexOf(marker) + marker.length));
  if (!Array.isArray(companies) || !companies.length || companies.length > 10 ||
      companies.some((company) => !Number.isSafeInteger(company.idx))) throw new Error('Unexpected production company batch');
  return { body, companies };
}

function usableCount(json, companies) {
  // The real parser remains authoritative. This deliberately conservative
  // circuit breaker is only for THREE wholly unusable responses in a row;
  // partial responses must be allowed to exercise production recovery.
  try {
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) return 0;
    let parsed;
    try { parsed = JSON.parse(content); }
    catch { parsed = JSON.parse(content.match(/\[[\s\S]*\]/)?.[0] ?? content); }
    const scores = Array.isArray(parsed) ? parsed : parsed?.scores;
    if (!Array.isArray(scores)) return 0;
    const expected = new Set(companies.map((company) => company.idx));
    return scores.filter((row) => expected.has(row?.idx) &&
      (typeof row.score === 'number' || (typeof row.score === 'string' && row.score.trim())) && Number.isFinite(Number(row.score))).length;
  } catch { return 0; }
}

function reportedCost(usage) {
  const value = usage?.cost;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node scripts/base-constructor-ta-model-eval.mjs --fixtures /private/fixtures.json --out /private/new-run [--live] [--limit-cases 3] [--max-calls 60] [--budget-usd 5]');
    return;
  }
  const fixtureText = await readFile(args.fixtures, 'utf8');
  if (Buffer.byteLength(fixtureText) > 5_000_000) throw new Error('Fixtures exceed 5 MB');
  const cases = validateFixtures(JSON.parse(fixtureText), args.limitCases);
  const out = await makeOutput(args.out);
  const bundle = await buildScorer();
  const startAt = Date.now();
  const deadlineAt = startAt + MAX_RUN_MS;
  const runController = new AbortController();
  let globalStop = null;
  const runTimer = setTimeout(() => { globalStop = 'run_time_limit'; runController.abort(); }, MAX_RUN_MS);
  const calls = [];
  const results = [];
  const profileStates = new Map(PROFILES.map((profile) => [profile.id, { failures: 0, stopReason: null }]));
  let reservedUsd = 0;
  const manifest = { schema_version: 1, dry_run: !args.live, created_at: new Date(startAt).toISOString(),
    source_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
    source_hashes: bundle.sourceHashes, bundle_hash: bundle.bundleHash, harness_hash: hash(await readFile(HARNESS, 'utf8')),
    fixtures_hash: hash(fixtureText), case_hashes: cases.map((entry) => ({ id: entry.id, sha256: hash(entry), rows: entry.data.length - 1 })),
    profiles: PROFILES, concurrency_per_profile: 2, max_calls: args.maxCalls, budget_usd: args.budgetUsd,
    max_run_ms: MAX_RUN_MS, billing_note: 'Client estimate only. usage.cost is provider-reported; unknown calls and policy fallbacks retain a reservation. Provider key budget is the only hard billing cap.' };
  await privateJson(path.join(out, 'manifest.json'), manifest);
  await privateJson(path.join(out, 'fixtures-private.json'), { schema_version: 1, cases });

  try {
    for (const entry of cases) {
      if (globalStop) break;
      // Fairer than running the entire baseline before the candidate: each case
      // starts both profiles together, each with two in-flight batches at most.
      const caseResults = await Promise.all(PROFILES.map(async (profile) => {
        const profileState = profileStates.get(profile.id);
        let profileStop = profileState.stopReason;
        let failures = profileState.failures;
        let telemetry = null;
        let stats = null;
        let progress = 0;
        let checkpoint = null;
        const profileStart = Date.now();
        const profileCalls = [];
        const fetchHandler = async (url, init) => {
          if (globalStop || profileStop || Date.now() >= deadlineAt) throw new Error('EVALUATION_STOPPED');
          const { body: productionBody, companies } = requestPayload(url, init);
          const payload = { ...productionBody, model: profile.model,
            ...(profile.reasoning_effort ? { reasoning_effort: profile.reasoning_effort } : {}) };
          // UTF-8 bytes conservatively upper-bound text tokens. $0.75/$3.75 are
          // candidate prices verified for this pilot, not a guessed policy rate.
          const reservation = args.live ? Math.max(0.05,
            Buffer.byteLength(JSON.stringify(payload)) * 0.75 / 1e6 + payload.max_tokens * 3.75 / 1e6) : 0;
          if (calls.length >= args.maxCalls || reservedUsd + reservation > args.budgetUsd) {
            globalStop = calls.length >= args.maxCalls ? 'call_limit' : 'client_budget_limit';
            throw new Error('EVALUATION_LIMIT_REACHED');
          }
          reservedUsd += reservation; // Synchronous reservation before any await.
          const record = { call_number: calls.length + 1, case_id: entry.id, profile: profile.id,
            requested_model: profile.model, started_at: new Date().toISOString(),
            company_count: companies.length, request_hash: hash(payload), production_request_hash: hash(productionBody),
            prompt_hash: hash(productionBody.messages), reservation_usd: reservation,
            status: null, duration_ms: null, finish_reason: null, model: null, usage: null, reported_cost_usd: null,
            usable_response_rows: 0, error: null };
          calls.push(record);
          profileCalls.push(record);
          const requestStart = Date.now();
          let text = '';
          let json = null;
          let response;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), Math.min(70_000, deadlineAt - Date.now()));
          try {
            if (args.live) {
              response = await globalThis.fetch(ENDPOINT, { method: 'POST', redirect: 'error',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TA_MODEL_EVAL_API_KEY}`,
                  'HTTP-Referer': 'https://portal.app', 'X-Title': 'Portal - Isolated TA model evaluation' },
                body: JSON.stringify(payload),
                signal: AbortSignal.any([controller.signal, runController.signal, ...(init.signal ? [init.signal] : [])]),
              });
              text = await response.text(); // Timeout stays active through body.
              if (Buffer.byteLength(text) > 4_000_000) throw new Error('RESPONSE_TOO_LARGE');
              try { json = JSON.parse(text); } catch { /* Preserve the raw body for the real parser. */ }
            } else {
              json = { model: `dry-run/${profile.id}`, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
                scores: companies.map((company) => ({ idx: company.idx, score: Number.parseInt(hash(company.data).slice(0, 6), 16) % 11,
                  reason: 'Синтетический dry-run: не оценка модели' })),
              }) } }], usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 } };
              text = JSON.stringify(json);
              response = new Response(text, { status: 200 });
            }
            record.status = response.status;
            record.model = typeof json?.model === 'string' ? json.model : null;
            record.finish_reason = json?.choices?.[0]?.finish_reason ?? null;
            record.usage = json?.usage ?? null;
            record.reported_cost_usd = reportedCost(json?.usage);
            record.usable_response_rows = response.ok ? usableCount(json, companies) : 0;
            failures = response.ok && record.usable_response_rows > 0 ? 0 : failures + 1;
            if (failures >= 3) profileStop = 'three_consecutive_unusable_responses';
            // Retain policy/unknown/failure reservations: the route can bill
            // hidden fallback attempts even when the returned usage looks cheap.
            const accounted = !args.live ? 0 : record.reported_cost_usd === null || !response.ok || profile.model.startsWith('policy/')
              ? Math.max(reservation, record.reported_cost_usd ?? 0) : record.reported_cost_usd;
            reservedUsd += accounted - reservation;
            record.accounted_cost_usd = accounted;
            if (reservedUsd > args.budgetUsd) globalStop = 'reported_cost_exceeded_client_budget';
            // HTTP headers needed by the production retry policy only; no other
            // provider headers or credentials are exposed to the VM/output.
            const headers = new Headers({ 'Content-Type': response.headers.get('content-type') || 'application/json' });
            if (response.headers.has('retry-after')) headers.set('retry-after', response.headers.get('retry-after'));
            return new Response(text, { status: response.status, headers });
          } catch (error) {
            record.error = error?.name === 'AbortError' || controller.signal.aborted ? 'request_aborted_or_timed_out' : 'request_transport_or_body_error';
            record.accounted_cost_usd = reservation;
            failures += 1;
            if (failures >= 3) profileStop = 'three_consecutive_transport_failures';
            throw new Error(record.error);
          } finally {
            clearTimeout(timeout);
            record.duration_ms = Date.now() - requestStart;
            try {
              await privateJson(path.join(out, `call-${String(record.call_number).padStart(3, '0')}-private.json`),
                { ...record, request: payload, response_body: text });
            } catch {
              globalStop = 'private_output_write_failed';
              runController.abort();
              throw new Error('EVALUATION_PRIVATE_OUTPUT_FAILED');
            }
          }
        };
        const scorer = scorerFrom(bundle, fetchHandler, deadlineAt);
        let data = null;
        let error = null;
        try {
          data = await scorer(copy(entry.data), entry.brief,
            async (value) => { progress = value; },
            async () => Boolean(globalStop || profileStop || Date.now() >= deadlineAt),
            { concurrency: 2, keepAllScored: true, onTelemetry: (value) => { telemetry = copy(value); },
              onStats: (value) => { stats = copy(value); }, onCheckpoint: async (value) => { checkpoint = copy(value); } });
          if (data.length !== entry.data.length || !entry.data.every((row, r) => row.every((cell, c) => data[r][c] === cell))) {
            throw new Error('row_order_or_input_mutation');
          }
        } catch (caught) {
          error = globalStop || profileStop || (caught?.message === 'row_order_or_input_mutation' ? caught.message : 'production_step_failed');
        }
        profileState.stopReason = profileStop;
        profileState.failures = failures;
        const result = { case_id: entry.id, profile: profile.id, status: error ? 'stopped_or_failed' : 'complete', error,
          wall_ms: Date.now() - profileStart, input_rows: entry.data.length - 1, output_rows: data ? data.length - 1 : null,
          progress, telemetry, stats, calls: profileCalls.map((record) => record.call_number),
          reported_cost_usd: profileCalls.reduce((sum, record) => sum + (record.reported_cost_usd ?? 0), 0),
          missing_cost_calls: profileCalls.filter((record) => record.reported_cost_usd === null).length,
          data, checkpoint };
        await privateJson(path.join(out, `${entry.id}-${profile.id}-private.json`), result);
        return result;
      }));
      results.push(...caseResults);
      console.log(JSON.stringify({ event: 'case_finished', case_number: results.length / PROFILES.length,
        profiles: caseResults.map(({ profile, status, wall_ms, input_rows, output_rows, telemetry, reported_cost_usd }) =>
          ({ profile, status, wall_ms, input_rows, output_rows, reported_cost_usd,
            failed_rows: telemetry?.failed_rows ?? null, length_responses: telemetry?.length_responses ?? null })),
        http_calls: calls.length, client_accounted_usd: reservedUsd }));
    }
  } finally {
    clearTimeout(runTimer);
    runController.abort();
    const summary = { schema_version: 1, dry_run: !args.live, complete: !globalStop && results.length === cases.length * PROFILES.length && results.every((result) => result.status === 'complete'),
      stop_reason: globalStop, wall_ms: Date.now() - startAt, http_calls: calls.length,
      reported_cost_usd: calls.reduce((sum, call) => sum + (call.reported_cost_usd ?? 0), 0),
      missing_cost_calls: calls.filter((call) => call.reported_cost_usd === null).length,
      client_accounted_usd: reservedUsd,
      results: results.map(({ data, checkpoint, ...result }) => result), calls,
      limitations: ['No human gold labels: score agreement is not accuracy.', 'Small fixture sample; production contention and routing may differ.',
        'Candidate model/reasoning changes only; no production writes or global routing changes.', 'A client estimate cannot guarantee provider billing, especially policy fallbacks and timed-out requests.'] };
    await privateJson(path.join(out, 'summary.json'), summary);
    console.log(JSON.stringify({ event: 'evaluation_finished', complete: summary.complete, dry_run: summary.dry_run,
      http_calls: calls.length, wall_ms: summary.wall_ms, reported_cost_usd: summary.reported_cost_usd,
      client_accounted_usd: reservedUsd, stop_reason: globalStop }));
    if (!summary.complete) process.exitCode = 2;
  }
}

main().catch(() => {
  // Never echo uncensored provider errors, input rows, briefs, or environment.
  console.error('TA evaluation failed; check arguments, isolation dependencies and private output. No production state was changed.');
  process.exitCode = 1;
});
