import { extractActiveJobIds } from '@/lib/enrich/jobLifecycle';

describe('enrichment job lifecycle', () => {
  it('extracts only running and pending job ids', () => {
    const jobs = [
      { id: 'a', status: 'running' },
      { id: 'b', status: 'pending' },
      { id: 'c', status: 'completed' },
      { id: 'd', status: 'failed' },
      { id: 'e', status: 'cancelled' },
    ];

    expect(extractActiveJobIds(jobs)).toEqual(['a', 'b']);
  });
});
