/**
 * Политика host-сторожа дневного прогона gisSignalOutreach (инцидент 12.08.2026).
 *
 * Дыра, которую он закрывает: пересоздание контейнеров при деплое молча убивает
 * exec'нутый воркер. Лог обрывается на полуслове, строка в gis_signal_runs
 * навсегда виснет в `running`, TG-алерта нет — процесса, который мог бы его
 * послать, уже не существует. 12.08 так умерли ТРИ прогона подряд (утренний
 * крон ~07:15 и два ручных перезапуска), и день был потерян целиком.
 *
 * Внутрипроцессный stall-watchdog (runGuards.createStallWatchdog) здесь бессилен
 * по построению: он живёт внутри убитого процесса. Поэтому сторож — отдельный
 * короткий процесс, который крон дёргает каждые 15 минут В ТОМ ЖЕ контейнере,
 * что и прогон: значит он видит его в /proc и может отличить «работает» от
 * «строка есть, процесса нет».
 *
 * Здесь — ЧИСТОЕ решение (без IO), чтобы всё это тестировалось таблично:
 *   - есть живой процесс → не трогаем ничего (зависший, но живой прогон — забота
 *     внутрипроцессного watchdog'а, у него свой таймер тишины);
 *   - процесса нет, строка `running` старше grace → это труп: помечаем failed;
 *   - и решаем, перезапускать ли день.
 *
 * Перезапуск НАМЕРЕННО зажат со всех сторон — цена ошибки это лишние 2000
 * проверок сайтов и лишний объём в кампаниях клиента:
 *   - только будни (крон прогона `* * 1-5`) и только окно 06:40–13:00 МСК:
 *     прогон идёт ~60–80 мин, начинать его вечером бессмысленно и вредно;
 *   - только если сегодня НЕТ успешного прогона;
 *   - не больше MAX_RUNS_PER_DAY строк за сутки — предохранитель от петли, если
 *     прогон падает детерминированно (ровно как на JSON-баге 12.08);
 *   - и только когда после реапа не осталось свежих `running` строк.
 *
 * Время считаем ЯВНО в Europe/Moscow: контейнеры живут с TZ=UTC, и наивный
 * getHours() дал бы окно, сдвинутое на три часа.
 */

import type { RunningRunRow } from './runGuards';

/** Строка `running` моложе этого возраста не реапится: возможна гонка со стартом. */
export const WATCHDOG_GRACE_MS = 10 * 60_000;
/** Потолок строк gis_signal_runs за сутки — предохранитель от петли перезапусков. */
export const MAX_RUNS_PER_DAY = 3;
/** Окно автоперезапуска в МСК: раньше — крон ещё сам не отработал, позже — день уже не спасти. */
export const RESTART_WINDOW_MSK = { fromMinutes: 6 * 60 + 40, toMinutes: 13 * 60 };

export interface MskParts {
  /** Минуты от полуночи по Москве. */
  minutes: number;
  /** 1=Пн … 7=Вс. */
  weekday: number;
  /** 'YYYY-MM-DD' по Москве — ключ «сегодня» для суточных счётчиков. */
  dateKey: string;
}

/** Разбор момента времени в московские сутки (TZ контейнера может быть любой). */
export function mskParts(now: Date): MskParts {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const weekdayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  // hour '24' у en-CA/hour12:false в полночь — нормализуем в 0.
  const hour = Number(parts.hour) % 24;
  return {
    minutes: hour * 60 + Number(parts.minute),
    weekday: weekdayMap[parts.weekday as string] ?? 0,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

export interface WatchdogInput {
  now: Date;
  /** Строки gis_signal_runs со status='running'. */
  runningRuns: RunningRunRow[];
  /**
   * Есть ли в контейнере живой процесс прогона. Неизвестно (не смогли прочитать
   * /proc) → передавать true: сторож обязан молчать, когда не уверен.
   */
  liveProcess: boolean;
  /** Всего строк gis_signal_runs за сегодняшние МСК-сутки (включая running). */
  runsToday: number;
  /** Из них завершившихся успешно. */
  completedToday: number;
  graceMs?: number;
}

export interface WatchdogDecision {
  /** Строки, которые надо пометить failed (труп прогона). */
  reap: RunningRunRow[];
  /** Запускать ли прогон заново прямо сейчас. */
  restart: boolean;
  /** Человекочитаемое объяснение — уходит в лог и в TG-алерт. */
  reason: string;
}

/**
 * Решение сторожа. Чистая функция: весь IO (чтение runs, скан /proc, апдейты,
 * запуск прогона) остаётся в worker/gisSignalWatchdogCron.ts.
 */
export function decideWatchdogAction(input: WatchdogInput): WatchdogDecision {
  const graceMs = input.graceMs ?? WATCHDOG_GRACE_MS;
  const nowMs = input.now.getTime();

  if (input.liveProcess) {
    return {
      reap: [],
      restart: false,
      reason: input.runningRuns.length > 0
        ? 'прогон идёт (процесс жив) — не вмешиваемся'
        : 'процесс gisSignal жив без running-строки — не вмешиваемся',
    };
  }

  // Непарсящийся started_at считаем СВЕЖИМ: непонятное не реапим.
  const reap: RunningRunRow[] = [];
  const tooYoung: RunningRunRow[] = [];
  for (const row of input.runningRuns) {
    const age = nowMs - Date.parse(row.started_at);
    if (Number.isFinite(age) && age >= graceMs) reap.push(row);
    else tooYoung.push(row);
  }

  const { minutes, weekday } = mskParts(input.now);
  const reapNote = reap.length > 0
    ? `труп прогона: ${reap.length} running-строк без живого процесса (вероятно, контейнер пересоздан деплоем)`
    : 'running-строк без живого процесса нет';

  const blockers: string[] = [];
  if (tooYoung.length > 0) blockers.push(`есть running моложе ${Math.round(graceMs / 60_000)}мин`);
  if (weekday > 5) blockers.push('выходной');
  if (minutes < RESTART_WINDOW_MSK.fromMinutes || minutes >= RESTART_WINDOW_MSK.toMinutes) {
    blockers.push('вне окна 06:40–13:00 МСК');
  }
  if (input.completedToday > 0) blockers.push('сегодня уже есть успешный прогон');
  if (input.runsToday >= MAX_RUNS_PER_DAY) blockers.push(`лимит ${MAX_RUNS_PER_DAY} прогонов в сутки исчерпан`);

  if (blockers.length > 0) {
    return { reap, restart: false, reason: `${reapNote}; перезапуск не делаем: ${blockers.join(', ')}` };
  }
  return {
    reap,
    restart: true,
    reason: reap.length > 0
      ? `${reapNote}; перезапускаем день`
      : 'сегодня нет ни одного прогона и процесса нет (крон не отработал?) — запускаем день',
  };
}
