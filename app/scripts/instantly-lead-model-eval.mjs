#!/usr/bin/env node
/**
 * Opt-in, isolated evaluation of the CURRENT production lead qualifier.
 *
 * Dry run (no key/network required):
 *   node scripts/instantly-lead-model-eval.mjs --fixtures scripts/fixtures/instantly-lead-eval-pilot.json \
 *     --models deepseek/deepseek-v4-flash-0731,openai/gpt-4o-mini --out /tmp/lead-eval-dry-001
 * Live: add --live --prices /absolute/private/prices.json --budget-usd 3 --max-calls 160
 *   --key-env REQUESTY_API_KEY (load secrets via node --env-file externally).
 * Resume a partial run with --start-index 3 --limit 37, keeping the ORIGINAL
 * fixture file and its hash. Resume has its own budget; account previous runs too.
 * Optional --request-profiles FILE: {"models":{"exact/provider-model":{
 *   "reasoning_effort":"low","temperature":null,"max_completion_tokens":4000}}}.
 * Only reasoning_effort, temperature (null removes it), max_tokens and
 * max_completion_tokens may change. Supply at most one profile output cap; it
 * replaces the original cap. With no profile, the production payload is unchanged.
 * Profiles never change prompts/messages, model IDs, response format or endpoint.
 *
 * Prices JSON: {"models":{"provider/model":{"input_usd_per_million":0.44,
 *   "output_usd_per_million":1.32,"max_attempts":1}}}.
 * For policy/* entries, supply the maximum SUM of fallback attempts and rates at
 * least as high as the most expensive possible fallback. Their full conservative
 * reservation is retained; a response does not disclose billable failed attempts.
 * This is a client-side conservative estimate, NOT a provider-side hard spend cap.
 * Requesty's key budget is the final billing boundary; timeout may still be billed.
 *
 * Input: {schema_version:1,cases:[{id,category,language,provenance:{label_basis,...},
 *   expected_label:'lead'|'not_lead'|'review',score:boolean,input:{replyText,
 *   subject?,leadEmail?,briefText?,leadCriteria?,outboundText?:string|null,
 *   outboundMessages?:string[],prefetchedContext?:ThreadContext}}]}.
 * Exact prefetchedContext wins. Reconstructed contexts use reserved example domains.
 *
 * Each fixture/model makes at most ONE request, including technical replies so we
 * can measure AI defense in depth. The exact captured response is replayed through
 * classifyWithAI and qualifyReply without another network call. Raw model decisions,
 * parsed decisions, custom-priority decisions, prefilters and final rules are separate.
 * Synthetic/policy-derived labels are never pooled into human-confirmed accuracy.
 *
 * No worker is imported; DB/Instantly imports throw, even reads. No production
 * source is changed, no retries, no notifications/status writes. Production prompts
 * and payload options are captured from the original classifyWithAI function.
 * All prompts, input snapshots and responses remain in an explicit new private
 * directory (0700/0600), ignored by Git when inside this worktree. Never commit them.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile, chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const HARNESS_PATH = fileURLToPath(import.meta.url);
const APP = path.resolve(path.dirname(HARNESS_PATH), '..');
const REPO = path.dirname(APP);
const ENDPOINT = 'https://router.requesty.ai/v1/chat/completions';
const LABELS = new Set(['lead', 'not_lead', 'review']);
const MODEL_ID_RE = /^[a-zA-Z0-9_.:@/-]+$/;
const PROFILE_FIELDS = new Set(['reasoning_effort', 'temperature', 'max_tokens', 'max_completion_tokens']);
const REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'minimal']);
const nativeFetch = globalThis.fetch.bind(globalThis);
const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const jsonCopy = (value) => JSON.parse(JSON.stringify(value));

function argsOf(argv) {
  const args = { live: false, limit: 40, startIndex: 0, maxCalls: 160, budgetUsd: 3, timeoutMs: 45000,
    keyEnv: 'INSTANTLY_LEAD_EVAL_API_KEY' };
  const values = { '--fixtures': 'fixtures', '--models': 'models', '--out': 'out', '--prices': 'prices',
    '--request-profiles': 'requestProfiles',
    '--limit': 'limit', '--start-index': 'startIndex', '--max-calls': 'maxCalls', '--budget-usd': 'budgetUsd',
    '--timeout-ms': 'timeoutMs', '--key-env': 'keyEnv' };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--live') args.live = true;
    else if (flag === '--help') args.help = true;
    else if (values[flag] && argv[index + 1] && !argv[index + 1].startsWith('--')) args[values[flag]] = argv[++index];
    else throw new Error(`Unknown or incomplete option: ${flag}`);
  }
  if (args.help) return args;
  if (!args.fixtures || !args.models || !args.out) throw new Error('--fixtures, --models and --out are required');
  args.models = String(args.models).split(',').map((value) => value.trim()).filter(Boolean);
  if (!args.models.length || new Set(args.models).size !== args.models.length || args.models.some((model) => !MODEL_ID_RE.test(model))) {
    throw new Error('Provide unique, explicit provider/model IDs');
  }
  for (const field of ['limit', 'maxCalls', 'timeoutMs']) {
    args[field] = Number(args[field]);
    if (!Number.isSafeInteger(args[field]) || args[field] < 1) throw new Error(`Invalid ${field}`);
  }
  if (args.limit > 1000 || args.maxCalls > 4000 || args.timeoutMs > 60000) throw new Error('Maximums: 1000 fixtures, 4000 calls, 60000 ms timeout');
  args.startIndex = Number(args.startIndex);
  if (!Number.isSafeInteger(args.startIndex) || args.startIndex < 0) throw new Error('start-index must be a nonnegative integer');
  args.budgetUsd = Number(args.budgetUsd);
  if (!Number.isFinite(args.budgetUsd) || args.budgetUsd <= 0 || args.budgetUsd > 100) throw new Error('budget-usd must be > 0 and <= 100');
  if (!/^[A-Z][A-Z0-9_]*$/.test(args.keyEnv)) throw new Error('Invalid key environment variable name');
  if (!path.isAbsolute(args.out)) throw new Error('--out must be an explicit absolute NEW directory');
  if (args.live && !args.prices) throw new Error('--live requires --prices with explicit conservative model rates');
  if (args.live && !process.env[args.keyEnv]) throw new Error(`Missing API key environment variable: ${args.keyEnv}`);
  return args;
}

async function createPrivateOutput(out) {
  // Existing output is never overwritten. Resolve the parent to prevent a symlink
  // from turning an apparently external path into a tracked repository directory.
  const parent = await realpath(path.dirname(out));
  const resolved = path.join(parent, path.basename(out));
  const relative = path.relative(REPO, resolved);
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
    try {
      execFileSync('git', ['check-ignore', '--quiet', '--no-index', path.join(relative, 'evaluation-private.json')], { cwd: REPO, stdio: 'ignore' });
    } catch {
      throw new Error('Output inside the worktree must be Git-ignored (for example .tmp/...)');
    }
  }
  await mkdir(resolved, { mode: 0o700 });
  await chmod(resolved, 0o700);
  if ((await lstat(resolved)).isSymbolicLink()) throw new Error('Output cannot be a symlink');
  return resolved;
}

function makeContext(entry) {
  const input = entry.input;
  if (!input || typeof input !== 'object') throw new Error(`Missing input for fixture ${entry.id}`);
  if (input.prefetchedContext !== undefined) {
    const context = input.prefetchedContext;
    if (!context?.replyEmail || !Array.isArray(context.threadEmails) || !Object.hasOwn(context, 'lastOutbound')) {
      throw new Error(`Invalid prefetchedContext for fixture ${entry.id}`);
    }
    return jsonCopy(context);
  }
  if (typeof input.replyText !== 'string') throw new Error(`Missing replyText for fixture ${entry.id}`);
  const lead = input.leadEmail ?? 'lead@example.com';
  const base = { campaign_id: `eval-${entry.id}`, thread_id: `eval-${entry.id}`, subject: input.subject ?? 'Re: Offer',
    lead, eaccount: 'sales@example.com' };
  const outboundTexts = input.outboundMessages ?? (typeof input.outboundText === 'string' ? [input.outboundText] : []);
  if (!Array.isArray(outboundTexts) || outboundTexts.some((text) => typeof text !== 'string')) throw new Error(`Invalid outboundMessages for ${entry.id}`);
  const outbound = outboundTexts.map((text, index) => ({ ...base, id: `eval-${entry.id}-out-${index}`, ue_type: 1,
    from_address_email: 'sales@example.com', to_address_email_list: lead,
    timestamp_email: new Date(Date.UTC(2026, 8, 1, 8, index)).toISOString(), body: { text } }));
  const reply = { ...base, id: `eval-${entry.id}-reply`, ue_type: 2, from_address_email: lead,
    to_address_email_list: 'sales@example.com', timestamp_email: '2026-09-02T12:00:00.000Z',
    body: { text: input.replyText }, content_preview: input.replyText };
  return { replyEmail: reply, threadEmails: [...outbound, reply], lastOutbound: outbound.at(-1) ?? null };
}

async function loadClassifier(maxTokens) {
  const qualifierPath = path.join(APP, 'src/lib/instantly/leadQualifier.ts');
  const namesPath = path.join(APP, 'src/lib/enrich/extractors/nameQuality.ts');
  const blocked = 'throw new Error("EVALUATION_BLOCKED_EXTERNAL_DEPENDENCY");';
  const stubs = {
    './campaignProjectOwnerResolver': `export function resolveCampaignProjectOwner(){${blocked}}`,
    './client': `export function listEmails(){${blocked}}`,
    '@/lib/supabaseInstantly': `export const supabaseInstantly = new Proxy({}, {get(){${blocked}}});`,
    '@/lib/supabaseAdmin': `export const supabaseAdmin = new Proxy({}, {get(){${blocked}}});`,
  };
  const bundled = await build({ entryPoints: [qualifierPath], bundle: true, write: false,
    platform: 'node', target: 'node22', format: 'cjs', logLevel: 'silent',
    plugins: [{ name: 'isolate-lead-evaluation', setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return { path: qualifierPath };
        if (Object.hasOwn(stubs, args.path)) return { path: args.path, namespace: 'blocked' };
        if (args.path === '@/lib/enrich/extractors/nameQuality') return { path: namesPath };
        throw new Error(`Unapproved classifier dependency: ${args.path}`);
      });
      plugin.onLoad({ filter: /.*/, namespace: 'blocked' }, (args) => ({ contents: stubs[args.path], loader: 'js' }));
    } }] });
  let fetchHandler = async () => { throw new Error('EVALUATION_NETWORK_BLOCKED'); };
  const isolatedModule = { exports: {} };
  const sandbox = { module: isolatedModule, exports: isolatedModule.exports, Response, AbortSignal,
    process: { env: { INSTANTLY_LEAD_QUAL_MAX_TOKENS: String(maxTokens) } },
    fetch: (...args) => fetchHandler(...args),
    setTimeout: () => { throw new Error('Retries/backoffs are forbidden in model evaluation'); },
    // The production parser logs raw reply contents on errors. Keep them private;
    // raw responses are retained separately, never forwarded to console/stdout.
    console: { error() {}, warn() {}, log() {} } };
  runInNewContext(bundled.outputFiles[0].text, sandbox, { timeout: 5000, filename: 'isolated-lead-qualifier.cjs' });
  return { api: isolatedModule.exports, setFetch: (handler) => { fetchHandler = handler; },
    sourceHash: hash(await readFile(qualifierPath, 'utf8')), bundleHash: hash(bundled.outputFiles[0].text) };
}

