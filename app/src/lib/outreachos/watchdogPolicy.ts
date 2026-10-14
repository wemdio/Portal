/**
 * Политика сторожа ежедневного прогона OutreachOS (инцидент 23–24.09.2026).
 *
 * Дыра: деплой пересоздаёт portal-worker-hh и молча убивает exec'нутый прогон.
 * Лог обрывается, строка outreachos_pipeline_runs навсегда висит в `running`,
 * ничего не залито и не записано в seen. 23.09 так пропала готовая выгрузка
 * конструктора (3 649 почт), 24.09 — весь день. Процесс, который мог бы это
 * заметить, умирает вместе с прогоном, поэтому сторож — отдельный короткий
 * процесс, который крон дёргает каждые 15 минут в том же контейнере
 * (worker/outreachosWatchdogCron.ts). Образец — сторож gisSignalOutreach
 * (инцидент 12.08.2026), но здесь прогон по возможности ПРОДОЛЖАЕТСЯ с
 * контрольной точки, а не начинается заново.
 *
 * Здесь — чистое решение без IO, чтобы проверять его таблично:
 *   - есть живой процесс прогона или сторожа → ничего не трогаем;
 *   - строка `running` без процесса старше grace — труп;
 *   - самый свежий сегодняшний труп с контрольной точкой продолжаем, пока не
 *     исчерпаны попытки; остальные трупы закрываем;
 *   - без точки продолжения — закрываем и решаем, перезапускать ли день.
 *
 * Перезапуск дня зажат со всех сторон — это повторные HH и конструктор и
 * лишний объём в кампаниях: только окно 05:30–14:00 МСК, только если сегодня
 * нет успешного прогона и нет прогона, упавшего по своей причине, не больше
 * MAX_RUNS_PER_DAY строк за сутки и не после исчерпанных продолжений.
 *
 * Время считаем явно в Europe/Moscow: контейнеры живут с TZ=UTC.
 */

/** Строка `running` моложе этого возраста не трогается: возможна гонка со стартом. */
export const WATCHDOG_GRACE_MS = 10 * 60_000;
/** Потолок строк прогона за сутки — предохранитель от петли перезапусков. */
export const MAX_RUNS_PER_DAY = 3;
/** Столько раз продолжаем один прогон; дальше считаем, что его убивает не деплой. */
export const MAX_RESUME_ATTEMPTS = 3;
/** Окно перезапуска дня в МСК: крон стартует в 05:15, позже 14:00 день уже не спасти. */
export const RESTART_WINDOW_MSK = { fromMinutes: 5 * 60 + 30, toMinutes: 14 * 60 };
/** Префикс error_message закрытых сторожем строк: «убит извне», а не ошибка прогона. */
export const WATCHDOG_REAP_PREFIX = 'watchdog:';

export interface MskParts {
  /** Минуты от полуночи по Москве. */
  minutes: number;
  /** 'YYYY-MM-DD' по Москве — ключ «сегодня». */
  dateKey: string;
}

export function mskParts(now: Date): MskParts {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  // hour '24' у en-CA/hour12:false в полночь — нормализуем в 0.
  const hour = Number(parts.hour) % 24;
  return { minutes: hour * 60 + Number(parts.minute), dateKey: `${parts.year}-${parts.month}-${parts.day}` };
}

/** Момент московской полуночи сегодняшних суток (Москва без DST, всегда +03:00). */
export function mskMidnightIso(now: Date): string {
  return new Date(`${mskParts(now).dateKey}T00:00:00+03:00`).toISOString();
}

export interface WatchdogRunningRun {
  id: string;
  started_at: string;
  /** Контрольная точка прогона; null — продолжать не с чего. */
  checkpoint: { phase: 'constructor' | 'upload'; resumeAttempts: number } | null;
}

export interface WatchdogTodayRun {
  id: string;
  status: string;
  error_message: string | null;
}

export interface WatchdogInput {
  now: Date;
  /** Строки outreachos_pipeline_runs со status='running'. */
  runningRuns: WatchdogRunningRun[];
  /**
   * Есть ли в контейнере живой процесс прогона или другого сторожа. Неизвестно
   * (не смогли прочитать /proc) → передавать true: сторож молчит, когда не уверен.
   */
  liveProcess: boolean;
  /** Строки прогона за сегодняшние МСК-сутки, включая running. */
  todayRuns: WatchdogTodayRun[];
  graceMs?: number;
}

export interface WatchdogDecision {
  /** Трупы, которые надо закрыть как failed. */
  reap: WatchdogRunningRun[];
  /** Прогон, который надо продолжить с контрольной точки. */
  resume: WatchdogRunningRun | null;
  /** Запускать ли день заново. */
  restart: boolean;
  /** started_at убитого сегодняшнего прогона: перезапуск берёт HH с того же окна. */
  restartAnchor: string | null;
  /** Человекочитаемое объяснение — в лог и в TG-алерт. */
  reason: string;
}

