export function isLimitReached(sentToday: number, dailyLimit: number): boolean {
  return sentToday >= dailyLimit;
}

export function remainingCapacity(sentToday: number, dailyLimit: number): number {
  return Math.max(0, dailyLimit - sentToday);
}

export function usagePercent(sentToday: number, dailyLimit: number): number {
  if (dailyLimit <= 0) return 100;
  return Math.min(100, Math.round((sentToday / dailyLimit) * 100));
}
