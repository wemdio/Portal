import {
  extractActiveJobIds,
  shouldFinalizeEnrichmentJob,
} from '@/lib/enrich/jobLifecycle';

describe('enrichment job lifecycle', () => {
  it('keeps preparing, pending, and running jobs active', () => {
    const jobs = [
      { id: 'a', status: 'preparing' },
      { id: 'b', status: 'running' },
      { id: 'c', status: 'pending' },
      { id: 'd', status: 'completed' },
      { id: 'e', status: 'failed' },
      { id: 'f', status: 'cancelled' },
    ];

    expect(extractActiveJobIds(jobs)).toEqual(['a', 'b', 'c']);
  });

  it('does not finalize an empty or incomplete queue as 0/N', () => {
    expect(
      shouldFinalizeEnrichmentJob(676, {
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
      }),
    ).toBe(false);

    expect(
      shouldFinalizeEnrichmentJob(676, {
        pending: 676,
        processing: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
      }),
    ).toBe(false);

    expect(
      shouldFinalizeEnrichmentJob(676, {
        pending: 0,
        processing: 0,
        completed: 650,
        failed: 20,
        skipped: 6,
      }),
    ).toBe(true);

    expect(
      shouldFinalizeEnrichmentJob(676, {
        pending: 0,
        processing: 0,
        completed: 677,
        failed: 0,
        skipped: 0,
      }),
    ).toBe(false);
  });
});
