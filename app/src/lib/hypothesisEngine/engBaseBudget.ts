import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  openHeEngBaseBudget,
  type HeEngBaseBudgetLedger,
  type HeEngBaseSpendReservation,
} from './engBaseBudgetLedger';

/**
 * Only the confirmed client ENG base stages open this scope. Research, RU,
 * internal HE and VE2 never acquire a scope and retain their existing transport.
 * The ledger independently verifies the base/project/client ownership.
 */
interface BaseBudgetScope {
  ledger: HeEngBaseBudgetLedger;
  baseId: string;
  projectId: string;
  stage: string;
  stopped: Error | null;
}

const scopeStorage = new AsyncLocalStorage<BaseBudgetScope>();
// In-process evidence only: an error/property restored from JSON cannot prove
// that a provider was never called. This marker covers one physical attempt.
const preflightFailures = new WeakSet<Error>();

/** Only valid for a single callLLMText attempt with transportRetries: 0. */
export function isHeEngBaseBudgetPreflightFailure(error: unknown): boolean {
  return error instanceof Error && preflightFailures.has(error);
}

export class HeEngBaseBudgetGuardError extends Error {
  readonly heEngBaseBudgetError = true as const;
  readonly heJobTerminal = true as const;

  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(`ENG base budget: ${message}`, options);
    this.name = 'HeEngBaseBudgetGuardError';
  }
}

/** A budget failure must survive optional stages' catch-and-continue paths. */
export function rethrowHeEngBaseBudgetError(error: unknown): void {
  for (let item = error, depth = 0; item && depth < 8; depth += 1) {
    const candidate = item as { heEngBaseBudgetError?: unknown; cause?: unknown };
    if (candidate.heEngBaseBudgetError === true) throw item;
    item = candidate.cause;
  }
}

function budgetFailure(error: unknown, code: string, message: string): Error {
  try {
    rethrowHeEngBaseBudgetError(error);
  } catch (known) {
    if (known instanceof Error) return known;
  }
  return new HeEngBaseBudgetGuardError(code, message, { cause: error });
}

export function heEngBaseBudgetActive(): boolean {
  return scopeStorage.getStore() !== undefined;
}

export function rejectHeEngUnbudgetedProvider(provider: string): never {
  const error = new HeEngBaseBudgetGuardError(
    'unbudgeted_provider',
    `the ${provider} request has no confirmed price bound and was stopped before sending.`,
  );
  const scope = scopeStorage.getStore();
  if (scope) scope.stopped = error;
  throw error;
}

export async function withHeEngBaseBudget<T>(
  db: SupabaseClient,
  baseId: string,
  projectId: string,
  work: () => Promise<T>,
  stage = 'base_prepare',
): Promise<T> {
  const existing = scopeStorage.getStore();
  if (existing) {
    if (existing.baseId !== baseId || existing.projectId !== projectId) {
      throw new HeEngBaseBudgetGuardError('scope_mismatch', 'a different base cannot share this budget scope.');
    }
    if (existing.stopped) throw existing.stopped;
    const result = await work();
    if (existing.stopped) throw existing.stopped;
    return result;
  }
  const ledger = await openHeEngBaseBudget(db, baseId, projectId);
  const scope: BaseBudgetScope = { ledger, baseId, projectId, stage, stopped: null };
  return scopeStorage.run(scope, async () => {
    const result = await work();
    // Optional stage catches must not convert a held budget into a successful
    // stage even if they accidentally ignore the terminal marker.
    if (scope.stopped) throw scope.stopped;
    return result;
  });
}

const REQUESTY_MODELS_URL = 'https://router.requesty.ai/v1/models';
const PRICE_TTL_MS = 60_000;
const PRICE_TIMEOUT_MS = 15_000;
const PRICE_MAX_BYTES = 4 * 1024 * 1024;
const REQUEST_MAX_BYTES = 16 * 1024 * 1024;
const RATE_CUSHION = 2;
const USD_MICROS = 1_000_000;

