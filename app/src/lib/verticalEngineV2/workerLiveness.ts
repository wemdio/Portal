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
