export class YandexMapsJobStoppedError extends Error {
  constructor() { super('YandexMaps job is no longer owned by this run'); }
}

/** Liveness while queued/in flight, without inventing progress or reviving failed jobs. */
export function startYandexMapsParseLease(touch: () => Promise<boolean>, intervalMs = 30_000) {
  const controller = new AbortController();
  let checking: Promise<void> | undefined;
  const check = (): Promise<void> => {
    if (controller.signal.aborted) return Promise.reject(controller.signal.reason);
    if (!checking) {
      checking = (async () => {
        try {
          if (!await touch()) throw new YandexMapsJobStoppedError();
        } catch (error) {
          controller.abort(error);
          throw error;
        } finally {
          checking = undefined;
        }
      })();
    }
    return checking;
  };
  const timer = setInterval(() => { void check().catch(() => undefined); }, intervalMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    check,
    abort: (reason: Error) => controller.abort(reason),
    stop: () => clearInterval(timer),
  };
}
