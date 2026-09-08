import { extractEmails } from '@/lib/tools/dfybUtils';

const terminalEmail = new Set(['ok', 'invalid', 'disposable', 'catch_all']);

/** A cell-level result must never be attached to a different saved address. */
export function singleVeSavedEmail(row: Record<string, unknown>): string | null {
  const emails = extractEmails(String(row.email ?? ''));
  // Constructor output has one address per row. Raw multi-address source cells
  // remain evidence only until a separate, per-address validation handles them.
  return emails.length === 1 ? emails[0] : null;
}

/** Pure UI/worker eligibility: retry inconclusive results, not confirmed refusals. */
export function needsVeSavedEmailReview(row: Record<string, unknown>): boolean {
  const relevance = row._ve_relevance as { status?: unknown } | undefined;
  return String(row._low_relevance ?? '') !== 'true' && relevance?.status !== 'irrelevant'
    && !terminalEmail.has(String(row._email_status ?? '').trim().toLowerCase())
    && singleVeSavedEmail(row) !== null;
}
