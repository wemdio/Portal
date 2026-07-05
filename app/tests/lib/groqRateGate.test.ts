/**
 * Unit tests for the process-wide Groq quota gate.
 *
 * The gate serializes access to Groq's free-tier audio budget
 * (7200 audio-seconds per rolling hour) so that N parallel scan
 * pipelines don't blindly stampede the API and burn retries.
 */
import {
  acquireGroqSlot,
  reportGroqRateLimit,
  estimateGroqWaitSeconds,
  _resetGroqGateForTests,
} from '@/lib/groqRateGate';

// Let queued microtasks settle without advancing timers.
const flush = () => Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());

describe('groqRateGate', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    _resetGroqGateForTests();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.GROQ_ASPH_BUDGET;
    delete process.env.GROQ_MAX_CONCURRENT;
  });

  test('caps concurrent requests at GROQ_MAX_CONCURRENT', async () => {
    process.env.GROQ_MAX_CONCURRENT = '3';
    const resolved: number[] = [];
    const slots = [0, 1, 2, 3, 4].map((i) =>
      acquireGroqSlot(10).then((slot) => {
        resolved.push(i);
        return slot;
      }),
    );
    await flush();
    expect(resolved).toHaveLength(3);

    (await slots[0]).release();
    await flush();
    expect(resolved).toHaveLength(4);
  });

  test('holds a request back when the hourly audio budget is exhausted', async () => {
    process.env.GROQ_ASPH_BUDGET = '6600';
    process.env.GROQ_MAX_CONCURRENT = '10';

    let firstDone = false;
    let secondDone = false;
    const first = acquireGroqSlot(4000).then((s) => {
      firstDone = true;
      return s;
    });
    void acquireGroqSlot(4000).then((s) => {
      secondDone = true;
      s.release();
    });

    await flush();
    expect(firstDone).toBe(true);
    expect(secondDone).toBe(false); // 4000 + 4000 > 6600

    (await first).release(); // finished, but quota stays booked for the hour
    await flush();
    expect(secondDone).toBe(false);

    // After the rolling hour the first booking expires.
    await jest.advanceTimersByTimeAsync(61 * 60 * 1000);
    expect(secondDone).toBe(true);
  });

  test('releases with refundQuota free the budget immediately (429 was not counted)', async () => {
    process.env.GROQ_ASPH_BUDGET = '6600';
    process.env.GROQ_MAX_CONCURRENT = '10';

    const first = await acquireGroqSlot(4000);
    let secondDone = false;
    void acquireGroqSlot(4000).then((s) => {
      secondDone = true;
      s.release();
    });
    await flush();
    expect(secondDone).toBe(false);

    first.release({ refundQuota: true });
    await flush();
    expect(secondDone).toBe(true);
  });

  test('prefers shorter files but lets long ones age in', async () => {
    process.env.GROQ_MAX_CONCURRENT = '1';
    const order: string[] = [];

    const a = await acquireGroqSlot(100); // occupies the only slot
    void acquireGroqSlot(3000).then((s) => {
      order.push('long');
      s.release();
    });
    await flush();
    void acquireGroqSlot(50).then((s) => {
      order.push('short');
      s.release();
    });
    await flush();

    a.release();
    await flush();
    expect(order[0]).toBe('short'); // short jumps ahead of long
    expect(order[1]).toBe('long');
  });

  test('reportGroqRateLimit blocks dispatch until the cooldown passes', async () => {
    reportGroqRateLimit(120);

    let done = false;
    void acquireGroqSlot(10).then((s) => {
      done = true;
      s.release();
    });
    await flush();
    expect(done).toBe(false);

    await jest.advanceTimersByTimeAsync(121 * 1000);
    expect(done).toBe(true);
  });

  test('estimateGroqWaitSeconds reflects cooldown', () => {
    expect(estimateGroqWaitSeconds(100)).toBe(0);
    reportGroqRateLimit(600);
    expect(estimateGroqWaitSeconds(100)).toBeGreaterThanOrEqual(599);
  });
});
