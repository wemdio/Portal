/** @jest-environment node */

jest.mock('@/lib/enrich/websiteParser', () => ({
  fetchAndExtract: jest.fn(),
}));

import { fetchAndExtract } from '@/lib/enrich/websiteParser';
import {
  ENRICH_CHECKPOINT_ATTEMPTED_COL,
  stepEnrich,
} from '@/lib/tools/processingSteps';

const fetchAndExtractMock = jest.mocked(fetchAndExtract);

describe('stepEnrich timeout progress', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    fetchAndExtractMock.mockReset();
    fetchAndExtractMock.mockImplementation(() => new Promise<string>(() => undefined));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses the 60s production hard deadline before settling a stuck site', async () => {
    const progress: number[] = [];
    const resultPromise = stepEnrich(
      [['Компания', 'Сайт'], ['Slow company', 'https://slow.example']],
      async (value) => { progress.push(value); },
    );

    await jest.advanceTimersByTimeAsync(59_999);
    expect(progress).not.toContain(100);

    await jest.advanceTimersByTimeAsync(1);
    await resultPromise;
    expect(progress.at(-1)).toBe(100);
  });

  it('counts watchdog timeouts as settled rows and reaches 100%', async () => {
    const rows = Array.from({ length: 15 }, (_, index) => [
      `Company ${index}`,
      `https://example-${index}.com`,
    ]);
    const progress: number[] = [];
    const checkpoints: string[][][] = [];

    const resultPromise = stepEnrich(
      [['Компания', 'Сайт'], ...rows],
      async (value) => { progress.push(value); },
      undefined,
      async (checkpoint) => { checkpoints.push(checkpoint); },
    );

    await jest.advanceTimersByTimeAsync(180_000);
    const result = await resultPromise;

    expect(fetchAndExtractMock).toHaveBeenCalledTimes(15);
    expect(progress.at(-1)).toBe(100);
    expect(result).toHaveLength(16);

    const intermediate = checkpoints.find((checkpoint) =>
      checkpoint[0].includes(ENRICH_CHECKPOINT_ATTEMPTED_COL));
    expect(intermediate).toBeDefined();

    fetchAndExtractMock.mockReset();
    fetchAndExtractMock.mockResolvedValue('recovered');
    const resumed = await stepEnrich(intermediate!, async () => {});

    expect(fetchAndExtractMock.mock.calls.length).toBeGreaterThan(0);
    expect(fetchAndExtractMock.mock.calls.length).toBeLessThan(15);
    expect(resumed[0]).toEqual(['Компания', 'Сайт', 'Описание']);
    expect(resumed[0]).not.toContain(ENRICH_CHECKPOINT_ATTEMPTED_COL);
  });
});
