export class VeWorkerShutdownError extends Error {
  constructor() {
    super('VE2 worker is stopping; resume the saved checkpoint after restart');
    this.name = 'VeWorkerShutdownError';
  }
}

/** Let an in-flight operation save its result before cooperative shutdown. */
export function createVeJobShutdown(options: {
  abort: AbortController;
  graceMs: number;
  immediate?: boolean;
  onDeadline: () => void;
}): { request: () => void; checkpoint: () => void; stop: () => void } {
  let requested = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => options.abort.abort(new VeWorkerShutdownError());
  return {
    request: () => {
      if (requested || stopped) return;
      requested = true;
      if (options.immediate) { abort(); return; }
      timer = setTimeout(() => {
        if (!stopped) { abort(); options.onDeadline(); }
      }, options.graceMs);
      timer.unref?.();
    },
    checkpoint: () => {
      if (requested && !stopped) abort();
      options.abort.signal.throwIfAborted();
    },
    stop: () => { stopped = true; clearTimeout(timer); },
  };
}

/** A last-resort guard for research awaits that ignore AbortSignal (e.g. a DB socket).
 * Never races the stage or starts a replacement in the same process: the caller
 * must terminate an unresponsive process so stale work cannot keep writing.
 */
export function createVeJobWatchdog(options: {
  abort: AbortController;
  idleMs: number;
  graceMs: number;
  /** Abort message prefix; keep it matching the worker's retryable-error rules. */
  reason?: string;
  /**
   * Research stages: ANY abort (cancel, shutdown) must end within `graceMs`.
   * Base stages pass false: they contain registry scans and multi-megabyte
   * writes that cannot react to a cancel within two minutes, and the process
   * runs up to 16 jobs. Only the watchdog's own timeout keeps the short grace;
   * an external abort waits a full idle period before the process is recycled.
   */
  escalateExternalAbort?: boolean;
  onTimeout: () => void;
  /** Receives the time actually waited after the abort. */
  onUnresponsive: (waitedMs: number) => void;
}): { touch: () => void; stop: () => void } {
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let timedOut = false;
  let lastTouchAt = Date.now();
  let abortedAt = 0;
  const patient = () => !timedOut && options.escalateExternalAbort === false;

  const armRecovery = () => {
    clearTimeout(recoveryTimer);
    // A patient (externally aborted base) stage keeps the idle clock it already
    // had: cancelling a job that has been silent for 19 minutes must not grant
    // it 22 more, and one that still works is never recycled earlier than it
    // would have been without the cancel.
    const wait = patient() ? Math.max(options.graceMs, lastTouchAt + options.idleMs + options.graceMs - Date.now()) : options.graceMs;
    recoveryTimer = setTimeout(() => {
      if (!stopped) options.onUnresponsive(Date.now() - abortedAt);
    }, wait);
    recoveryTimer.unref?.();
  };
  const onAbort = () => {
    clearTimeout(idleTimer);
    if (stopped || recoveryTimer) return;
    abortedAt = Date.now();
    armRecovery();
  };
  const touch = () => {
    if (stopped) return;
    if (options.abort.signal.aborted) {
      // Only a patient stage may extend its recovery deadline by still working;
      // an expired or research operation is never revived by a late read/log.
      if (patient() && recoveryTimer) { lastTouchAt = Date.now(); armRecovery(); }
      return;
    }
    lastTouchAt = Date.now();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      options.abort.abort(new Error(`${options.reason ?? 'VE2 research inactivity timeout'} after ${options.idleMs}ms`));
      options.onTimeout();
    }, options.idleMs);
    idleTimer.unref?.();
  };
  options.abort.signal.addEventListener('abort', onAbort, { once: true });
  if (options.abort.signal.aborted) onAbort();
  else touch();

  return {
    touch,
    stop: () => {
      stopped = true;
      clearTimeout(idleTimer);
      clearTimeout(recoveryTimer);
      options.abort.signal.removeEventListener('abort', onAbort);
    },
  };
}
