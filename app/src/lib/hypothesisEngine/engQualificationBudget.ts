import { z } from 'zod';
import type { LLMMessage } from './llm';

/** ENG qualification owns its model; shared HE_MODEL_* overrides cannot make it expensive. */
export const HE_ENG_QUALIFICATION_MODEL = 'deepinfra/deepseek-v4-flash-0731' as const;
export const HE_ENG_QUALIFICATION_BUDGET_USD = 0.50;
export const HE_ENG_QUALIFICATION_SEARCH_LIMIT = 0;

const USD_MICROS = 1_000_000;
const LIMIT_MICROS = 500_000;
const MAX_OUTPUT_TOKENS = 16_384;
// Rates verified 2026-10-20: $0.09/$0.18 per million input/output tokens.
// https://router.requesty.ai/v1/models (input_price=9e-8, output_price=1.8e-7;
// one pricing tier). Reserve ignores cache discounts and includes a 2x cushion
// covering Requesty's documented 5% markup (https://www.requesty.ai/pricing).
// These are an explicit pricing assumption, not a live provider price guarantee.
// Reserve twice that rate, count every UTF-8 byte as a possible input token,
// and include framing headroom. This API requires transportRetries: 0 and no
// schema repair; any additional paid call needs its own persisted reservation.
const INPUT_RATE_HUNDREDTHS = 9;
const OUTPUT_RATE_HUNDREDTHS = 18;
const RATE_CUSHION = 2;

export type HeEngQualificationBudgetHoldReason =
  | 'model_budget_exhausted'
  | 'model_cost_exceeded_reservation';

const MicrosSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ReservationSchema = z.object({
  reservedMicrousd: MicrosSchema.positive(),
  actualMicrousd: MicrosSchema.optional(),
}).strict();

export const HeEngQualificationBudgetSchema = z.object({
  version: z.literal(1),
  model: z.literal(HE_ENG_QUALIFICATION_MODEL),
  limitMicrousd: z.literal(LIMIT_MICROS),
  searchLimit: z.literal(HE_ENG_QUALIFICATION_SEARCH_LIMIT),
  searchCalls: z.literal(0),
  nextReservationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** Known completed charges plus the full reserve of calls with an unknown outcome. */
  reservedMicrousd: MicrosSchema,
  actualMicrousd: MicrosSchema,
  reservations: z.record(z.string(), ReservationSchema),
  holdReason: z.enum(['model_budget_exhausted', 'model_cost_exceeded_reservation']).nullable(),
}).strict().superRefine((value, ctx) => {
  let reserved = 0;
  let actual = 0;
  let overReservation = false;
  const entries = Object.entries(value.reservations);
  for (const [key, item] of entries) {
    if (!/^[1-9][0-9]*$/.test(key) || !Number.isSafeInteger(Number(key)) || Number(key) >= value.nextReservationId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid reservation identity' });
    }
    reserved += item.actualMicrousd ?? item.reservedMicrousd;
    actual += item.actualMicrousd ?? 0;
    overReservation ||= (item.actualMicrousd ?? 0) > item.reservedMicrousd;
  }
  if (entries.length !== value.nextReservationId - 1 || reserved !== value.reservedMicrousd ||
      actual !== value.actualMicrousd || !Number.isSafeInteger(reserved) || !Number.isSafeInteger(actual)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Qualification budget totals do not match reservations' });
  }
  if ((overReservation || reserved > LIMIT_MICROS) && value.holdReason !== 'model_cost_exceeded_reservation') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unexpected provider charge must hold further calls' });
  }
});

/** Persist inside HeEngQualificationMemo.economy.budget, never a per-tick counter. */
export type HeEngQualificationBudget = z.infer<typeof HeEngQualificationBudgetSchema>;

export class HeEngQualificationBudgetError extends Error {
  readonly heJobTerminal = true as const;

  constructor(readonly code: 'unsupported_model' | 'invalid_budget' | 'missing_budget_history' | 'invalid_model_input') {
    super(`ENG company qualification: ${code}; review the saved qualification budget before continuing.`);
    this.name = 'HeEngQualificationBudgetError';
  }
}

function assertBudget(value: unknown): asserts value is HeEngQualificationBudget {
  if (value && typeof value === 'object' && 'model' in value && value.model !== HE_ENG_QUALIFICATION_MODEL) {
    throw new HeEngQualificationBudgetError('unsupported_model');
  }
  if (!HeEngQualificationBudgetSchema.safeParse(value).success) {
    throw new HeEngQualificationBudgetError('invalid_budget');
  }
}

