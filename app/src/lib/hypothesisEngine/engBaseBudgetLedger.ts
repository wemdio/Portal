import type { SupabaseClient } from '@supabase/supabase-js';

/** One durable allowance for an ENG base: collection, analysis and final letters. */
export const HE_ENG_BASE_BUDGET_USD = 5;
export const HE_ENG_BASE_BUDGET_MICROUSD = 5_000_000;

export type HeEngBaseBudgetReason =
  | 'budget_exhausted'
  | 'unknown_cost'
  | 'invalid_ledger'
  | 'missing_history'
  | 'unavailable';

export class HeEngBaseBudgetError extends Error {
  readonly heJobTerminal = true as const;
  readonly heEngBaseBudgetError = true as const;

  constructor(readonly reason: HeEngBaseBudgetReason) {
    // Persisted in he_jobs/base errors and projected to the client. Never include
    // database errors, provider responses, addresses or credentials in this text.
    super(`ENG base budget: ${reason}. Paid work stopped to protect the $5 limit for this base.`);
    this.name = 'HeEngBaseBudgetError';
  }
}

export function isHeEngBaseBudgetError(value: unknown): value is HeEngBaseBudgetError {
  const seen = new Set<object>();
  let current = value;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    if ('heEngBaseBudgetError' in current && current.heEngBaseBudgetError === true) return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

export interface HeEngBaseBudgetSnapshot {
  baseId: string;
  projectId: string;
  limitMicrousd: typeof HE_ENG_BASE_BUDGET_MICROUSD;
  actualMicrousd: number;
  /** Full unresolved reservations, including unknown charges. */
  reservedMicrousd: number;
  remainingMicrousd: number;
  holdReason: HeEngBaseBudgetReason | null;
}

export interface HeEngBaseSpendInput {
  /** Fresh UUID for one physical HTTP attempt; never reuse it to resend HTTP. */
  requestId: string;
  provider: string;
  stage: string;
  model?: string;
  reservedMicrousd: number;
}

export interface HeEngBaseSpendReservation extends HeEngBaseSpendInput {
  baseId: string;
  projectId: string;
}

export interface HeEngBaseBudgetLedger {
  readonly baseId: string;
  readonly projectId: string;
  readonly snapshot: HeEngBaseBudgetSnapshot;
  reserve(input: HeEngBaseSpendInput): Promise<HeEngBaseSpendReservation>;
  /** Null means the charge is unknown; it never means zero. */
  settle(
    reservation: HeEngBaseSpendReservation,
    outcome: { actualMicrousd: number | null },
  ): Promise<HeEngBaseBudgetSnapshot>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL = /^[a-z][a-z0-9_.-]{0,63}$/;
const REASONS = new Set<HeEngBaseBudgetReason>([
  'budget_exhausted', 'unknown_cost', 'invalid_ledger', 'missing_history', 'unavailable',
]);

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseSnapshot(value: unknown, baseId: string, projectId: string): HeEngBaseBudgetSnapshot {
  if (!value || typeof value !== 'object') throw new HeEngBaseBudgetError('invalid_ledger');
  const row = value as Record<string, unknown>;
  if (row.baseId !== baseId || row.projectId !== projectId ||
      row.limitMicrousd !== HE_ENG_BASE_BUDGET_MICROUSD ||
      !integer(row.actualMicrousd) || !integer(row.reservedMicrousd) ||
      !Number.isSafeInteger(row.actualMicrousd + row.reservedMicrousd) ||
      !integer(row.remainingMicrousd) ||
      row.remainingMicrousd !== Math.max(0, HE_ENG_BASE_BUDGET_MICROUSD - row.actualMicrousd - row.reservedMicrousd) ||
      !(row.holdReason === null || REASONS.has(row.holdReason as HeEngBaseBudgetReason))) {
    throw new HeEngBaseBudgetError('invalid_ledger');
  }
  if (row.actualMicrousd + row.reservedMicrousd > HE_ENG_BASE_BUDGET_MICROUSD && row.holdReason !== 'invalid_ledger') {
    throw new HeEngBaseBudgetError('invalid_ledger');
  }
  return row as unknown as HeEngBaseBudgetSnapshot;
}

interface RpcResult {
  code: string;
  snapshot?: HeEngBaseBudgetSnapshot;
}

async function call(
  db: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
  baseId: string,
  projectId: string,
): Promise<RpcResult> {
  let result: { data: unknown; error: unknown };
  try {
    result = await db.rpc(name, args);
  } catch {
    throw new HeEngBaseBudgetError('unavailable');
  }
  if (result.error) throw new HeEngBaseBudgetError('unavailable');
  if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) {
    throw new HeEngBaseBudgetError('invalid_ledger');
  }
  const row = result.data as Record<string, unknown>;
  if (typeof row.code !== 'string') throw new HeEngBaseBudgetError('invalid_ledger');
  const snapshot = row.budget == null ? undefined : parseSnapshot(row.budget, baseId, projectId);
  return { code: row.code, snapshot };
}

function refused(code: string): never {
  throw new HeEngBaseBudgetError(REASONS.has(code as HeEngBaseBudgetReason)
    ? code as HeEngBaseBudgetReason
    : code === 'pending_spend' ? 'unknown_cost' : 'invalid_ledger');
}

/**
 * Open once per worker stage/context, before any paid work. A new context may
 * not proceed past unresolved calls left by an interrupted previous context.
 * RPCs recheck base/project/client ownership; market='us' alone is insufficient.
 * There is deliberately no reset, release-on-timeout or local-memory fallback.
 */
export async function openHeEngBaseBudget(
  db: SupabaseClient,
  baseId: string,
  projectId: string,
): Promise<HeEngBaseBudgetLedger> {
  if (!UUID.test(baseId) || !UUID.test(projectId)) throw new HeEngBaseBudgetError('invalid_ledger');
  const opened = await call(db, 'he_eng_base_budget_begin', {
    p_base_id: baseId, p_project_id: projectId,
  }, baseId, projectId);
  if (opened.code !== 'ready') refused(opened.code);
  if (!opened.snapshot) throw new HeEngBaseBudgetError('invalid_ledger');
  if (opened.snapshot.holdReason) refused(opened.snapshot.holdReason);
  let snapshot = opened.snapshot;

  return {
    baseId,
    projectId,
    get snapshot() { return { ...snapshot }; },
    async reserve(input) {
      if (!UUID.test(input.requestId) || !LABEL.test(input.provider) || !LABEL.test(input.stage) ||
          (input.model !== undefined && (typeof input.model !== 'string' || input.model.length < 1 || input.model.length > 200 ||
            /[\u0000-\u001f\u007f]/.test(input.model))) ||
          !integer(input.reservedMicrousd) || input.reservedMicrousd === 0) {
        throw new HeEngBaseBudgetError('invalid_ledger');
      }
      const result = await call(db, 'he_eng_base_budget_reserve', {
        p_base_id: baseId, p_project_id: projectId, p_request_id: input.requestId,
        p_provider: input.provider, p_stage: input.stage, p_model: input.model ?? null,
        p_reserved_microusd: input.reservedMicrousd,
      }, baseId, projectId);
      // A replayed reservation is durable evidence of an earlier attempt,
      // never permission for a second paid request.
      if (result.code !== 'reserved') refused(result.code);
      if (!result.snapshot) throw new HeEngBaseBudgetError('invalid_ledger');
      if (result.snapshot.holdReason) refused(result.snapshot.holdReason);
      snapshot = result.snapshot;
      return { ...input, baseId, projectId };
    },
    async settle(reservation, outcome) {
      if (reservation.baseId !== baseId || reservation.projectId !== projectId ||
          !UUID.test(reservation.requestId) || !integer(reservation.reservedMicrousd) ||
          (outcome.actualMicrousd !== null && !integer(outcome.actualMicrousd))) {
        throw new HeEngBaseBudgetError('invalid_ledger');
      }
      const result = await call(db, 'he_eng_base_budget_settle', {
        p_base_id: baseId, p_project_id: projectId, p_request_id: reservation.requestId,
        p_reserved_microusd: reservation.reservedMicrousd,
        p_actual_microusd: outcome.actualMicrousd,
      }, baseId, projectId);
      if (!result.snapshot) refused(result.code);
      snapshot = result.snapshot;
      if (result.code !== 'settled') refused(result.code);
      if (snapshot.holdReason) refused(snapshot.holdReason);
      return { ...snapshot };
    },
  };
}
