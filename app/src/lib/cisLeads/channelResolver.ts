export type ResolverDecision = 'auto_save' | 'review' | 'reject';

export interface ChannelCandidateInput {
  channel: 'linkedin' | 'vk' | 'facebook' | 'telegram' | 'instagram' | 'whatsapp';
  score: number;
  hasTelegram?: boolean;
  hasTelegramId?: boolean;
  waRegistered?: boolean;
  title?: string | null;
  evidence: Record<string, string>;
}

export interface ChannelResolution {
  score: number;
  confidence: number;
  decision: ResolverDecision;
  reason: string;
  evidence: Record<string, string>;
}

export function resolveChannelCandidate(input: ChannelCandidateInput): ChannelResolution {
  let score = Math.max(0, Math.min(100, Number(input.score) || 0));

  // Cross-channel reinforcement
  if (input.channel === 'linkedin' && input.hasTelegram) score += 12;
  if (input.channel === 'linkedin' && input.hasTelegramId) score += 8;
  if (input.channel === 'whatsapp' && input.waRegistered) score += 10;
  if (input.title && /\b(директор|ceo|founder|owner|head)\b/i.test(input.title)) score += 5;

  score = Math.max(0, Math.min(100, score));
  const confidence = Math.round(score) / 100;

  let decision: ResolverDecision = 'reject';
  let reason = 'low_confidence';
  if (score >= 70) {
    decision = 'auto_save';
    reason = 'high_confidence';
  } else if (score >= 50) {
    decision = 'review';
    reason = 'needs_manual_review';
  }

  return { score, confidence, decision, reason, evidence: input.evidence };
}
