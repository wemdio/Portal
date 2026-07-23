const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Окно текущей рабочей недели: с понедельника 00:00 МСК до момента запуска.
 * При штатном запуске в пятницу 18:00 МСК это понедельник–пятница.
 */
export function currentMskWeekWindow(now: Date): {
  start: Date;
  end: Date;
} {
  const nowMsk = new Date(now.getTime() + MSK_OFFSET_MS);
  const daysSinceMonday = (nowMsk.getUTCDay() + 6) % 7;
  const mondayMskMidnight = Date.UTC(
    nowMsk.getUTCFullYear(),
    nowMsk.getUTCMonth(),
    nowMsk.getUTCDate() - daysSinceMonday,
  );

  return {
    start: new Date(mondayMskMidnight - MSK_OFFSET_MS),
    end: new Date(now),
  };
}

export function shortMskDate(date: Date): string {
  const msk = new Date(date.getTime() + MSK_OFFSET_MS);
  const day = String(msk.getUTCDate()).padStart(2, '0');
  const month = String(msk.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}`;
}
