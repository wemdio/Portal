/**
 * Client-mode guard for the Base Constructor pipeline.
 *
 * For users with role === 'client' we:
 *   - automatically include a fixed set of "always-on" cleaning/enrichment steps
 *     (so the client doesn't have to think about them, and so the resulting base is
 *     consistently usable for outreach), and
 *   - reject jobs whose row count exceeds the client's tariff row limit.
 *
 * For all other roles we pass through unchanged.
 *
 * NOTE: kept in a separate file (not in processingSteps.ts) so that consumers and
 * tests can import this logic without pulling in the heavy worker dependencies
 * (cheerio, scrapers, OpenRouter clients) that processingSteps.ts brings in.
 */

import type { StepKey } from '@/lib/tools/processingSteps';

/**
 * Steps that are auto-included for any client-initiated Base Constructor job.
 * Order does not matter — the worker re-sorts by priority before execution.
 */
export const ALWAYS_ON_STEPS_FOR_CLIENT: readonly StepKey[] = [
  'remove_empty',
  'dedup_full',
  'split_emails',
  'dedup_email',
  'clean_names',
  'check_sites',
  'find_emails',
  'validate_emails',
  'enrich_descriptions',
] as const;

/**
 * Fallback per-job row cap when tariff limits are not available.
 */
export const CLIENT_ROW_LIMIT = 10_000;

export type ApplyClientGuardInput = {
  role: string | null | undefined;
  selectedSteps: readonly StepKey[];
  rowCount: number;
  /** If provided, overrides the default CLIENT_ROW_LIMIT. */
  maxRows?: number;
  /**
   * When true, the client opted into MANUAL step selection ("режим выбора шагов")
   * — respect exactly what they chose and do NOT force the always-on steps.
   * The row limit still applies. Defaults to false (legacy locked behavior).
   */
  freeStepSelection?: boolean;
};

export type ApplyClientGuardResult =
  | { ok: true; selectedSteps: StepKey[] }
  | { ok: false; error: string };

export function applyClientGuard(
  input: ApplyClientGuardInput,
): ApplyClientGuardResult {
  const isClient = input.role === 'client';

  if (!isClient) {
    return { ok: true, selectedSteps: [...input.selectedSteps] };
  }

  const limit = input.maxRows ?? CLIENT_ROW_LIMIT;
  if (input.rowCount > limit) {
    return {
      ok: false,
      error: `Лимит ${limit.toLocaleString('ru-RU')} строк для клиентского доступа. В файле ${input.rowCount.toLocaleString('ru-RU')} строк.`,
    };
  }

  // Manual selection mode: keep exactly what the client picked (no forced
  // always-on steps). The row limit above still applies.
  if (input.freeStepSelection) {
    return { ok: true, selectedSteps: [...input.selectedSteps] };
  }

  const merged = new Set<StepKey>(input.selectedSteps);
  for (const step of ALWAYS_ON_STEPS_FOR_CLIENT) {
    merged.add(step);
  }
  return { ok: true, selectedSteps: [...merged] };
}
