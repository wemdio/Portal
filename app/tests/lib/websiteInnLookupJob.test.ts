/** @jest-environment node */

import {
  applyWebsiteInnLookupResultsToTabs,
  type WebsiteInnLookupResult,
} from '@/lib/enrich/websiteInnLookupShared';
import {
  executeWebsiteInnLookupJob,
  type WebsiteInnLookupRunnerDeps,
} from '@/lib/enrich/websiteInnLookupRunner';

const makeResult = (rowIndex: number): WebsiteInnLookupResult => ({
  id: `result-${rowIndex}`,
  row_index: rowIndex,
  url: `https://site-${rowIndex}.test`,
  status: 'completed',
  inn: `77000000${String(rowIndex).padStart(2, '0')}`,
  company_name: `Компания ${rowIndex}`,
  error_message: null,
});

describe('website INN lookup survives a closed browser', () => {
  it('resumes from persisted pending rows instead of processing completed rows again', async () => {
    const alreadyCompleted = Array.from({ length: 5 }, (_, index) => makeResult(index + 1));
    const stillPending = Array.from({ length: 7 }, (_, index) => ({
      id: `item-${index + 6}`,
      row_index: index + 6,
      url: `https://site-${index + 6}.test`,
    }));
    const lookupItems = jest.fn(async (items: typeof stillPending) =>
      items.map((item) => makeResult(item.row_index)),
    );
    const completeJob = jest.fn(async () => undefined);
    const applyResults = jest.fn(async () => true);
    const listPendingItems = jest
      .fn()
      .mockResolvedValueOnce(stillPending)
      .mockResolvedValueOnce([]);

    const deps: WebsiteInnLookupRunnerDeps = {
      loadJob: jest.fn(async () => ({
        id: 'job-1',
        user_id: 'user-1',
        status: 'running',
        tab_id: 'tab-1',
        url_column: 0,
        inn_column: 1,
        company_column: 2,
        total: 12,
        processed: alreadyCompleted.length,
        found: alreadyCompleted.filter((item) => item.inn).length,
      })),
      isCancellationRequested: jest.fn(async () => false),
      listPendingItems,
      lookupItems,
      persistOutcomes: jest.fn(async () => ({ processed: 12, found: 12 })),
      applyResults,
      completeJob,
      cancelJob: jest.fn(async () => undefined),
      failJob: jest.fn(async () => undefined),
    };

    await executeWebsiteInnLookupJob('job-1', deps, { batchSize: 7 });

    expect(lookupItems).toHaveBeenCalledTimes(1);
    expect(lookupItems).toHaveBeenCalledWith(stillPending);
    expect(lookupItems).not.toHaveBeenCalledWith(
      expect.arrayContaining(alreadyCompleted.map((item) => expect.objectContaining({ id: item.id }))),
    );
    expect(completeJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-1' }),
      { processed: 12, found: 12 },
    );
    expect(applyResults).toHaveBeenCalled();
  });

  it('reapplies persisted results after reload but skips a row whose URL changed', () => {
    const rows = Array.from({ length: 12 }, (_, index) => [
      `https://site-${index + 1}.test`,
      index < 5 ? `77000000${String(index + 1).padStart(2, '0')}` : '',
      index < 5 ? `Компания ${index + 1}` : '',
    ]);
    rows[7][0] = 'https://changed-after-start.test';

    const result = applyWebsiteInnLookupResultsToTabs(
      [{ id: 'tab-1', name: 'База', data: [['Сайт', 'ИНН (найден)', 'Компания (найдена)'], ...rows] }],
      {
        tabId: 'tab-1',
        urlColumn: 0,
        innColumn: 1,
        companyColumn: 2,
        results: Array.from({ length: 12 }, (_, index) => makeResult(index + 1)),
      },
    );

    expect(result.applied).toBe(11);
    expect(result.skippedChangedUrl).toBe(1);
    expect(result.tabs[0].data[6][1]).toBe('7700000006');
    expect(result.tabs[0].data[8][1]).toBe('');
    expect(result.tabs[0].data[8][0]).toBe('https://changed-after-start.test');
  });
});