const probeResponse = { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
  machine_reply_kind: null, non_lead_kind: null,
  is_lead: false, custom_criteria_matched: false, proposal_seen: false, interest_signals: [],
  reason: 'Evaluation-only probe; not a model verdict', confidence: 0, needs_review: true,
  objection_handleable: false, objection_draft: null,
}) } }] };

function assertRequest(url, init) {
  if (String(url) !== ENDPOINT || init?.method !== 'POST') throw new Error('Unapproved network request blocked');
  const payload = JSON.parse(init.body);
  if (!Array.isArray(payload.messages)) throw new Error('Unexpected classifier payload');
  effectiveOutputCap(payload);
  return payload;
}

function effectiveOutputCap(payload) {
  const fields = ['max_tokens', 'max_completion_tokens'].filter((field) => Object.hasOwn(payload, field));
  if (fields.length !== 1) throw new Error('Exactly one effective output cap is required');
  const cap = payload[fields[0]];
  if (!Number.isSafeInteger(cap) || cap < 1000 || cap > 10000) throw new Error('Effective output cap must be an integer from 1000 to 10000');
  return cap;
}

function validateRequestProfiles(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some((key) => key !== 'models') ||
      !config.models || typeof config.models !== 'object' || Array.isArray(config.models)) {
    throw new Error('Request profiles must contain only a models object');
  }
  for (const [model, profile] of Object.entries(config.models)) {
    if (!MODEL_ID_RE.test(model) || !profile || typeof profile !== 'object' || Array.isArray(profile) ||
        Object.keys(profile).some((field) => !PROFILE_FIELDS.has(field))) {
      throw new Error('Invalid model ID or non-allowlisted request profile field');
    }
    if (Object.hasOwn(profile, 'reasoning_effort') && !REASONING_EFFORTS.has(profile.reasoning_effort)) {
      throw new Error('Invalid request profile reasoning_effort');
    }
    if (Object.hasOwn(profile, 'temperature') && profile.temperature !== null &&
        (typeof profile.temperature !== 'number' || !Number.isFinite(profile.temperature) || profile.temperature < 0 || profile.temperature > 2)) {
      throw new Error('Request profile temperature must be null or a number from 0 to 2');
    }
    const caps = ['max_tokens', 'max_completion_tokens'].filter((field) => Object.hasOwn(profile, field));
    if (caps.length > 1) throw new Error('Request profile may override only one output cap');
    if (caps.length) effectiveOutputCap(profile);
  }
  return config;
}