interface PriceCeiling {
  inputUsdPerToken: number;
  outputUsdPerToken: number;
}

// Public, unauthenticated catalogue; no client key or prompts enter the cache.
let priceCache: { expiresAt: number; rows: unknown[] } | undefined;

function pricingError(message: string, cause?: unknown): HeEngBaseBudgetGuardError {
  return new HeEngBaseBudgetGuardError(
    'pricing_unavailable',
    `${message} No paid request was sent.`,
    cause === undefined ? undefined : { cause },
  );
}

async function requestyPriceRows(signal: AbortSignal): Promise<unknown[]> {
  signal.throwIfAborted();
  if (priceCache && priceCache.expiresAt > Date.now()) return priceCache.rows;
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(PRICE_TIMEOUT_MS)]);
  try {
    const response = await fetch(REQUESTY_MODELS_URL, { signal: boundedSignal });
    if (!response.ok || !response.body) throw pricingError('The current model price catalogue is unavailable.');
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > PRICE_MAX_BYTES) {
      await response.body.cancel();
      throw pricingError('The model price catalogue exceeds its size limit.');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        boundedSignal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > PRICE_MAX_BYTES) throw pricingError('The model price catalogue exceeds its size limit.');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || !('data' in parsed) ||
        !Array.isArray(parsed.data) || parsed.data.length === 0) {
      throw pricingError('The model price catalogue has an unsupported format.');
    }
    priceCache = { expiresAt: Date.now() + PRICE_TTL_MS, rows: parsed.data };
    return parsed.data;
  } catch (error) {
    signal.throwIfAborted();
    rethrowHeEngBaseBudgetError(error);
    throw pricingError('The current model prices could not be verified.', error);
  }
}

function finiteRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function priceCeiling(rows: unknown[], model: string): PriceCeiling {
  const records = rows.filter((row): row is Record<string, unknown> =>
    Boolean(row) && typeof row === 'object' && !Array.isArray(row));
  const exact = records.filter((row) => row.id === model);
  // Bare aliases are accepted only when the public catalogue resolves them
  // unambiguously. No guessed prefix, dated-alias stripping or stale price table.
  const matches = exact.length ? exact : !model.includes('/')
    ? records.filter((row) => typeof row.id === 'string' && row.id.endsWith(`/${model}`))
    : [];
  if (matches.length !== 1 || matches[0].api !== 'chat') {
    throw pricingError(`The model '${model}' has no unique current chat price.`);
  }
  const modelRow = matches[0];
  if (!Array.isArray(modelRow.pricing) || modelRow.pricing.length === 0) {
    throw pricingError(`The model '${model}' has no explicit pricing tiers.`);
  }
  let input = 0;
  let output = 0;
  // Include the top-level rate and EVERY tier: token counts cannot silently
  // switch GPT/Gemini into a more expensive long-context tier.
  for (const raw of [modelRow, ...modelRow.pricing]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw pricingError(`The model '${model}' has an invalid pricing tier.`);
    }
    const tier = raw as Record<string, unknown>;
    if (!finiteRate(tier.input_price) || !finiteRate(tier.output_price)) {
      throw pricingError(`The model '${model}' has an unknown input or output price.`);
    }
    input = Math.max(input, tier.input_price);
    output = Math.max(output, tier.output_price);
    // Cache creation can cost more than ordinary input. Discounts never reduce
    // our reserve; present but unrecognised rates fail closed.
    const cachePriceKeys = ['cached_price', 'caching_price', 'caching_5m_price', 'caching_1h_price'];
    for (const key of Object.keys(tier)) {
      if (key.endsWith('_price') && !['input_price', 'output_price', ...cachePriceKeys].includes(key)) {
        throw pricingError(`The model '${model}' has an unsupported price component.`);
      }
    }
    for (const key of cachePriceKeys) {
      if (tier[key] !== undefined && tier[key] !== null) {
        if (!finiteRate(tier[key])) throw pricingError(`The model '${model}' has an invalid cache price.`);
        input = Math.max(input, tier[key] as number);
      }
    }
  }
  return { inputUsdPerToken: input, outputUsdPerToken: output };
}

