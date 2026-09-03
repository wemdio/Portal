const MAX_READY_BATCH = 1000;

/** Integer allocation with the delivery portfolio's positive potential weights. */
export function allocateContactSupplyTargets(
  total: number,
  items: readonly { id: string; weight: number }[],
): Array<{ itemId: string; contacts: number }> {
  if (!Number.isSafeInteger(total) || total < 0 || new Set(items.map((item) => item.id)).size !== items.length) {
    throw new Error('Supply allocation requires a non-negative exact total and unique item identities');
  }
  if (!items.length) return [];
  const weights = items.map((item) => Number.isFinite(item.weight) ? Math.max(1, item.weight) : 1);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(totalWeight)) throw new Error('Supply allocation weights exceed the numeric range');
  const shares = weights.map((weight) => total * (weight / totalWeight));
  const counts = shares.map(Math.floor);
  const remainderOrder = items.map((item, index) => ({ index, id: item.id, remainder: shares[index] - counts[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.id.localeCompare(b.id));
  const remainder = total - counts.reduce((sum, value) => sum + value, 0);
  for (let index = 0; index < remainder; index += 1) counts[remainderOrder[index].index] += 1;
  return items.map((item, index) => ({ itemId: item.id, contacts: counts[index] }));
}

/** Existing ready inventory is factual; cap both global deficit and each batch. */
export function buildContactSupplyRequests(
  bufferTarget: number,
  items: readonly { id: string; weight: number; ready: number }[],
): Array<{ itemId: string; readyTarget: number }> {
  if (items.some((item) => !Number.isSafeInteger(item.ready) || item.ready < 0)) {
    throw new Error('Supply buffer requires exact non-negative ready counts');
  }
  const targets = allocateContactSupplyTargets(bufferTarget, items);
  const readyTotal = items.reduce((sum, item) => sum + item.ready, 0);
  if (!Number.isSafeInteger(readyTotal)) throw new Error('Supply ready count exceeds the safe integer range');
  let deficit = Math.max(0, bufferTarget - readyTotal);
  return items.flatMap((item, index) => {
    const readyTarget = Math.min(MAX_READY_BATCH, deficit, Math.max(0, targets[index].contacts - item.ready));
    deficit -= readyTarget;
    return readyTarget > 0 ? [{ itemId: item.id, readyTarget }] : [];
  });
}
