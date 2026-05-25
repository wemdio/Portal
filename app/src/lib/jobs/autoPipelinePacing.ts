/**
 * Pacing calculator для ночного режима парсинга.
 *
 * При parse_pacing='nightly' оркестратор не делает burst-прогон за 35 минут,
 * а растягивает enrichment-фазу на окно [parse_window_start_utc..parse_window_end_utc].
 * Это снижает мгновенную нагрузку на HH/Mailganer/целевые сайты с пиковых 4 RPS
 * до 0.3-0.5 RPS равномерно и почти исключает риск 429.
 *
 * Окно может пересекать полночь UTC (например, start=21, end=3 → 21:00-03:00 UTC =
 * 00:00-06:00 МСК) — это нормальный кейс «работаем ночью по Москве».
 */

export interface PacingWindow {
  startHourUtc: number;
  endHourUtc: number;
}

export interface PacingDecision {
  /** Если false — текущее время вне окна; парсинг скипается. */
  inWindow: boolean;
  /** ISO-таймстамп когда окно закончится. Полезно для логов. */
  windowEndsAt: string | null;
  /**
   * Сколько миллисекунд паузить ПОСЛЕ каждого обогащённого employer'а внутри
   * worker pool. Каждый из `concurrency` worker'ов соблюдает её независимо.
   * При burst-режиме всегда 0.
   */
  perItemPauseMs: number;
}

export interface CalcPacingInput {
  pacing: 'burst' | 'nightly' | 'continuous';
  window: PacingWindow;
  /** Сколько employer'ов в очереди на enrichment. */
  itemCount: number;
  /** Параллельность worker pool в enrichEmployers. */
  concurrency: number;
  /** Текущее время — параметр для тестирования. */
  now?: Date;
  /**
   * Запас в конце окна (миллисекунды), чтобы прогон гарантированно завершился
   * до end_utc. Default 60 секунд.
   */
  safetyMarginMs?: number;
}

/**
 * Возвращает количество миллисекунд от now до ближайшего следующего часа
 * `targetHourUtc` (включая сегодня если ещё не наступил). Если уже прошло
 * сегодня — это завтра в targetHourUtc.
 */
export function msUntilNextUtcHour(targetHourUtc: number, now: Date): number {
  const next = new Date(now);
  next.setUTCHours(targetHourUtc, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

/**
 * Текущее время внутри ночного окна [start..end]? Окно может пересекать
 * полночь, например start=21 (21:00 UTC), end=3 (03:00 UTC) → окно с 21:00
 * до 03:00 следующего дня UTC.
 */
export function isInsideWindow(window: PacingWindow, now: Date): boolean {
  const hour = now.getUTCHours();
  if (window.startHourUtc === window.endHourUtc) {
    // Вырожденный кейс — окно нулевой длины. Считаем что не внутри.
    return false;
  }
  if (window.startHourUtc < window.endHourUtc) {
    // Окно не пересекает полночь, например 02:00-06:00 UTC.
    return hour >= window.startHourUtc && hour < window.endHourUtc;
  }
  // Окно пересекает полночь, например 21:00-03:00 UTC.
  return hour >= window.startHourUtc || hour < window.endHourUtc;
}

export function calcPacing(input: CalcPacingInput): PacingDecision {
  const now = input.now ?? new Date();
  const safety = input.safetyMarginMs ?? 60_000;

  if (input.pacing === 'burst') {
    return { inWindow: true, windowEndsAt: null, perItemPauseMs: 0 };
  }

  if (input.pacing !== 'nightly') {
    // continuous пока не поддержан — fallback на burst чтобы не блокировать.
    return { inWindow: true, windowEndsAt: null, perItemPauseMs: 0 };
  }

  // Nightly. Проверяем что мы вообще в окне — если нет, парсинг скипается
  // (cron должен запускаться в начале окна; «вне окна» — это аварийная ветка).
  if (!isInsideWindow(input.window, now)) {
    return { inWindow: false, windowEndsAt: null, perItemPauseMs: 0 };
  }

  const msUntilEnd = msUntilNextUtcHour(input.window.endHourUtc, now);
  const windowEndsAt = new Date(now.getTime() + msUntilEnd).toISOString();
  const usableMs = msUntilEnd - safety;

  if (input.itemCount <= 0 || usableMs <= 0) {
    return { inWindow: true, windowEndsAt, perItemPauseMs: 0 };
  }

  // Каждый из `concurrency` worker'ов обрабатывает ~itemCount/concurrency items.
  // Чтобы общий прогон завершился за usableMs:
  //   perWorkerItems × (avgWork + pause) ≤ usableMs
  // avgWork оценить сложно (зависит от сайта, scrape и т.д.), поэтому считаем
  // консервативно — всю длительность окна делим на «слоты» равные количеству
  // items, и из каждого слота вычитаем эмпирическое avgWork=3s. Остаток — pause.
  const perWorkerSlot = (usableMs * input.concurrency) / input.itemCount;
  const EMPIRICAL_AVG_WORK_MS = 3_000;
  const perItemPauseMs = Math.max(0, Math.floor(perWorkerSlot - EMPIRICAL_AVG_WORK_MS));

  return { inWindow: true, windowEndsAt, perItemPauseMs };
}
