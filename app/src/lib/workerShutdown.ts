/**
 * Process-wide «мы останавливаемся» флаг, общий для воркер-скриптов
 * (`app/worker/*.ts`) и библиотечного кода, который они выполняют
 * (`app/src/lib/**`).
 *
 * Зачем (инцидент 11.08.2026, деплой 15:10): baseConstructor-воркер на SIGTERM
 * backdate'ит `started_at` своих in-flight job'ов, чтобы следующая реплика
 * подобрала их на ближайшем poll tick, а не через BASE_CONSTRUCTOR_STALE_MINUTES
 * (15 мин на проде). Но job'ы продолжают крутиться весь docker stop grace (~10с),
 * и их heartbeat — `updateJobProgress` — писал `started_at = now()` обратно,
 * отменяя backdate. Все три job'а того деплоя прождали полные 15 минут и
 * подняли алерт «Долго висит» ровно за секунду до самоподбора.
 *
 * Контракт: флаг односторонний. Процесс, получивший SIGTERM, не «оживает» —
 * поэтому сбрасывать его в проде незачем и нельзя (иначе heartbeat снова
 * начнёт затирать backdate).
 */

let shuttingDown = false;

/** Вызывается из SIGTERM/SIGINT-хэндлера воркера ДО любой async-работы. */
export function markShuttingDown(): void {
  shuttingDown = true;
}

/**
 * true — процесс получил сигнал остановки. Код, который пишет heartbeat'ы,
 * обязан это проверять: писать «я жив» во время shutdown — враньё, из-за
 * которого работа простаивает до stale-порога.
 */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** @internal — только для тестов; в проде флаг односторонний. */
export function __resetShutdownStateForTests(): void {
  shuttingDown = false;
}
