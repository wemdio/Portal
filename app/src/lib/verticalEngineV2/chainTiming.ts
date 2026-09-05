import { VE_CHAIN_MAX_WAIT_DAYS } from './chainLetters';

/** Gaps after the previous email, not offsets from the first email. */
export const VE_CHAIN_DEFAULT_WAIT_DAYS = [0, 1, 3, 5, 7, 9] as const;

export function getVeChainWaitDays(index: number): number {
  const position = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0;
  return VE_CHAIN_DEFAULT_WAIT_DAYS[Math.min(position, VE_CHAIN_DEFAULT_WAIT_DAYS.length - 1)];
}

/** Keep saved timing when regenerating text; new/malformed positions use defaults. */
export function applyVeChainTiming<T>(
  letters: readonly T[],
  source?: readonly { wait_days?: number }[],
): (T & { wait_days: number })[] {
  return letters.map((letter, index) => {
    const saved = source?.[index]?.wait_days;
    const wait = typeof saved === 'number' && Number.isFinite(saved)
      ? Math.min(VE_CHAIN_MAX_WAIT_DAYS, Math.max(0, Math.trunc(saved)))
      : getVeChainWaitDays(index);
    return { ...letter, wait_days: index === 0 ? 0 : wait };
  });
}
