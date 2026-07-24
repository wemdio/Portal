const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Отчётное окно: последние 7 суток до момента запуска.
 * При штатном пятничном cron 17:00 МСК это ровно пт 17:00 → пт 17:00 —
 * «неделя от отчёта до отчёта», как договорились с продажами.
 */
export function currentMskWeekWindow(now: Date): {
  start: Date;
  end: Date;
} {
  const end = new Date(now);
  const start = new Date(end.getTime() - WEEK_MS);
  return { start, end };
}

export function shortMskDate(date: Date): string {
  const msk = new Date(date.getTime() + MSK_OFFSET_MS);
  const day = String(msk.getUTCDate()).padStart(2, '0');
  const month = String(msk.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}`;
}
