/** @jest-environment node */
import { YandexMapsParseQueue } from '@/lib/parsers/yandexMapsParseQueue';
import { startYandexMapsParseLease, YandexMapsJobStoppedError } from '@/lib/parsers/yandexMapsParseLease';
import { yandexMapsHealth, yandexMapsParseOrgs } from '@/lib/parsers/yandexMapsServiceClient';
import { yandexMapsParseQueue } from '@/lib/parsers/yandexMapsParseQueue';

jest.mock('undici', () => ({ Agent: jest.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => jest.useRealTimers());

it('shares two slots across jobs, drains FIFO and removes cancelled waiters', async () => {
  const queue = new YandexMapsParseQueue();
  queue.setCapacity(2);
  const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
  const started: number[] = [];
  const first = gates.map((gate, index) => queue.run(async () => {
    started.push(index);
    await gate.promise;
  }));
  const cancelled = new AbortController();
  const skipped = jest.fn(async () => undefined);
  const pending = queue.run(skipped, cancelled.signal).catch((error) => error);
  await Promise.resolve();
  expect(started).toEqual([0, 1]);
  cancelled.abort(new Error('stopped'));
  expect(await pending).toEqual(new Error('stopped'));
  gates[0].resolve();
  await first[0];
  await Promise.resolve();
  expect(started).toEqual([0, 1, 2]);
  gates[1].resolve(); gates[2].resolve();
  await Promise.all(first);
  expect(skipped).not.toHaveBeenCalled();
  await expect(queue.run(async () => { throw new Error('network'); })).rejects.toThrow('network');
  await expect(queue.run(async () => 7)).resolves.toBe(7);
});

it('keeps heartbeat while waiting and aborts as soon as ownership is lost', async () => {
  jest.useFakeTimers();
  const touch = jest.fn().mockResolvedValue(true);
  const lease = startYandexMapsParseLease(touch);
  await lease.check();
  await jest.advanceTimersByTimeAsync(16 * 60_000);
  expect(touch).toHaveBeenCalledTimes(33);
  expect(lease.signal.aborted).toBe(false);
  touch.mockResolvedValue(false);
  await jest.advanceTimersByTimeAsync(30_000);
  expect(lease.signal.reason).toBeInstanceOf(YandexMapsJobStoppedError);
  lease.stop();
  await jest.advanceTimersByTimeAsync(60_000);
  expect(touch).toHaveBeenCalledTimes(34);
});

it('does not overlap heartbeat writes and aborts on database failure', async () => {
  jest.useFakeTimers();
  const gate = deferred<boolean>();
  const touch = jest.fn(() => gate.promise);
  const lease = startYandexMapsParseLease(touch);
  const checked = lease.check();
  await jest.advanceTimersByTimeAsync(60_000);
  expect(touch).toHaveBeenCalledTimes(1);
  gate.resolve(true);
  await checked;
  touch.mockRejectedValueOnce(new Error('database unavailable'));
  await jest.advanceTimersByTimeAsync(30_000);
  expect(lease.signal.aborted).toBe(true);
  expect(lease.signal.reason.message).toBe('database unavailable');
  lease.stop();
});

describe('HTTP parsing lifecycle', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
    yandexMapsParseQueue.setCapacity(2);
  });

  it('uses advertised capacity and falls back to two slots for an older service', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');
    for (const [health, capacity] of [[{ parse_concurrency: 1 }, 1], [{ ok: true }, 2]] as const) {
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => health } as Response);
      expect(await yandexMapsHealth()).toBe(true);
      const gate = deferred<void>();
      let active = 0;
      let peak = 0;
      fetchMock.mockImplementation(async () => {
        active++;
        peak = Math.max(peak, active);
        await gate.promise;
        active--;
        return { ok: true, json: async () => ({ organizations: [] }) } as Response;
      });
      const jobs = [1, 2, 3].map(() => yandexMapsParseOrgs({ links: ['card'] }));
      await Promise.resolve();
      expect(active).toBe(capacity);
      gate.resolve();
      await Promise.all(jobs);
      expect(peak).toBe(capacity);
    }
  });

  it('aborts in-flight HTTP and never retries it internally', async () => {
    const began = deferred<void>();
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      began.resolve();
    }));
    const cancelled = new AbortController();
    const running = yandexMapsParseOrgs({ links: ['card'] }, cancelled.signal);
    const rejected = expect(running).rejects.toThrow('job stopped');
    await began.promise;
    cancelled.abort(new Error('job stopped'));
    await rejected;
    await expect(yandexMapsParseOrgs({ links: ['card'] }, cancelled.signal)).rejects.toThrow('job stopped');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the request deadline until the response body is read, without nested retries', async () => {
    jest.useFakeTimers();
    process.env.YANDEXMAPS_SERVICE_TIMEOUT_MS = '1000';
    process.env.YANDEXMAPS_SERVICE_MAX_RETRIES = '5';
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      }),
    }) as Response);
    const running = expect(yandexMapsParseOrgs({ links: ['card'] })).rejects.toThrow('yandexmaps fetch failed');
    await jest.advanceTimersByTimeAsync(1000);
    await running;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
