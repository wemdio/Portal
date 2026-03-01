import { extractActiveBriefScoringJobIds, isActiveBriefScoringJobStatus } from '@/lib/briefScoring/jobLifecycle';

describe('brief scoring job lifecycle', () => {
  it('detects active statuses', () => {
    expect(isActiveBriefScoringJobStatus('pending')).toBe(true);
    expect(isActiveBriefScoringJobStatus('running')).toBe(true);
    expect(isActiveBriefScoringJobStatus('completed')).toBe(false);
    expect(isActiveBriefScoringJobStatus('failed')).toBe(false);
    expect(isActiveBriefScoringJobStatus('cancelled')).toBe(false);
    expect(isActiveBriefScoringJobStatus(null)).toBe(false);
    expect(isActiveBriefScoringJobStatus(undefined)).toBe(false);
  });

  it('extracts only pending and running ids', () => {
    const jobs = [
      { id: 'j1', status: 'pending' },
      { id: 'j2', status: 'running' },
      { id: 'j3', status: 'completed' },
      { id: 'j4', status: 'failed' },
      { id: 'j5', status: 'cancelled' },
    ];

    expect(extractActiveBriefScoringJobIds(jobs)).toEqual(['j1', 'j2']);
  });
});

