const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Отчётное окно продаж: [прошлая пятница 17:16:00 МСК, эта пятница 17:15:59.999 МСК].
 * Штатный cron запускается в пятницу в 17:10 МСК — окно закрывается через
 * 5 минут после запуска, но SQL всё равно ловит все сделки с датой ≤ 17:15
 * (сделки после 17:15 попадут в отчёт следующей недели). Ровно 7 суток
 * от отчёта до отчёта.
 *
 * Правило `end`: ближайшая ПЯТНИЦА 17:15:59.999 МСК на этой календарной неделе
 * (не в будущем через воскресенье). Если сегодня пт — сегодня 17:15;
 * если пн-чт — прошедшая пятница; если сб-вс — прошедшая пятница.
 */
export function currentMskWeekWindow(now: Date): {
  start: Date;
  end: Date;
} {
  const nowMsk = new Date(now.getTime() + MSK_OFFSET_MS);
  const dow = nowMsk.getUTCDay(); // 0 = вс, 5 = пт
  // Сколько дней назад ближайшая пятница (сегодня если пт).
  const daysBackToFriday = dow === 5 ? 0 : (dow - 5 + 7) % 7;

  const endMskMs = Date.UTC(
    nowMsk.getUTCFullYear(),
    nowMsk.getUTCMonth(),
    nowMsk.getUTCDate() - daysBackToFriday,
    17, 15, 59, 999,
  );
  const startMskMs = Date.UTC(
    nowMsk.getUTCFullYear(),
    nowMsk.getUTCMonth(),
    nowMsk.getUTCDate() - daysBackToFriday - 7,
    17, 16, 0, 0,
  );
  return {
    start: new Date(startMskMs - MSK_OFFSET_MS),
    end: new Date(endMskMs - MSK_OFFSET_MS),
  };
}

export function shortMskDate(date: Date): string {
  const msk = new Date(date.getTime() + MSK_OFFSET_MS);
  const day = String(msk.getUTCDate()).padStart(2, '0');
  const month = String(msk.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}`;
}