export interface HeEngRequestyReservation {
  scope: BaseBudgetScope;
  reservation: HeEngBaseSpendReservation;
  settled: boolean;
}

/**
 * Reserves before EACH actual HTTP POST, including schema repair, fallback and
 * critic calls. Full serialized UTF-8 body bounds text/schema input tokens
 * conservatively; 1,024 extra tokens cover model framing. The entire output
 * ceiling (including reasoning) is reserved. Fresh maximum catalogue rates get
 * a 2x cushion, covering Requesty's markup. Unknown models never make a POST.
 */
export async function reserveHeEngRequestyCall(
  model: string,
  body: string,
  maxTokens: number,
  signal: AbortSignal,
): Promise<HeEngRequestyReservation | null> {
  const scope = scopeStorage.getStore();
  if (!scope) return null;
  if (scope.stopped) throw scope.stopped;
  try {
    const bytes = Buffer.byteLength(body, 'utf8');
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 128_000 || bytes > REQUEST_MAX_BYTES) {
      throw new HeEngBaseBudgetGuardError('invalid_request_bound', 'the request has no safe token ceiling.');
    }
    const prices = priceCeiling(await requestyPriceRows(signal), model);
    signal.throwIfAborted();
    const maximumUsd = ((bytes + 1024) * prices.inputUsdPerToken +
      maxTokens * prices.outputUsdPerToken) * RATE_CUSHION;
    const reservedMicrousd = Math.max(1, Math.ceil(maximumUsd * USD_MICROS));
    if (!Number.isSafeInteger(reservedMicrousd)) {
      throw new HeEngBaseBudgetGuardError('invalid_request_bound', 'the request cost cannot be bounded.');
    }
    const reservation = await scope.ledger.reserve({
      requestId: randomUUID(),
      provider: 'requesty',
      stage: scope.stage,
      model,
      reservedMicrousd,
    });
    return { scope, reservation, settled: false };
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    const failure = budgetFailure(error, 'reservation_failed', 'the request budget could not be reserved.');
    // llm.ts awaits this function before entering the paid HTTP transport.
    // An ambiguous global reservation is still retained by the ledger; this
    // only proves that THIS provider attempt was not dispatched.
    preflightFailures.add(failure);
    scope.stopped = failure;
    throw failure;
  }
}

/**
 * An unknown charge (timeout, broken connection, HTTP error, a reply without
 * usage) is booked at the full reserve. The reserve already bounds the whole
 * body and the output ceiling at the highest catalogue rates with a 2x cushion,
 * so the ledger never under-counts. It used to hold the base instead, and one
 * slow model answer ended the collection. Only a charge that cannot be saved
 * stops further paid work.
 */
export async function settleHeEngRequestyCall(
  call: HeEngRequestyReservation | null,
  reportedCostUsd: unknown,
): Promise<void> {
  if (!call || call.settled) return;
  // Set before awaiting: an ambiguous DB response must not trigger a second
  // settlement with different facts or another paid model request.
  call.settled = true;
  const reportedMicrousd = finiteRate(reportedCostUsd) &&
    Number.isSafeInteger(Math.ceil(reportedCostUsd * USD_MICROS))
    ? Math.ceil(reportedCostUsd * USD_MICROS)
    : null;
  try {
    await call.scope.ledger.settle(call.reservation, { actualMicrousd: reportedMicrousd ?? call.reservation.reservedMicrousd });
  } catch (error) {
    const failure = budgetFailure(
      error, 'settlement_failed', 'the provider charge could not be saved; further paid work is stopped.',
    );
    call.scope.stopped = failure;
    throw failure;
  }
}
