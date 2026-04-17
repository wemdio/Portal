/**
 * Shared constants for the signal-enrichment feature.
 * Imported by both server (applier, worker) and client (DatabaseSpreadsheet)
 * — keep this file dependency-free so it stays bundleable in both contexts.
 */

/** Marker written into the "Стек" column when a row failed to enrich. */
export const SIGNAL_ERROR_MARKER = '⚠';

/**
 * True if a "Стек" cell value is either empty or contains only the error
 * marker — both states should be considered "needs (re)processing" when
 * the user runs signals again with applyOnlyEmpty semantics.
 */
export function isStackCellRefillable(value: unknown): boolean {
  const str = String(value ?? '').trim();
  return str.length === 0 || str === SIGNAL_ERROR_MARKER;
}
