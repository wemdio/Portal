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
  onTimeout: () => void;
  onUnresponsive: () => void;
}): { touch: () => void; stop: () => void } {
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const onAbort = () => {
    clearTimeout(idleTimer);
    if (stopped || recoveryTimer) return;
    recoveryTimer = setTimeout(() => {
      if (!stopped) options.onUnresponsive();
    }, options.graceMs);
    recoveryTimer.unref?.();
  };
  const touch = () => {
    if (stopped || options.abort.signal.aborted) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      options.abort.abort(new Error(`VE2 research inactivity timeout after ${options.idleMs}ms`));
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
