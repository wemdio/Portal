/** @jest-environment node */

jest.mock('@/lib/enrich/websiteParser', () => ({
  fetchAndExtract: jest.fn(),
}));

import { fetchAndExtract } from '@/lib/enrich/websiteParser';
import { stepEnrich } from '@/lib/tools/processingSteps';

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

  it('counts watchdog timeouts as settled rows and reaches 100%', async () => {
    const rows = Array.from({ length: 10 }, (_, index) => [
      `Company ${index}`,
      `https://example-${index}.com`,
    ]);
    const progress: number[] = [];

    const resultPromise = stepEnrich(
      [['Компания', 'Сайт'], ...rows],
      async (value) => { progress.push(value); },
    );

    await jest.advanceTimersByTimeAsync(120_000);
    const result = await resultPromise;

    expect(fetchAndExtractMock).toHaveBeenCalledTimes(10);
    expect(progress.at(-1)).toBe(100);
    expect(result).toHaveLength(11);
  });
});
