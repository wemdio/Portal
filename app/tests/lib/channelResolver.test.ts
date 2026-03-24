/** @jest-environment node */

import { resolveChannelCandidate } from '@/lib/cisLeads/channelResolver';

describe('channelResolver', () => {
  it('auto-saves high confidence candidate', () => {
    const out = resolveChannelCandidate({
      channel: 'linkedin',
      score: 82,
      hasTelegram: true,
      title: 'Генеральный директор',
      evidence: { source: 'serper' },
    });
    expect(out.decision).toBe('auto_save');
    expect(out.score).toBeGreaterThanOrEqual(82);
    expect(out.confidence).toBeGreaterThanOrEqual(0.82);
  });

  it('marks medium candidate for review', () => {
    const out = resolveChannelCandidate({
      channel: 'linkedin',
      score: 54,
      evidence: { source: 'serper' },
    });
    expect(out.decision).toBe('review');
    expect(out.reason).toBe('needs_manual_review');
  });

  it('rejects low confidence candidate', () => {
    const out = resolveChannelCandidate({
      channel: 'vk',
      score: 31,
      evidence: { source: 'serper' },
    });
    expect(out.decision).toBe('reject');
    expect(out.reason).toBe('low_confidence');
  });
});
