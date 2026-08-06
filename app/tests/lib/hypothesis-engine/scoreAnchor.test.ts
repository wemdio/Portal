/**
 * Tests for lib/hypothesisEngine/scoreAnchor — дата-якорь potential_pct:
 * 0.7×LLM + 0.3×datasetScore, datasetScore = clamp(50×reply/baseline, 5, 95).
 */

import { anchorPotentialPct } from '@/lib/hypothesisEngine/scoreAnchor';
import { getSegmentStats } from '@/lib/hypothesisEngine/datasetStats';

jest.mock('@/lib/hypothesisEngine/datasetStats', () => ({
  getSegmentStats: jest.fn(),
}));

const statsMock = getSegmentStats as unknown as jest.Mock;

function statsOf(replyPct: number | null, baselinePct: number | null) {
  return {
    matched_segments: ['it_software_saas'],
    campaigns: 10,
    sent: 50000,
    replies: 500,
    reply_pct: replyPct,
    baseline_pct: baselinePct,
    top_subjects: [],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('anchorPotentialPct', () => {
  it('returns the LLM pct untouched when there is no honest dataset match', async () => {
    statsMock.mockResolvedValue(statsOf(null, 1.03));
    const r = await anchorPotentialPct(60, 'Нечто нишевое', 'ru');
    expect(r).toEqual({ pct: 60, applied: false });
  });

  it('segment exactly at baseline → dataset score 50 → mild pull toward 50', async () => {
    statsMock.mockResolvedValue(statsOf(1.03, 1.03));
    const r = await anchorPotentialPct(80, 'IT', 'ru');
    // 0.7×80 + 0.3×50 = 71
    expect(r.applied).toBe(true);
    expect(r.pct).toBe(71);
  });

  it('hot segment (2× baseline) caps dataset score at 95 and lifts the pct', async () => {
    statsMock.mockResolvedValue(statsOf(2.06, 1.03));
    const r = await anchorPotentialPct(40, 'IT', 'ru');
    // 0.7×40 + 0.3×95 = 56.5 → 57 (Math.round)
    expect(r.pct).toBe(57);
  });

  it('cold segment (0.5× baseline) pulls the pct down', async () => {
    statsMock.mockResolvedValue(statsOf(0.515, 1.03));
    const r = await anchorPotentialPct(80, 'IT', 'ru');
    // 0.7×80 + 0.3×25 = 63.5 → 64
    expect(r.pct).toBe(64);
  });

  it('never anchors us-market hypotheses (RU dataset)', async () => {
    const r = await anchorPotentialPct(55, 'Logistics', 'us');
    expect(r).toEqual({ pct: 55, applied: false });
    expect(statsMock).not.toHaveBeenCalled();
  });

  it('dataset failure → unchanged pct (never throws)', async () => {
    statsMock.mockRejectedValue(new Error('dataset down'));
    const r = await anchorPotentialPct(45, 'IT', 'ru');
    expect(r).toEqual({ pct: 45, applied: false });
  });
});
