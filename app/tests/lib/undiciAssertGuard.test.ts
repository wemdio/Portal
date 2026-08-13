/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';
import {
  createUndiciAssertHandlers,
  isUndiciAssertionError,
} from '../../worker/_undiciAssertGuard';

const appRoot = process.cwd();
const repoRoot = path.resolve(appRoot, '..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function makeAssertionError(stack: string): Error & { code: string } {
  const err = new Error('assert(!this.paused)') as Error & { code: string };
  err.code = 'ERR_ASSERTION';
  err.stack = stack;
  return err;
}

describe('shared undici assertion guard', () => {
  it('recognizes only ERR_ASSERTION errors originating in undici', () => {
    const matching = makeAssertionError(
      'AssertionError [ERR_ASSERTION]\n    at Parser.finish (node:internal/deps/undici/undici:6157:9)',
    );
    const matchingNodeFormatted = makeAssertionError(
      'AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:\n\n' +
      '  assert(!this.paused)\n\n' +
      '    at Parser.finish (node:internal/deps/undici/undici:6157:9)',
    );
    matchingNodeFormatted.message =
      'The expression evaluated to a falsy value:\n\n  assert(!this.paused)\n';
    const wrongCode = Object.assign(new Error('socket failed'), {
      code: 'ECONNRESET',
      stack: 'Error: socket failed\n    at undici:123:4',
    });
    const wrongStack = makeAssertionError(
      'AssertionError [ERR_ASSERTION]\n    at application/parser.ts:12:3',
    );

    expect(isUndiciAssertionError(matching)).toBe(true);
    expect(isUndiciAssertionError(matchingNodeFormatted)).toBe(true);
    expect(isUndiciAssertionError(wrongCode)).toBe(false);
    expect(isUndiciAssertionError(wrongStack)).toBe(false);
    expect(isUndiciAssertionError('ERR_ASSERTION from undici')).toBe(false);
  });

  it('does not suppress a different assertion thrown from undici', () => {
    const log = jest.fn();
    const exit = jest.fn();
    const handlers = createUndiciAssertHandlers(log, exit);
    const unrelatedAssertion = makeAssertionError(
      'AssertionError [ERR_ASSERTION]: expected body length\n' +
      '    at Parser.finish (node:internal/deps/undici/undici:6157:9)',
    );
    unrelatedAssertion.message = 'expected body length';

    handlers.uncaughtException(unrelatedAssertion);

    expect(log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('expected body length'),
      unrelatedAssertion,
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it.each(['uncaughtException', 'unhandledRejection'] as const)(
    'suppresses the known assertion for %s without exiting',
    (event) => {
      const log = jest.fn();
      const exit = jest.fn();
      const handlers = createUndiciAssertHandlers(log, exit);
      const matching = makeAssertionError(
        'AssertionError [ERR_ASSERTION]\n    at Parser.finish (node:internal/deps/undici/undici:6157:9)',
      );

      handlers[event](matching);

      expect(exit).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('Suppressed undici parser assertion'),
      );
    },
  );

  it.each([
    ['uncaughtException', Object.assign(new Error('assertion elsewhere'), {
      code: 'ERR_ASSERTION',
      stack: 'AssertionError [ERR_ASSERTION]\n    at application/parser.ts:12:3',
    })],
    ['unhandledRejection', Object.assign(new Error('network failure'), {
      code: 'ECONNRESET',
      stack: 'Error: network failure\n    at undici:123:4',
    })],
  ] as const)('keeps fail-fast behavior for unrelated %s errors', (event, reason) => {
    const log = jest.fn();
    const exit = jest.fn();
    const handlers = createUndiciAssertHandlers(log, exit);

    handlers[event](reason);

    expect(log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining(reason.message),
      reason,
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('is shared by BaseConstructor and installed before auto-pipeline main starts', () => {
    const baseConstructor = readRepoFile('app/worker/baseConstructor.ts');
    const autoPipeline = readRepoFile('app/worker/autoPipeline.ts');

    expect(baseConstructor).toContain(
      "import { installUndiciAssertGuard } from './_undiciAssertGuard';",
    );
    expect(baseConstructor).not.toContain('function installUndiciAssertGuard');
    expect(autoPipeline).toContain(
      "import { installUndiciAssertGuard } from './_undiciAssertGuard';",
    );

    const installIndex = autoPipeline.indexOf('installUndiciAssertGuard(log);');
    const mainIndex = autoPipeline.indexOf('void main()');
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(mainIndex).toBeGreaterThan(installIndex);
  });
});
