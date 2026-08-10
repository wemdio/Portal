/** @jest-environment node */
/* eslint-disable @typescript-eslint/no-require-imports */

const { isRetryableDbError } = require('../../scripts/db/ensureDatabase.js') as {
  isRetryableDbError: (error: { code?: string; message?: string }) => boolean;
};

describe('database migration retry classification', () => {
  it('retries PostgreSQL lock timeouts so a migration can acquire a quiet lock window', () => {
    expect(
      isRetryableDbError({
        code: '55P03',
        message: 'canceling statement due to lock timeout',
      }),
    ).toBe(true);
  });

  it.each(['42710', '23505', '55000'])(
    'does not retry non-transient PostgreSQL error %s',
    (code) => {
      expect(isRetryableDbError({ code, message: 'non-transient migration error' })).toBe(
        false,
      );
    },
  );
});
