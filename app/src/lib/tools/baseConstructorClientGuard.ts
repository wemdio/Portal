/**
 * Client-mode guard for the Base Constructor pipeline.
 *
 * For users with role === 'client' we:
 *   - automatically include a fixed set of "always-on" cleaning/enrichment steps
 *     (so the client doesn't have to think about them, and so the resulting base is
 *     consistently usable for outreach), and
 *   - reject jobs whose row count exceeds CLIENT_ROW_LIMIT (cost protection).
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
 * Maximum number of data rows (header excluded) a client may submit in a single
 * Base Constructor job. Protects us from runaway AI/API spend.
 */
export const CLIENT_ROW_LIMIT = 10_000;

export type ApplyClientGuardInput = {
  role: string | null | undefined;
  selectedSteps: readonly StepKey[];
  rowCount: number;
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

  if (input.rowCount > CLIENT_ROW_LIMIT) {
    return {
      ok: false,
      error: `Лимит 10 000 строк для клиентского доступа. В файле ${input.rowCount.toLocaleString('ru-RU')} строк.`,
    };
  }

  const merged = new Set<StepKey>(input.selectedSteps);
  for (const step of ALWAYS_ON_STEPS_FOR_CLIENT) {
    merged.add(step);
  }
  return { ok: true, selectedSteps: [...merged] };
}
