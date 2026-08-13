import type { WorkerLogger } from './_shared';

type ExitProcess = (code: number) => void;

export interface UndiciAssertHandlers {
  uncaughtException: (error: Error) => void;
  unhandledRejection: (reason: unknown) => void;
}

/**
 * Node's bundled undici can throw this assertion from a socket event handler
 * while a timed-out request is being aborted. It is not surfaced as the
 * fetch promise rejection, so worker-local try/catch cannot intercept it.
 *
 * Keep this predicate deliberately narrow. An ERR_ASSERTION from application
 * code, or an undici error with any other code, must retain normal fail-fast
 * process behavior.
 */
export function isUndiciAssertionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== 'ERR_ASSERTION') return false;

  const message = error.message.trim();
  const isKnownMessage =
    message === 'assert(!this.paused)' ||
    /^The expression evaluated to a falsy value:\s+assert\(!this\.paused\)$/.test(message);
  if (!isKnownMessage) return false;

  return /\bat Parser\.finish \(node:internal\/deps\/undici\/undici:\d+:\d+\)/
    .test(error.stack ?? '');
}

export function createUndiciAssertHandlers(
  log: WorkerLogger,
  exitProcess: ExitProcess,
): UndiciAssertHandlers {
  return {
    uncaughtException(error) {
      if (isUndiciAssertionError(error)) {
        const first = (error.message ?? '').split('\n')[0] ?? '';
        log('warn', `Suppressed undici parser assertion (uncaught): ${first.trim()}`);
        return;
      }

      log('error', `Uncaught exception: ${error.message}`, error);
      exitProcess(1);
    },

    unhandledRejection(reason) {
      if (isUndiciAssertionError(reason)) {
        const first = ((reason as Error).message ?? '').split('\n')[0] ?? '';
        log('warn', `Suppressed undici parser assertion (rejection): ${first.trim()}`);
        return;
      }

      log('error', `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`, reason);
      exitProcess(1);
    },
  };
}

export function installUndiciAssertGuard(log: WorkerLogger): void {
  const handlers = createUndiciAssertHandlers(log, (code) => process.exit(code));
  process.on('uncaughtException', handlers.uncaughtException);
  process.on('unhandledRejection', handlers.unhandledRejection);
}