function applyRequestProfile(basePayload, profile) {
  // Copy first: no shared messages or base payload may be mutated between models.
  const payload = jsonCopy(basePayload);
  if (profile) {
    if (Object.hasOwn(profile, 'reasoning_effort')) payload.reasoning_effort = profile.reasoning_effort;
    if (Object.hasOwn(profile, 'temperature')) {
      if (profile.temperature === null) delete payload.temperature;
      else payload.temperature = profile.temperature;
    }
    for (const field of ['max_tokens', 'max_completion_tokens']) {
      if (Object.hasOwn(profile, field)) {
        delete payload.max_tokens;
        delete payload.max_completion_tokens;
        payload[field] = profile[field];
      }
    }
  }
  effectiveOutputCap(payload);
  if (payload.model !== basePayload.model || hash(payload.messages) !== hash(basePayload.messages) ||
      hash(payload.response_format) !== hash(basePayload.response_format)) {
    throw new Error('Request profile changed a protected production request field');
  }
  return payload;
}

function decision(value) {
  if (!value || typeof value.needsReview !== 'boolean' || typeof value.isLead !== 'boolean') return null;
  // Same disposition order as the worker: review takes precedence over isLead.
  return value.needsReview ? 'review' : value.isLead ? 'lead' : 'not_lead';
}