export function decideWatchdogAction(input: WatchdogInput): WatchdogDecision {
  const graceMs = input.graceMs ?? WATCHDOG_GRACE_MS;
  const nowMs = input.now.getTime();

  if (input.liveProcess) {
    return {
      reap: [],
      resume: null,
      restart: false,
      restartAnchor: null,
      reason: input.runningRuns.length > 0
        ? 'прогон идёт (процесс жив) — не вмешиваемся'
        : 'процесс OutreachOS жив без running-строки — не вмешиваемся',
    };
  }

  // Непарсящийся started_at считаем свежим: непонятное не трогаем.
  const dead: WatchdogRunningRun[] = [];
  const tooYoung: WatchdogRunningRun[] = [];
  for (const row of input.runningRuns) {
    const age = nowMs - Date.parse(row.started_at);
    if (Number.isFinite(age) && age >= graceMs) dead.push(row);
    else tooYoung.push(row);
  }

  // Продолжаем только сегодняшний прогон: вчерашний, продолженный утром,
  // смешал бы два дня заливки и занял бы процесс к старту крона в 05:15.
  const { minutes, dateKey } = mskParts(input.now);
  const startedToday = (row: WatchdogRunningRun): boolean =>
    mskParts(new Date(row.started_at)).dateKey === dateKey;
  const resumable = dead
    .filter((row) =>
      row.checkpoint !== null &&
      row.checkpoint.resumeAttempts < MAX_RESUME_ATTEMPTS &&
      startedToday(row))
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  const resume = tooYoung.length === 0 ? resumable[0] ?? null : null;
  const reap = dead.filter((row) => row !== resume);
  const reapNote = reap.length > 0
    ? `труп прогона: ${reap.length} running-строк без живого процесса (вероятно, контейнер пересоздан деплоем)`
    : 'running-строк без живого процесса нет';

  if (resume?.checkpoint) {
    return {
      reap,
      resume,
      restart: false,
      restartAnchor: null,
      reason:
        `${reap.length > 0 ? `${reapNote}; ` : ''}прогон ${resume.id} без живого процесса — продолжаем с точки ` +
        `«${resume.checkpoint.phase}» (попытка ${resume.checkpoint.resumeAttempts + 1} из ${MAX_RESUME_ATTEMPTS})`,
    };
  }

  const reapedIds = new Set(reap.map((row) => row.id));
  const otherToday = input.todayRuns.filter((row) => !reapedIds.has(row.id));
  const completedToday = otherToday.filter((row) => row.status === 'completed').length;
  const failedOnItsOwn = otherToday.filter(
    (row) => row.status === 'failed' && !(row.error_message ?? '').startsWith(WATCHDOG_REAP_PREFIX),
  ).length;
  const reapedToday = reap
    .filter(startedToday)
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  const exhausted = reapedToday.some(
    (row) => row.checkpoint !== null && row.checkpoint.resumeAttempts >= MAX_RESUME_ATTEMPTS,
  );

  const blockers: string[] = [];
  if (tooYoung.length > 0) blockers.push(`есть running моложе ${Math.round(graceMs / 60_000)} мин`);
  if (minutes < RESTART_WINDOW_MSK.fromMinutes || minutes >= RESTART_WINDOW_MSK.toMinutes) {
    blockers.push('вне окна 05:30–14:00 МСК');
  }
  if (completedToday > 0) blockers.push('сегодня уже есть успешный прогон');
  if (failedOnItsOwn > 0) blockers.push('сегодняшний прогон упал по своей причине');
  if (input.todayRuns.length >= MAX_RUNS_PER_DAY) blockers.push(`лимит ${MAX_RUNS_PER_DAY} прогонов в сутки исчерпан`);
  if (exhausted) blockers.push(`продолжения исчерпаны (${MAX_RESUME_ATTEMPTS})`);
  if (reapedToday.length === 0 && input.todayRuns.length > 0) blockers.push('сегодняшний прогон не убит');

  if (blockers.length > 0) {
    return { reap, resume: null, restart: false, restartAnchor: null, reason: `${reapNote}; перезапуск не делаем: ${blockers.join(', ')}` };
  }
  return {
    reap,
    resume: null,
    restart: true,
    restartAnchor: reapedToday[0]?.started_at ?? null,
    reason: reapedToday.length > 0
      ? `${reapNote}; продолжать не с чего — перезапускаем день`
      : 'сегодня нет ни одного прогона и процесса нет (крон не отработал?) — запускаем день',
  };
}