/** Missing budget on an already paid legacy memo is not permission for a fresh allowance. */
export function readHeEngQualificationBudget(
  value?: unknown,
  options: { hasPaidHistory?: boolean } = {},
): HeEngQualificationBudget {
  if (value === undefined) {
    if (options.hasPaidHistory) throw new HeEngQualificationBudgetError('missing_budget_history');
    return {
      version: 1,
      model: HE_ENG_QUALIFICATION_MODEL,
      limitMicrousd: LIMIT_MICROS,
      searchLimit: HE_ENG_QUALIFICATION_SEARCH_LIMIT,
      searchCalls: 0,
      nextReservationId: 1,
      reservedMicrousd: 0,
      actualMicrousd: 0,
      reservations: {},
      holdReason: null,
    };
  }
  assertBudget(value);
  return HeEngQualificationBudgetSchema.parse(value);
}

export interface HeEngQualificationModelReservation {
  id: string;
  reservedMicrousd: number;
  model: typeof HE_ENG_QUALIFICATION_MODEL;
  maxTokens: number;
  transportRetries: 0;
}

export function heEngQualificationBudgetHoldReason(
  budget: HeEngQualificationBudget,
): HeEngQualificationBudgetHoldReason | null {
  assertBudget(budget);
  return budget.holdReason ?? (budget.reservedMicrousd >= budget.limitMicrousd ? 'model_budget_exhausted' : null);
}

/**
 * Mutates the shared memo synchronously, before any await. The caller MUST await
 * its durable checkpoint before sending this exact prompt/output limit through
 * callLLMText with the returned model and transportRetries. No global hook is
 * replaced, and RU's ordinary onSpend/accounting remains untouched.
 */
export function reserveHeEngQualificationModel(
  budget: HeEngQualificationBudget,
  messages: readonly LLMMessage[],
  maxTokens: number,
): HeEngQualificationModelReservation | null {
  assertBudget(budget);
  if (heEngQualificationBudgetHoldReason(budget)) return null;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_OUTPUT_TOKENS ||
      !Array.isArray(messages) || !messages.length || messages.some((message) =>
        !message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')) {
    throw new HeEngQualificationBudgetError('invalid_model_input');
  }
  // Includes the optional JSON-mode hint added by llm.ts when the prompt omits JSON.
  const inputTokenBound = 512 + messages.reduce((sum, message) => sum + Buffer.byteLength(message.content, 'utf8') + 64, 0);
  // Keep the bounded qualification input contract even though this provider
  // currently has a larger context window and a single pricing tier.
  if (inputTokenBound > 272_000) throw new HeEngQualificationBudgetError('invalid_model_input');
  const reservedMicrousd = Math.ceil(RATE_CUSHION *
    (inputTokenBound * INPUT_RATE_HUNDREDTHS + maxTokens * OUTPUT_RATE_HUNDREDTHS) / 100);
  if (!Number.isSafeInteger(reservedMicrousd) || reservedMicrousd > budget.limitMicrousd - budget.reservedMicrousd) {
    budget.holdReason = 'model_budget_exhausted';
    return null;
  }
  const id = String(budget.nextReservationId++);
  budget.reservations[id] = { reservedMicrousd };
  budget.reservedMicrousd += reservedMicrousd;
  return { id, reservedMicrousd, model: HE_ENG_QUALIFICATION_MODEL, maxTokens, transportRetries: 0 };
}

/**
 * A successful single-transport answer with known usage releases excess reserve.
 * Error/abort or absent/invalid usage keeps the full reserve. Pass actual reported
 * usage only, never an unknown cost represented as zero. Idempotent on replay.
 */
export function settleHeEngQualificationModel(
  budget: HeEngQualificationBudget,
  reservation: HeEngQualificationModelReservation,
  costUsd?: number,
): void {
  assertBudget(budget);
  const saved = budget.reservations[reservation.id];
  if (!saved || saved.reservedMicrousd !== reservation.reservedMicrousd ||
      reservation.model !== HE_ENG_QUALIFICATION_MODEL || reservation.transportRetries !== 0) {
    throw new HeEngQualificationBudgetError('invalid_budget');
  }
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0) return;
  const actualMicrousd = Math.ceil(costUsd * USD_MICROS);
  if (!Number.isSafeInteger(actualMicrousd)) throw new HeEngQualificationBudgetError('invalid_budget');
  if (saved.actualMicrousd !== undefined) {
    if (saved.actualMicrousd !== actualMicrousd) throw new HeEngQualificationBudgetError('invalid_budget');
    return;
  }
  if (!Number.isSafeInteger(budget.actualMicrousd + actualMicrousd)) throw new HeEngQualificationBudgetError('invalid_budget');
  saved.actualMicrousd = actualMicrousd;
  budget.actualMicrousd += actualMicrousd;
  budget.reservedMicrousd += actualMicrousd - saved.reservedMicrousd;
  if (actualMicrousd > saved.reservedMicrousd) budget.holdReason = 'model_cost_exceeded_reservation';
}
