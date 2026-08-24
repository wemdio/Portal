/** @jest-environment node */

import {
  applyWebsiteInnLookupResultsToTabs,
  isWebsiteInnLookupApplyComplete,
  selectWebsiteInnLookupResumeJob,
  startWebsiteInnLookupAfterStateSaved,
  type WebsiteInnLookupResult,
} from '@/lib/enrich/websiteInnLookupShared';
import {
  publishWebsiteInnLookupJob,
  type WebsiteInnLookupPublisherDeps,
} from '@/lib/enrich/websiteInnLookupJobPublisher';
import { validateWebsiteInnLookupCreateBody } from '@/lib/enrich/websiteInnLookupRequest';
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
    expect(isWebsiteInnLookupApplyComplete(result)).toBe(true);
  });

  it('saves the current spreadsheet before the server job can be created', async () => {
    const timeline: string[] = [];
    const created = await startWebsiteInnLookupAfterStateSaved(
      async () => {
        timeline.push('save:start');
        await Promise.resolve();
        timeline.push('save:done');
        return true;
      },
      async () => {
        timeline.push('job:create');
        return { id: 'job-1' };
      },
    );

    expect(created).toEqual({ id: 'job-1' });
    expect(timeline).toEqual(['save:start', 'save:done', 'job:create']);

    const createAfterFailedSave = jest.fn(async () => ({ id: 'must-not-exist' }));
    await expect(
      startWebsiteInnLookupAfterStateSaved(async () => false, createAfterFailedSave),
    ).rejects.toThrow('Не удалось сохранить базу');
    expect(createAfterFailedSave).not.toHaveBeenCalled();
  });

  it('keeps a job staged until every queue item is persisted', async () => {
    const timeline: string[] = [];
    const persistedRows: number[] = [];
    let status = 'none';
    const deps: WebsiteInnLookupPublisherDeps<{ id: string; status: string }> = {
      createPreparingJob: jest.fn(async () => {
        status = 'preparing';
        timeline.push('job:preparing');
        return { id: 'job-1' };
      }),
      insertItems: jest.fn(async (_jobId, items) => {
        expect(status).toBe('preparing');
        persistedRows.push(...items.map((item) => item.row_index));
        timeline.push(`items:${items.length}`);
      }),
      countItems: jest.fn(async () => {
        timeline.push('items:count');
        return persistedRows.length;
      }),
      publishJob: jest.fn(async () => {
        expect(persistedRows).toHaveLength(12);
        status = 'pending';
        timeline.push('job:pending');
        return { id: 'job-1', status };
      }),
      failPreparingJob: jest.fn(async () => undefined),
    };

    const job = await publishWebsiteInnLookupJob(
      { id: 'job-1', total: 12 },
      Array.from({ length: 12 }, (_, index) => ({
        row_index: index + 1,
        url: `https://site-${index + 1}.test`,
      })),
      deps,
      { chunkSize: 5 },
    );

    expect(job).toEqual({ id: 'job-1', status: 'pending' });
    expect(timeline).toEqual([
      'job:preparing',
      'items:5',
      'items:5',
      'items:2',
      'items:count',
      'job:pending',
    ]);
  });

  it('never publishes a partially persisted queue', async () => {
    const failPreparingJob = jest.fn(async () => undefined);
    const publishJob = jest.fn(async () => ({ id: 'job-1', status: 'pending' }));
    const deps: WebsiteInnLookupPublisherDeps<{ id: string; status: string }> = {
      createPreparingJob: jest.fn(async () => ({ id: 'job-1' })),
      insertItems: jest.fn(async () => undefined),
      countItems: jest.fn(async () => 11),
      publishJob,
      failPreparingJob,
    };

    await expect(publishWebsiteInnLookupJob(
      { id: 'job-1', total: 12 },
      Array.from({ length: 12 }, (_, index) => ({
        row_index: index + 1,
        url: `https://site-${index + 1}.test`,
      })),
      deps,
    )).rejects.toThrow('queue incomplete: 11/12');

    expect(publishJob).not.toHaveBeenCalled();
    expect(failPreparingJob).toHaveBeenCalledWith(
      'job-1',
      expect.stringContaining('11/12'),
    );
  });

  it('never overwrites columns that were moved while the job was running', () => {
    const originalTabs = [{
      id: 'tab-1',
      name: 'База',
      data: [
        ['Сайт', 'Email', 'Телефон'],
        ['https://site-1.test', 'owner@example.test', '+7 999 000-00-00'],
      ],
    }];
    const result = applyWebsiteInnLookupResultsToTabs(originalTabs, {
      tabId: 'tab-1',
      urlColumn: 0,
      innColumn: 1,
      companyColumn: 2,
      results: [makeResult(1)],
    });

    expect(result.unsafeTargetColumns).toBe(true);
    expect(result.mutated).toBe(false);
    expect(result.tabs).toBe(originalTabs);
    expect(result.tabs[0].data[0]).toEqual(['Сайт', 'Email', 'Телефон']);
    expect(result.tabs[0].data[1]).toEqual([
      'https://site-1.test',
      'owner@example.test',
      '+7 999 000-00-00',
    ]);
    expect(isWebsiteInnLookupApplyComplete(result)).toBe(false);
  });

  it('keeps results recoverable when the target tab or row is not in server state yet', () => {
    const missingTab = applyWebsiteInnLookupResultsToTabs([], {
      tabId: 'tab-1',
      urlColumn: 0,
      innColumn: 1,
      companyColumn: 2,
      results: [makeResult(1)],
    });
    expect(missingTab.tabFound).toBe(false);
    expect(isWebsiteInnLookupApplyComplete(missingTab)).toBe(false);

    const missingRow = applyWebsiteInnLookupResultsToTabs(
      [{ id: 'tab-1', name: 'База', data: [['Сайт', 'ИНН (найден)', 'Компания (найдена)']] }],
      {
        tabId: 'tab-1',
        urlColumn: 0,
        innColumn: 1,
        companyColumn: 2,
        results: [makeResult(1)],
      },
    );
    expect(missingRow.skippedMissingRows).toBe(1);
    expect(isWebsiteInnLookupApplyComplete(missingRow)).toBe(false);
  });

  it('rejects overlapping or unbounded spreadsheet columns at the API boundary', () => {
    const base = {
      tabId: 'tab-1',
      urlColumn: 0,
      innColumn: 1,
      companyColumn: 2,
      items: [{ rowIndex: 1, url: 'https://site-1.test' }],
    };
    expect(validateWebsiteInnLookupCreateBody(base).ok).toBe(true);
    expect(validateWebsiteInnLookupCreateBody({ ...base, innColumn: 0 }).ok).toBe(false);
    expect(validateWebsiteInnLookupCreateBody({ ...base, companyColumn: 100_001 }).ok).toBe(false);
  });

  it('replays a just-finished job when page hydration raced with the final server apply', () => {
    const pageOpenedAt = Date.parse('2026-08-25T10:00:00.000Z');
    const terminalJob = {
      id: 'job-finished-during-load',
      status: 'completed',
      completed_at: '2026-08-25T10:00:01.000Z',
      results_applied_at: '2026-08-25T10:00:01.000Z',
    };
    expect(selectWebsiteInnLookupResumeJob({
      activeJob: null,
      unappliedJob: null,
      latestTerminalJob: terminalJob,
      pageOpenedAt,
    })).toBe(terminalJob);

    expect(selectWebsiteInnLookupResumeJob({
      activeJob: null,
      unappliedJob: null,
      latestTerminalJob: { ...terminalJob, completed_at: '2026-08-25T09:59:59.000Z' },
      pageOpenedAt,
    })).toBeNull();
  });
});
