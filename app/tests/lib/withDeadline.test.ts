import { withDeadline, DeadlineError } from '@/lib/withDeadline';

const delay = <T>(ms: number, value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

describe('withDeadline', () => {
  it('resolves with the fn value when it settles before the deadline', async () => {
    const out = await withDeadline('fast', 1000, () => delay(5, 'ok'));
    expect(out).toBe('ok');
  });

  it('rejects with DeadlineError when fn exceeds the deadline', async () => {
    await expect(
      withDeadline('slow', 10, () => delay(200, 'late')),
    ).rejects.toBeInstanceOf(DeadlineError);
  });

  it('exposes label and ms on the DeadlineError', async () => {
    try {
      await withDeadline('campaign-x', 10, () => delay(200, 'late'));
      throw new Error('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(DeadlineError);
      expect((err as DeadlineError).label).toBe('campaign-x');
      expect((err as DeadlineError).ms).toBe(10);
    }
  });

  it("propagates fn's own rejection unchanged (not a DeadlineError)", async () => {
    const boom = new Error('upstream failed');
    await expect(
      withDeadline('errs', 1000, () => Promise.reject(boom)),
    ).rejects.toBe(boom);
  });
});
