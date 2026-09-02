/**
 * Checkpoint-only column used to remember that a website was attempted even
 * when it returned no description. Without it a restart cannot distinguish a
 * failed/empty attempt from a row that has never been processed and retries
 * the slow tail from zero.
 *
 * It must never reach another step or a user-facing API/export. Keep the exact
 * name versioned so old checkpoints remain readable if the representation
 * changes.
 */
export const ENRICH_CHECKPOINT_ATTEMPTED_COL = '__portal_enrich_attempted_v1';

/**
 * Private per-row state for the long-running `validate_emails` step.
 *
 * Public "... Статус" columns only contain the best aggregate verdict for a
 * cell. They cannot tell a resumed worker how many times each address in a
 * multi-email cell was already probed. Persisting that state prevents a
 * redeploy from resetting the retry budget and probing the same greylisted
 * address forever.
 */
export const EMAIL_VALIDATION_CHECKPOINT_STATE_COL =
  '__portal_email_validation_state_v1';

/** One initial SMTP probe plus one retry for a transient/unknown response. */
export const EMAIL_VALIDATION_MAX_ATTEMPTS = 2;

export type EmailValidationCheckpointResult =
  | 'ok'
  | 'invalid'
  | 'disposable'
  | 'catch_all'
  | 'unknown'
  | 'error';

export interface EmailValidationCheckpointEntry {
  attempts: number;
  result: EmailValidationCheckpointResult;
  isFree: boolean;
  isCatchAll: boolean;
  errorText: string;
}

export type EmailValidationCheckpointState = Record<
  string,
  EmailValidationCheckpointEntry
>;

const EMAIL_VALIDATION_RESULTS = new Set<EmailValidationCheckpointResult>([
  'ok',
  'invalid',
  'disposable',
  'catch_all',
  'unknown',
  'error',
]);

/** Parse untrusted checkpoint JSON defensively; malformed entries are ignored. */
export function parseEmailValidationCheckpointState(
  raw: string | null | undefined,
): EmailValidationCheckpointState {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const state: EmailValidationCheckpointState = {};
  for (const [rawEmail, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const result = entry.result;
    const attempts = Number(entry.attempts);
    const email = rawEmail.trim().toLowerCase();
    if (!email || typeof result !== 'string' || !EMAIL_VALIDATION_RESULTS.has(
      result as EmailValidationCheckpointResult,
    )) continue;
    if (!Number.isFinite(attempts) || attempts < 1) continue;
    state[email] = {
      attempts: Math.min(EMAIL_VALIDATION_MAX_ATTEMPTS, Math.trunc(attempts)),
      result: result as EmailValidationCheckpointResult,
      isFree: entry.isFree === true,
      isCatchAll: entry.isCatchAll === true,
      errorText: typeof entry.errorText === 'string' ? entry.errorText.slice(0, 500) : '',
    };
  }
  return state;
}

/** Stable JSON keeps checkpoint patches deterministic and easy to inspect. */
export function serializeEmailValidationCheckpointState(
  state: EmailValidationCheckpointState,
): string {
  const sorted: EmailValidationCheckpointState = {};
  for (const email of Object.keys(state).sort()) sorted[email] = state[email];
  return Object.keys(sorted).length > 0 ? JSON.stringify(sorted) : '';
}

/** Remove selected private checkpoint columns without mutating the row matrix. */
function stripCheckpointColumns(
  data: string[][],
  privateColumns: ReadonlySet<string>,
): string[][] {
  const header = data[0];
  if (!header) return data;
  const metadataIndexes = new Set<number>();
  header.forEach((column, index) => {
    if (privateColumns.has(column)) metadataIndexes.add(index);
  });
  if (metadataIndexes.size === 0) return data;
  return data.map((row) => row.filter((_value, index) => !metadataIndexes.has(index)));
}

/** Remove the enrichment marker without mutating the stored row matrix. */
export function stripEnrichCheckpointMetadata(data: string[][]): string[][] {
  return stripCheckpointColumns(data, new Set([ENRICH_CHECKPOINT_ATTEMPTED_COL]));
}

/** Remove durable email-validation state once that step no longer needs it. */
export function stripEmailValidationCheckpointMetadata(data: string[][]): string[][] {
  return stripCheckpointColumns(data, new Set([EMAIL_VALIDATION_CHECKPOINT_STATE_COL]));
}

/**
 * Remove every known private Base Constructor column at a user-facing
 * boundary. Unlike `stripEnrichCheckpointMetadata`, this must not be used by
 * the worker before resuming `validate_emails`: that step needs its state.
 */
export function stripBaseConstructorCheckpointMetadata(data: string[][]): string[][] {
  return stripCheckpointColumns(data, new Set([
    ENRICH_CHECKPOINT_ATTEMPTED_COL,
    EMAIL_VALIDATION_CHECKPOINT_STATE_COL,
  ]));
}
