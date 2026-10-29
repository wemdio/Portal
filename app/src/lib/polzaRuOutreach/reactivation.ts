/** Общая квота старых сделок AMO и следующих шагов каскада: не больше 20%. */
const REACTIVATION_DENOMINATOR = 5;

export interface ReactivationPool {
  /** Компании в очереди, которым ещё не ушло первое письмо текущей цепочки. */
  remaining: number;
  reactivation: number;
}

export function isReactivation(row: { prior_contact?: boolean | null; cascade_no?: number | null }): boolean {
  return row.prior_contact === true || (row.cascade_no ?? 1) > 1;
}

/** Плановая квота запуска с учётом уже накопленной очереди. Округление только вниз. */
export function reactivationLimit(target: number, pool?: ReactivationPool): number {
  const limit = Math.floor(Math.max(0, target) / REACTIVATION_DENOMINATOR);
  if (!pool) return limit;
  return Math.max(0, Math.min(limit, Math.floor((pool.remaining + target) / REACTIVATION_DENOMINATOR) - pool.reactivation));
}

/**
 * Квота по фактически готовым новым компаниям: на четыре новых — одна старая.
 * Неуспешный или неполный сбор не разрешает увеличить долю реактивации.
 * Если в очереди уже избыток старых, сначала добираем новые для его покрытия.
 */
export function reactivationAllowance(target: number, freshReady: number, pool?: ReactivationPool): number {
  const batch = Math.min(reactivationLimit(target, pool), Math.floor(Math.max(0, freshReady) / (REACTIVATION_DENOMINATOR - 1)));
  if (!pool) return batch;
  const freshInPool = Math.max(0, pool.remaining - pool.reactivation);
  return Math.max(0, Math.min(batch, Math.floor((freshInPool + freshReady) / (REACTIVATION_DENOMINATOR - 1)) - pool.reactivation));
}
