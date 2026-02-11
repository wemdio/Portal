import { runWithTimeout } from '@/lib/enrich/timeoutUtils';

describe('runWithTimeout', () => {
  it('rejects when operation exceeds timeout', async () => {
    const never = new Promise<string>(() => {});

    await expect(
      runWithTimeout(never, {
        timeoutMs: 25,
        timeoutMessage: 'Operation timed out',
      }),
    ).rejects.toThrow('Operation timed out');
  });

  it('resolves when operation completes in time', async () => {
    const quick = new Promise<string>((resolve) => {
      setTimeout(() => resolve('ok'), 5);
    });

    await expect(
      runWithTimeout(quick, {
        timeoutMs: 100,
        timeoutMessage: 'Operation timed out',
      }),
    ).resolves.toBe('ok');
  });
});
