/** @jest-environment node */

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';

import {
  CLIENT_REPORT_EXPORT_CLAIM_SQL,
  CLIENT_REPORT_EXPORT_STATEMENT_TIMEOUT_MS,
  claimClientReportExportJob,
  cleanupExpiredClientReportExports,
  processClientReportExportQueueTick,
  processClaimedClientReportExport,
  resetRunningClientReportExports,
  streamClientReportCsvGzip,
  type ClientReportExportWorkerDependencies,
} from '@/lib/clientReports/exportWorker';
import { parseClientReportExportJob } from '@/lib/clientReports/exportSql';

const job = parseClientReportExportJob({
  id: '123e4567-e89b-12d3-a456-426614174000',
  client_user_id: '123e4567-e89b-12d3-a456-426614174001',
  kind: 'submitted',
  status: 'running',
  filters: {
    preset: 'custom',
    from: '2026-07-01',
    to: '2026-07-31',
    fromUtc: '2026-06-30T21:00:00.000Z',
    toExclusiveUtc: '2026-07-31T21:00:00.000Z',
    score: 'all',
    campaignId: null,
    allowedCampaignIds: ['campaign-a'],
  },
});

describe('client report export worker', () => {
  it('bounds every PostgreSQL statement, including COPY, to thirty minutes', () => {
    expect(CLIENT_REPORT_EXPORT_STATEMENT_TIMEOUT_MS).toBe(30 * 60_000);
  });

  it('claims exactly one queue row with a PostgreSQL SKIP LOCKED transition', () => {
    expect(CLIENT_REPORT_EXPORT_CLAIM_SQL).toMatch(/for update skip locked/i);
    expect(CLIENT_REPORT_EXPORT_CLAIM_SQL).toMatch(/limit 1/i);
    expect(CLIENT_REPORT_EXPORT_CLAIM_SQL).toMatch(/set status = 'running'/i);
    expect(CLIENT_REPORT_EXPORT_CLAIM_SQL).toMatch(/returning/i);
  });

  it('requeues interrupted running exports on dedicated-worker startup', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: job.id }], rowCount: 1 });
    await expect(resetRunningClientReportExports({ query } as never)).resolves.toBe(1);
    expect(query.mock.calls[0][0]).toMatch(/set status = 'pending'/i);
    expect(query.mock.calls[0][0]).toMatch(/where status = 'running'/i);
  });

  it('clears an expired object key only after private storage deletion succeeds', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({
        rows: [{ id: job.id, storage_key: 'private/report.csv.gz' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const deleteObject = jest.fn().mockResolvedValue(undefined);

    await expect(cleanupExpiredClientReportExports(
      { query } as never,
      deleteObject,
    )).resolves.toBe(1);

    expect(deleteObject).toHaveBeenCalledWith('private/report.csv.gz');
    expect(query.mock.calls[1][0]).toMatch(/set storage_key = null/i);
  });

  it('retains an expired object key for cleanup retry when storage deletion fails', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{ id: job.id, storage_key: 'private/report.csv.gz' }],
      rowCount: 1,
    });
    const deleteObject = jest.fn().mockRejectedValue(new Error('temporary S3 failure'));

    await expect(cleanupExpiredClientReportExports(
      { query } as never,
      deleteObject,
    )).resolves.toBe(1);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it('cleans expired objects before claiming and processing a pending job every tick', async () => {
    const order: string[] = [];
    const cleanupExpired = jest.fn(async () => { order.push('cleanup'); return 0; });
    const claim = jest.fn(async () => { order.push('claim'); return job; });
    const process = jest.fn(async () => { order.push('process'); });

    await expect(processClientReportExportQueueTick(
      { query: jest.fn() } as never,
      { cleanupExpired, claim, process },
    )).resolves.toBe(true);

    expect(order).toEqual(['cleanup', 'claim', 'process']);
  });

  it('terminally fails a claimed queue row whose persisted filters are malformed', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: job.id,
          client_user_id: job.clientUserId,
          kind: 'submitted',
          status: 'running',
          filters: {},
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await expect(claimClientReportExportJob({ query } as never)).rejects.toThrow(
      'filters.from must be a non-empty string',
    );
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toMatch(/set status = 'failed'/i);
    expect(query.mock.calls[1][1][0]).toBe(job.id);
  });

  it('streams CSV through gzip while counting data rows and hashing stored bytes', async () => {
    let stored = Buffer.alloc(0);
    const result = await streamClientReportCsvGzip({
      csv: Readable.from([
        'email,company_name\n',
        "'=formula@example.com,Safe\n",
        'person@example.com,Other\n',
      ]),
      storageKey: 'private/report.csv.gz',
      upload: async ({ body, cacheControl, contentType }) => {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        stored = Buffer.concat(chunks);
        expect(cacheControl).toBe('private, no-store');
        expect(contentType).toBe('application/gzip');
        return { key: 'private/report.csv.gz', bucket: 'reports', size: stored.length };
      },
    });

    expect(gunzipSync(stored).toString('utf8')).toContain("'=formula@example.com");
    expect(result.rowCount).toBe(2);
    expect(result.checksumSha256).toBe(createHash('sha256').update(stored).digest('hex'));
  });

  it('marks a successful export completed with checksum, row count and seven-day expiry', async () => {
    const completed: Array<Record<string, unknown>> = [];
    const failed: Array<Record<string, unknown>> = [];
    const now = new Date('2026-08-06T09:00:00.000Z');
    const deps: ClientReportExportWorkerDependencies = {
      now: () => now,
      loadCurrentCampaignIds: async () => ['campaign-a'],
      createCsvStream: () => Readable.from(['email\n', 'one@example.com\n']),
      upload: async ({ key, body }) => {
        for await (const _chunk of body) { /* drain */ }
        return { key, bucket: 'reports', size: 42 };
      },
      markCompleted: async (_id, values) => { completed.push(values); },
      markFailed: async (_id, values) => { failed.push(values); },
      deleteObject: async () => undefined,
    };

    await processClaimedClientReportExport(job, deps);

    expect(failed).toHaveLength(0);
    expect(completed).toEqual([expect.objectContaining({
      rowCount: 1,
      storageKey: expect.stringMatching(/\.csv\.gz$/),
      checksumSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      finishedAt: '2026-08-06T09:00:00.000Z',
      expiresAt: '2026-08-13T09:00:00.000Z',
    })]);
  });

  it('marks failures terminally and never reports a completed file', async () => {
    const completed = jest.fn();
    const failed = jest.fn();
    const deps: ClientReportExportWorkerDependencies = {
      now: () => new Date('2026-08-06T09:00:00.000Z'),
      loadCurrentCampaignIds: async () => ['campaign-a'],
      createCsvStream: () => Readable.from(['email\n', 'one@example.com\n']),
      upload: async () => { throw new Error('S3 unavailable'); },
      markCompleted: completed,
      markFailed: failed,
      deleteObject: async () => undefined,
    };

    await expect(processClaimedClientReportExport(job, deps)).rejects.toThrow('S3 unavailable');
    expect(completed).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(job.id, expect.objectContaining({
      errorMessage: 'S3 unavailable',
      finishedAt: '2026-08-06T09:00:00.000Z',
    }));
  });

  it('fails closed before COPY when persisted campaign access has been revoked', async () => {
    const deps: ClientReportExportWorkerDependencies = {
      now: () => new Date('2026-08-06T09:00:00.000Z'),
      loadCurrentCampaignIds: async () => ['campaign-b'],
      createCsvStream: jest.fn(() => Readable.from(['email\n'])),
      upload: jest.fn(),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
      deleteObject: jest.fn(),
    };

    await expect(processClaimedClientReportExport(job, deps))
      .rejects.toThrow(/campaign access/i);
    expect(deps.createCsvStream).not.toHaveBeenCalled();
    expect(deps.upload).not.toHaveBeenCalled();
    expect(deps.markCompleted).not.toHaveBeenCalled();
    expect(deps.markFailed).toHaveBeenCalledWith(job.id, expect.objectContaining({
      errorMessage: expect.stringMatching(/campaign access/i),
    }));
  });

  it('never retries or mutates a terminally cancelled job', async () => {
    const cancelled = parseClientReportExportJob({ ...job, status: 'cancelled' });
    const deps: ClientReportExportWorkerDependencies = {
      now: jest.fn(() => new Date('2026-08-06T09:00:00.000Z')),
      loadCurrentCampaignIds: jest.fn(async () => ['campaign-a']),
      createCsvStream: jest.fn(() => Readable.from(['email\n'])),
      upload: jest.fn(),
      markCompleted: jest.fn(),
      markFailed: jest.fn(),
      deleteObject: jest.fn(),
    };

    await expect(processClaimedClientReportExport(cancelled, deps))
      .rejects.toThrow('is not running');
    expect(deps.createCsvStream).not.toHaveBeenCalled();
    expect(deps.upload).not.toHaveBeenCalled();
    expect(deps.markCompleted).not.toHaveBeenCalled();
    expect(deps.markFailed).not.toHaveBeenCalled();
  });
});
