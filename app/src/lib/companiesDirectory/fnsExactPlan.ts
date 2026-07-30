import {
  canonicalJson,
  sha256Hex,
} from '@/lib/companiesDirectory/guardedImportCore';
import { FnsExactPlanStore } from '@/lib/companiesDirectory/fnsExactPlanStore';
import {
  FNS_SME_EXACT_OKVED_SOURCE,
  type ExistingDirectoryExactOkvedRow,
  type FnsExactOkvedPlan,
  type FnsExactOkvedRegistryRow,
} from '@/lib/companiesDirectory/fnsExactPlanTypes';

export * from '@/lib/companiesDirectory/fnsExactPlanTypes';

function restoreInputIds<T extends { id: string | number }>(
  rows: T[],
  inputIds: Map<string, string | number>,
): T[] {
  return rows.map((row) => ({
    ...row,
    id: inputIds.get(String(row.id)) ?? row.id,
  }));
}

/**
 * Small in-memory facade used by tests and diagnostics.
 * The production plan and this helper intentionally share FnsExactPlanStore,
 * so OGRN-first matching rules have a single implementation.
 */
export function buildFnsExactOkvedPlan(
  registryRows: readonly FnsExactOkvedRegistryRow[],
  existingRows: readonly ExistingDirectoryExactOkvedRow[],
): FnsExactOkvedPlan {
  const store = new FnsExactPlanStore(':memory:');
  const inputIds = new Map<string, string | number>();
  try {
    store.beginSnapshot();
    for (const row of existingRows) {
      const key = String(row.id);
      if (inputIds.has(key)) {
        throw new Error(`Duplicate existing company id: ${key}`);
      }
      inputIds.set(key, row.id);
      store.addExisting(row);
    }
    store.commitSnapshot();

    store.beginRegistry();
    for (const row of registryRows) {
      store.addRegistry(row);
    }
    store.commitRegistry();

    const updates = restoreInputIds([...store.iterateUpdates()], inputIds);
    const noops = restoreInputIds([...store.iterateNoops()], inputIds);
    const conflicts = restoreInputIds([...store.iterateConflicts()], inputIds);
    const skipped = restoreInputIds([...store.iterateSkipped()], inputIds);
    const metrics = store.metrics();
    const fingerprintBody: Omit<
      FnsExactOkvedPlan,
      'fingerprint'
    > = {
      source: FNS_SME_EXACT_OKVED_SOURCE,
      updates,
      noops,
      conflicts,
      skipped,
      metrics,
    };

    return {
      ...fingerprintBody,
      fingerprint: sha256Hex(canonicalJson(fingerprintBody)),
    };
  } finally {
    store.close();
  }
}
