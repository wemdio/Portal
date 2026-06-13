/**
 * Race a promise-returning fn against a hard deadline.
 *
 * If `fn` doesn't settle within `ms`, the returned promise rejects with a
 * DeadlineError. The underlying work is NOT aborted — this is a latency guard,
 * not a cancellation primitive. Use it so one slow dependency can't block a
 * whole fan-out: e.g. one stuck Instantly campaign should not hang the entire
 * /client/replies response (each campaign is fetched under its own deadline, so
 * the page returns the campaigns that answered in time instead of spinning).
 */

export class DeadlineError extends Error {
  readonly label: string;
  readonly ms: number;
  constructor(label: string, ms: number) {
    super(`Deadline ${ms}ms exceeded: ${label}`);
    this.name = 'DeadlineError';
    this.label = label;
    this.ms = ms;
  }
}

export function withDeadline<T>(
  label: string,
  ms: number,
  fn: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(label, ms)), ms);
    fn().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