function workerStatus(value, hasCriteria) {
  if (hasCriteria && value.customCriteriaMatched) return 'lead';
  if (value.needsReview) return 'needs_review';
  if (value.isLead) return 'lead';
  return value.objectionHandleable ? 'objection' : 'not_lead';
}

function withoutContext(result) {
  const { threadContext: _context, ...rest } = result;
  return jsonCopy(rest);
}

async function replay(isolated, entry, context, model, response = probeResponse, requestProfile = null) {
  const options = { apiKey: 'evaluation-placeholder-not-a-real-key', model, maxRetries: 0,
    briefText: entry.input.briefText ?? '', leadCriteria: entry.input.leadCriteria ?? '', prefetchedContext: context };
  let captured = null;
  let capturedBase = null;
  let calls = 0;
  isolated.setFetch(async (url, init) => {
    const basePayload = assertRequest(url, init);
    const payload = applyRequestProfile(basePayload, requestProfile);
    if (capturedBase && JSON.stringify(capturedBase) !== JSON.stringify(basePayload)) throw new Error('Replay base prompt differs from direct classifier prompt');
    if (captured && JSON.stringify(captured) !== JSON.stringify(payload)) throw new Error('Replay prompt differs from direct classifier prompt');
    capturedBase = basePayload;
    captured = payload;
    calls++;
    return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  // A rejected model response is an observation, not a runner failure. Replay
  // every stage separately: production prefilters can still reject a machine
  // reply without calling AI, but a failed AI verdict must never become not_lead.
  const stageErrors = {};
  async function observeStage(stage, operation) {
    try { return await operation(); }
    catch (error) {
      // Private artifact only; parser errors may contain model-generated text.
      stageErrors[stage] = String(error?.message ?? error).slice(0, 1000);
      return null;
    }
  }
  const classified = await observeStage('classified', () => isolated.api.classifyWithAI(context, options));
  if (calls !== 1) throw new Error('Direct classifier made an unexpected number of calls');
  const result = await observeStage('final', () => isolated.api.qualifyReply(context.replyEmail.campaign_id ?? `eval-${entry.id}`,
    context.replyEmail.from_address_email ?? 'lead@example.com', context.replyEmail.thread_id ?? null, options));
  if (calls !== 1 && calls !== 2) throw new Error('Pipeline made an unexpected number of calls');
  const observedContent = response.choices?.[0]?.message?.content;
  const rawText = typeof observedContent === 'string' ? observedContent : '';
  const parsed = await observeStage('parsed', () => isolated.api._private.parseAIResult(rawText));
  let rawJson = null;
  let rawJsonFormat = 'unparseable';
  try {
    rawJson = JSON.parse(rawText);
    rawJsonFormat = 'strict';
  } catch {
    // Formatting is measured separately from semantics. Only a complete outer
    // Markdown fence may be removed here; no repair, coercion or business rules.
    const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i.exec(rawText.trim());
    if (fenced) {
      try {
        rawJson = JSON.parse(fenced[1]);
        rawJsonFormat = 'markdown_fence';
      } catch { /* Keep unparseable; the production parser result remains separate. */ }
    }
  }
  const rawFlagsValid = rawJson !== null && typeof rawJson === 'object' && !Array.isArray(rawJson) &&
    typeof rawJson.is_lead === 'boolean' && typeof rawJson.needs_review === 'boolean';
  const schemaIssues = [];
  if (!rawJson || typeof rawJson !== 'object' || Array.isArray(rawJson)) schemaIssues.push('expected_json_object');
  else {
    for (const field of ['is_lead', 'needs_review', 'custom_criteria_matched', 'proposal_seen', 'objection_handleable']) {
      if (typeof rawJson[field] !== 'boolean') schemaIssues.push(`invalid_${field}`);
    }
    if (![null, 'auto_reply', 'delivery_failure', 'service_acknowledgement'].includes(rawJson.machine_reply_kind)) schemaIssues.push('invalid_machine_reply_kind');
    if (![null, 'seller_pitch', 'service_followup', 'contact_routing'].includes(rawJson.non_lead_kind)) schemaIssues.push('invalid_non_lead_kind');
    if (typeof rawJson.reason !== 'string' || !rawJson.reason.trim()) schemaIssues.push('invalid_reason');
    if (typeof rawJson.confidence !== 'number' || !Number.isFinite(rawJson.confidence) || rawJson.confidence < 0 || rawJson.confidence > 1) schemaIssues.push('invalid_confidence');
    if (!Array.isArray(rawJson.interest_signals) || !rawJson.interest_signals.every((signal) => typeof signal === 'string')) schemaIssues.push('invalid_interest_signals');
    if (rawJson.objection_draft !== null && typeof rawJson.objection_draft !== 'string') schemaIssues.push('invalid_objection_draft');
  }
  const finalStatus = result ? workerStatus(result, Boolean(entry.input.leadCriteria?.trim())) : null;
  return { payload: jsonCopy(captured), basePayload: jsonCopy(capturedBase), pipelineWouldCallAI: calls === 2, parsed: jsonCopy(parsed),
    classified: jsonCopy(classified), final: result ? withoutContext(result) : null, rawJson, stageErrors, schemaIssues,
    strictJson: rawJsonFormat === 'strict' && rawJson !== null && typeof rawJson === 'object' && !Array.isArray(rawJson),
    rawJsonFormat,
    strictSchema: schemaIssues.length === 0, rawFlagsValid,
    rawLabel: rawFlagsValid ? (rawJson.needs_review ? 'review' : rawJson.is_lead ? 'lead' : 'not_lead') : null,
    parsedLabel: decision(parsed), classifiedLabel: decision(classified), finalStatus,
    finalLabel: finalStatus === null ? null : finalStatus === 'needs_review' ? 'review' : finalStatus === 'lead' ? 'lead' : 'not_lead' };
}

function priceFor(prices, model) {
  const rate = prices.models?.[model];
  if (!rate) throw new Error(`Missing explicit price for ${model}`);
  for (const field of ['input_usd_per_million', 'output_usd_per_million']) {
    if (typeof rate[field] !== 'number' || !Number.isFinite(rate[field]) || rate[field] < 0) throw new Error(`Invalid ${field} for ${model}`);
  }
  const attempts = rate.max_attempts ?? (model.startsWith('policy/') ? null : 1);
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 30) throw new Error(`Explicit max_attempts (1–30) required for ${model}`);
  return { ...rate, max_attempts: attempts };
}

function reserveCost(payload, rate) {
  // Byte count is intentionally a loose upper estimate (not a tokenizer claim).
  // Include JSON structure plus generous wrapper overhead; reserve all max output.
  const inputTokensUpper = Buffer.byteLength(JSON.stringify(payload.messages), 'utf8') + 1024;
  const outputTokensUpper = effectiveOutputCap(payload);
  return { inputTokensUpper, usd: rate.max_attempts *
    (inputTokensUpper * rate.input_usd_per_million + outputTokensUpper * rate.output_usd_per_million) / 1e6 };
}

function observedCost(data, requestedModel, prices, reservation) {
  // Policies/hidden retries may bill attempts that are absent from response usage.
  // Missing usage/unknown actual models retain the whole reservation as well.
  const actual = data.model;
  const rate = prices.models?.[actual];
  const usage = data.usage;
  if (requestedModel.startsWith('policy/') || priceFor(prices, requestedModel).max_attempts > 1 || !rate || !usage ||
      !Number.isFinite(usage.prompt_tokens) || !Number.isFinite(usage.completion_tokens) ||
      usage.prompt_tokens < 0 || usage.completion_tokens < 0) {
    return { accountedUsd: reservation.usd, basis: 'conservative_reservation', usageEstimateUsd: null };
  }
  const estimate = (usage.prompt_tokens * rate.input_usd_per_million + usage.completion_tokens * rate.output_usd_per_million) / 1e6;
  return { accountedUsd: estimate, basis: 'reported_tokens_configured_prices', usageEstimateUsd: estimate };
}

function summarize(records, models) {
  return models.map((model) => {
    const rows = records.filter((row) => row.requested_model === model);
    const good = rows.filter((row) => row.status === 'ok');
    const attempted = rows.filter((row) => row.status !== 'dry_run');
    const responses = attempted.filter((row) => row.http_status >= 200 && row.http_status < 300);
    // Include paid HTTP successes even when parsing/classification failed. The
    // latency is HTTP completion time, not time spent on the offline replay.
    const latency = responses.map((row) => row.elapsed_ms).filter(Number.isFinite).sort((a, b) => a - b);
    const groups = Object.create(null);
    // Every attempted scored case stays in the denominator, including transport
    // and schema failures. Missing verdicts are null, never negative decisions.
    for (const row of attempted.filter((row) => row.score)) {
      const group = groups[row.label_basis] ??= { n: 0, raw_correct: 0, final_correct: 0,
        raw_false_positive: 0, final_false_positive: 0, raw_missed_lead: 0, final_missed_lead: 0,
        raw_reviews: 0, final_reviews: 0, raw_no_verdict: 0, final_no_verdict: 0,
        errors: 0, invalid_raw_flags: 0, changed_by_rules: 0 };
      group.n++;
      group.raw_correct += Number(row.raw_label === row.expected_label);
      group.final_correct += Number(row.final_label === row.expected_label);
      for (const [prefix, label] of [['raw', row.raw_label], ['final', row.final_label]]) {
        group[`${prefix}_false_positive`] += Number(label === 'lead' && row.expected_label !== 'lead');
        group[`${prefix}_missed_lead`] += Number(label !== 'lead' && row.expected_label === 'lead');
        group[`${prefix}_reviews`] += Number(label === 'review');
        group[`${prefix}_no_verdict`] += Number(label == null);
      }
      group.errors += Number(row.status === 'error');
      group.invalid_raw_flags += Number(!row.raw_flags_valid);
      group.changed_by_rules += Number(row.raw_label != null && row.final_label != null && row.raw_label !== row.final_label);
    }
    return { model, planned_or_attempted: rows.length, completed: good.length,
      errors: rows.filter((row) => row.status === 'error').length,
      http_responses: attempted.filter((row) => Number.isInteger(row.http_status)).length,
      successful_http_responses: responses.length,
      final_verdicts: attempted.filter((row) => row.final_label != null).length,
      classification_errors: attempted.filter((row) => row.classification_errors && Object.keys(row.classification_errors).length).length,
      prefiltered: rows.filter((row) => row.pipeline_would_call_ai === false).length,
      actual_models: [...new Set(responses.map((row) => row.actual_model ?? '(not reported)'))],
      strict_json_failures: responses.filter((row) => !row.strict_json).length,
      markdown_fence_responses: responses.filter((row) => row.raw_json_format === 'markdown_fence').length,
      strict_schema_failures: responses.filter((row) => !row.strict_schema).length,
      p50_ms: latency.length ? latency[Math.floor((latency.length - 1) * 0.5)] : null,
      p95_ms: latency.length ? latency[Math.ceil((latency.length - 1) * 0.95)] : null,
      accounted_usd: rows.reduce((sum, row) => sum + (row.accounted_usd ?? 0), 0), label_groups: groups };
  });
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  if (args.help) {
    console.log('Isolated lead-model eval. Required: --fixtures FILE --models a/model,b/model --out /absolute/NEW-dir.\nDry by default. Live: --live --prices FILE --key-env VAR [--request-profiles FILE] [--budget-usd 3] [--max-calls 160] [--start-index 0] [--limit 40] [--timeout-ms 45000].\nSee script header for fixture/pricing schemas, privacy and fallback cost limitations.');
    return;
  }
  const fixtureBytes = await readFile(path.resolve(args.fixtures), 'utf8');
  const fixtures = JSON.parse(fixtureBytes);
  if (fixtures.schema_version !== 1 || !Array.isArray(fixtures.cases)) throw new Error('Expected schema_version:1 and cases array');
  const cases = fixtures.cases.slice(args.startIndex, args.startIndex + args.limit);
  if (!cases.length || new Set(cases.map((entry) => entry.id)).size !== cases.length) throw new Error('Fixture IDs must be nonempty and unique');
  for (const entry of cases) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(entry.id) || !LABELS.has(entry.expected_label) ||
      typeof entry.score !== 'boolean' || !entry.provenance?.label_basis) throw new Error('Invalid fixture ID, label, score or label provenance');
    if (entry.provenance.label_basis === 'ambiguous' && entry.score) throw new Error(`Ambiguous fixture ${entry.id} must have score:false`);
  }
  const prices = args.prices ? JSON.parse(await readFile(path.resolve(args.prices), 'utf8')) : { models: {} };
  if (!prices.models || typeof prices.models !== 'object' || Array.isArray(prices.models)) throw new Error('Prices must contain a models object');
  for (const model of Object.keys(prices.models)) priceFor(prices, model);
  if (args.live) for (const model of args.models) priceFor(prices, model);
  const profileBytes = args.requestProfiles ? await readFile(path.resolve(args.requestProfiles), 'utf8') : null;
  const requestProfiles = validateRequestProfiles(profileBytes === null ? { models: {} } : JSON.parse(profileBytes));
  const maxTokens = Number(process.env.INSTANTLY_LEAD_QUAL_MAX_TOKENS ?? 2000);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1000 || maxTokens > 10000) throw new Error('INSTANTLY_LEAD_QUAL_MAX_TOKENS must be an integer from 1000 to 10000');
  const isolated = await loadClassifier(maxTokens);
  const output = await createPrivateOutput(args.out);
  const started = new Date().toISOString();
  const records = [];
  const prepared = [];
  let accounted = 0;
  let calls = 0;
  let stopped = null;
  const consecutiveFailures = new Map(args.models.map((model) => [model, 0]));
  await writeFile(path.join(output, 'fixtures.private.json'), fixtureBytes, { mode: 0o600 });
  for (const entry of cases) {
    const context = makeContext(entry);
    const probes = new Map();
    // Production may scope inference parameters to an exact policy/model ID.
    // Changing only the model name on the first model's payload would leak that
    // profile to other candidates and make the benchmark order-dependent.
    // These captures/replays are offline and never consume a paid call.
    for (const model of args.models) {
      const probe = await replay(isolated, entry, context, model);
      if (Object.keys(probe.stageErrors).length) throw new Error('Evaluation probe failed the current classifier contract');
      probes.set(model, probe);
    }
    prepared.push({ entry, context, probes });
  }
  const manifest = { schema_version: 1, started_at: started, mode: args.live ? 'live' : 'dry_run',
    fixture_sha256: hash(fixtureBytes), source_sha256: isolated.sourceHash, bundle_sha256: isolated.bundleHash,
    harness_sha256: hash(await readFile(HARNESS_PATH, 'utf8')),
    request_profiles: requestProfiles, request_profiles_source_sha256: profileBytes === null ? null : hash(profileBytes),
    models: args.models, cases: cases.length, start_index: args.startIndex, max_calls: args.maxCalls, budget_usd: args.budgetUsd,
    timeout_ms: args.timeoutMs, max_output_tokens: maxTokens, base_max_output_tokens: maxTokens,
    effective_output_caps: Object.fromEntries(args.models.map((model) => [model,
      effectiveOutputCap(applyRequestProfile(prepared[0].probes.get(model).basePayload, requestProfiles.models[model] ?? null))])),
    prices, production_retries: 'disabled for comparison',
    scoring_note: 'Label bases reported separately; all attempted scored cases remain in denominators, including errors; absent verdicts are null, never not_lead; no held-out claim.',
    cost_note: 'Conservative client-side estimate, not provider hard cap; policy reservations include configured fallback attempts.',
    prefilter_note: 'AI evaluated even for prefiltered cases for defense-in-depth; production would skip those calls.' };
  await writeFile(path.join(output, 'manifest.private.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  // Fixture-first, rotating model order spreads transient provider conditions.
  outer: for (let index = 0; index < prepared.length; index++) {
    const { entry, context, probes } = prepared[index];
    const modelOffset = (args.startIndex + index) % args.models.length;
    const models = [...args.models.slice(modelOffset), ...args.models.slice(0, modelOffset)];
    for (const model of models) {
      const probe = probes.get(model);
      const basePayload = probe.basePayload;
      const requestProfile = requestProfiles.models[model] ?? null;
      const payload = applyRequestProfile(basePayload, requestProfile);
      const row = { id: entry.id, fixture_index: args.startIndex + index, category: entry.category, language: entry.language,
        label_basis: entry.provenance.label_basis, expected_label: entry.expected_label, score: entry.score,
        input_sha256: hash({ context, briefText: entry.input.briefText ?? '', leadCriteria: entry.input.leadCriteria ?? '' }),
        prompt_sha256: hash(payload.messages), original_prompt_sha256: hash(basePayload.messages),
        payload_sha256: hash(payload), base_payload_sha256: hash(basePayload), requested_model: model,
        request_profile: requestProfile, effective_output_cap: effectiveOutputCap(payload),
        pipeline_would_call_ai: probe.pipelineWouldCallAI,
        prefilter: probe.pipelineWouldCallAI ? null : probe.final, base_request: basePayload, request: payload,
        raw_label: null, parsed_label: null, classified_label: null, final_label: null, final_worker_status: null };
      if (!args.live) row.status = 'dry_run';
      else {
        const reservation = reserveCost(payload, priceFor(prices, model));
        if (calls >= args.maxCalls) { stopped = 'max_calls'; break outer; }
        if (accounted + reservation.usd > args.budgetUsd) { stopped = 'conservative_budget'; break outer; }
        calls++;
        const t0 = performance.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), args.timeoutMs);
        let errorPhase = 'request';
        try {
          const response = await nativeFetch(ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env[args.keyEnv]}`,
              'HTTP-Referer': 'https://portal.app', 'X-Title': 'Portal - Instantly Lead Model Evaluation' },
            body: JSON.stringify(payload) });
          const responseText = await response.text();
          row.elapsed_ms = Math.round(performance.now() - t0);
          row.http_status = response.status;
          // Private artifact only. Never print an upstream body, which may echo inputs.
          row.response_text = responseText;
          if (!response.ok) throw new Error(`HTTP_${response.status}`);
          errorPhase = 'response_envelope';
          const data = JSON.parse(responseText);
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid response envelope');
          // Persist billable transport evidence BEFORE replay. A strict parser
          // rejecting {} or a truncated answer must not erase tokens/costs or
          // masquerade as a transport failure with unknown model/finish reason.
          row.actual_model = data.model ?? null;
          row.response_id = data.id ?? null;
          row.usage = data.usage ?? null;
          row.finish_reason = data.choices?.[0]?.finish_reason ?? null;
          row.response_content = data.choices?.[0]?.message?.content ?? null;
          row.reported_top_level_cost = data.cost ?? null;
          row.reported_usage_cost = data.usage?.cost ?? null;
          const costs = observedCost(data, model, prices, reservation);
          row.accounted_usd = costs.accountedUsd;
          row.cost_basis = costs.basis;
          row.usage_estimate_usd = costs.usageEstimateUsd;
          if (costs.accountedUsd > reservation.usd) stopped = 'reported_usage_exceeded_reservation';
          errorPhase = 'replay';
          const result = await replay(isolated, entry, context, model, data, requestProfile);
          if (hash(result.payload) !== row.payload_sha256) throw new Error('Replay payload mismatch');
          if (hash(result.basePayload) !== row.base_payload_sha256 || hash(result.basePayload.messages) !== row.original_prompt_sha256) {
            throw new Error('Replay original production prompt mismatch');
          }
          row.classification_errors = result.stageErrors;
          row.status = Object.keys(result.stageErrors).length ? 'error' : 'ok';
          if (row.status === 'error') row.error = 'AI_RESPONSE_REJECTED';
          row.strict_json = result.strictJson;
          row.raw_json_format = result.rawJsonFormat;
          row.strict_schema = result.strictSchema;
          row.schema_issues = result.schemaIssues;
          row.raw_flags_valid = result.rawFlagsValid;
          row.raw_json = result.rawJson;
          row.raw_label = result.rawLabel;
          row.raw_flags = result.rawJson && {
            is_lead: result.rawJson.is_lead, needs_review: result.rawJson.needs_review,
            custom_criteria_matched: result.rawJson.custom_criteria_matched,
            machine_reply_kind: result.rawJson.machine_reply_kind, non_lead_kind: result.rawJson.non_lead_kind };
          row.parsed = result.parsed;
          row.classified = result.classified;
          row.final = result.final;
          row.parsed_label = result.parsedLabel;
          row.classified_label = result.classifiedLabel;
          row.final_label = result.finalLabel;
          row.final_worker_status = result.finalStatus;
          const validResult = row.status === 'ok' && result.strictSchema && row.finish_reason !== 'length';
          consecutiveFailures.set(model, validResult ? 0 : consecutiveFailures.get(model) + 1);
        } catch (error) {
          row.status = 'error';
          row.elapsed_ms ??= Math.round(performance.now() - t0);
          row.error = controller.signal.aborted ? 'TIMEOUT_BILLING_UNKNOWN' :
            /^HTTP_\d+$/.test(error.message) ? error.message :
              errorPhase === 'response_envelope' ? 'INVALID_RESPONSE_ENVELOPE' :
                errorPhase === 'replay' ? 'REPLAY_INVARIANT_ERROR' : 'REQUEST_OR_REPLAY_ERROR';
          if (errorPhase === 'response_envelope') row.schema_issues = ['invalid_response_envelope'];
          row.accounted_usd = Math.max(row.accounted_usd ?? 0, reservation.usd);
          row.cost_basis = 'error_reserved_maximum_billing_unknown';
          consecutiveFailures.set(model, consecutiveFailures.get(model) + 1);
          // Authentication/payment/rate failures are shared state, not bad cases.
          if ([401, 402, 403, 429].includes(row.http_status)) stopped = `upstream_${row.http_status}`;
        } finally {
          clearTimeout(timer);
        }
        accounted += row.accounted_usd;
        if (consecutiveFailures.get(model) >= 3 && !stopped) stopped = 'three_consecutive_model_failures';
      }
      records.push(row);
      await appendFile(path.join(output, 'results.private.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 });
      console.log(JSON.stringify({ progress: records.length, total: cases.length * args.models.length,
        fixture: entry.id, model, status: row.status, calls, accounted_usd: Number(accounted.toFixed(5)) }));
      if (stopped) break outer;
    }
  }
  const summary = { ...manifest, completed_at: new Date().toISOString(), calls, accounted_usd: accounted,
    stopped, results: summarize(records, args.models) };
  await writeFile(path.join(output, 'summary.private.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ output, mode: manifest.mode, calls, stopped, accounted_usd: accounted, results: summary.results }, null, 2));
  if (stopped || records.some((row) => row.status === 'error')) process.exitCode = 2;
}

main().catch(() => {
  // Errors may include upstream inputs, file contents or credentials; do not leak
  // them to a shared terminal. CLI validation/help is documented in the header.
  console.error('Lead evaluation stopped before completion. Check arguments, private output, local dependency availability and fixture schema. No worker or production write was performed.');
  process.exitCode = 1;
});
