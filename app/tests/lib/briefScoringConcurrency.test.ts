import {
  mapBriefScoringWithConcurrency,
  resolveBriefScoringConcurrency,
} from '@/lib/briefScoring/concurrency';

describe('brief scoring bounded concurrency', () => {
  it('defaults safely and clamps env values to 1..4', () => {
    expect(resolveBriefScoringConcurrency(undefined)).toBe(2);
    expect(resolveBriefScoringConcurrency('')).toBe(2);
    expect(resolveBriefScoringConcurrency('not-a-number')).toBe(2);
    expect(resolveBriefScoringConcurrency('0')).toBe(1);
    expect(resolveBriefScoringConcurrency('3.9')).toBe(3);
    expect(resolveBriefScoringConcurrency('100')).toBe(4);
  });

  it('never exceeds the limit and preserves result order', async () => {
    let active = 0;
    let maxActive = 0;

    const results = await mapBriefScoringWithConcurrency(
      [30, 10, 20, 40, 50],
      2,
      async (value, index) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, index % 2 === 0 ? 8 : 2));
        active -= 1;
        return value / 10;
      },
    );

    expect(maxActive).toBe(2);
    expect(results).toEqual([3, 1, 2, 4, 5]);
  });

  it('does not start new work after an unexpected worker error', async () => {
    const started: number[] = [];

    await expect(
      mapBriefScoringWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (value) => {
        started.push(value);
        if (value === 0) throw new Error('boom');
        await new Promise((resolve) => setTimeout(resolve, 5));
        return value;
      }),
    ).rejects.toThrow('boom');

    // Второй слот уже мог взять item=1, но после ошибки новые элементы не
    // выдаются. Так lifecycle job'а не продолжает писать результаты в фоне.
    expect(started).toEqual([0, 1]);
  });

  it('returns immediately for an empty list', async () => {
    const worker = jest.fn(async () => 1);
    await expect(mapBriefScoringWithConcurrency([], 2, worker)).resolves.toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });
});
