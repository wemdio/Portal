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

/** Remove private checkpoint columns without mutating the stored row matrix. */
export function stripEnrichCheckpointMetadata(data: string[][]): string[][] {
  const header = data[0];
  if (!header) return data;
  const metadataIndexes = new Set<number>();
  header.forEach((column, index) => {
    if (column === ENRICH_CHECKPOINT_ATTEMPTED_COL) metadataIndexes.add(index);
  });
  if (metadataIndexes.size === 0) return data;
  return data.map((row) => row.filter((_value, index) => !metadataIndexes.has(index)));
}
