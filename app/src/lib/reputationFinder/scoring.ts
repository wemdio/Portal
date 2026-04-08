/* ---------- types ---------- */

export type SourceMode = 'local_reviews' | 'brand_serp' | 'auto_search';
export type PrimarySource = 'yandex_maps' | '2gis' | 'flamp' | 'serper';

export interface ReputationCandidate {
  id: string;
  jobId: string;
  company: string;
  city: string | null;
  category: string | null;
  sourceMode: SourceMode;
  primarySource: PrimarySource;
  primarySourceUrl: string | null;
  website: string | null;
  rating: number;
  reviewsCount: number;
  negativeReviews30d: number;
  negativeReviews90d: number;
  unansweredNegativeReviews: number;
  negativeSerpResultsTop10: number;
  issueThemes: string[];
  proofUrls: string[];
  proofSnippets: string[];
  collectedAt: string;
  secondSourceConfirmed: boolean;
}

export interface ReputationEvidence {
  id: string;
  candidateId: string;
  source: PrimarySource;
  url: string;
  snippet: string;
  sentiment: 'negative' | 'neutral' | 'positive';
  detectedAt: string;
}

export type Classification = 'auto_export' | 'review' | 'discard';

export interface ClassificationResult {
  painScore: number;
  confidenceScore: number;
  classification: Classification;
}

/* ---------- helpers ---------- */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/* ---------- Pain Score ---------- */

/**
 * 0..100. Higher = more reputation pain, better lead.
 *
 * Dimensions:
 *  - Low rating (vs baseline 4.5 on RU maps)
 *  - Volume of reviews (statistical relevance)
 *  - Fresh negative reviews (30d / 90d)
 *  - Unanswered negatives (company doesn't manage reputation)
 *  - Negative SERP results in top-10 (brand_serp mode)
 *  - Issue theme concentration (repeated theme = systemic)
 *  - Second-source confirmation
 */
export function computePainScore(c: ReputationCandidate): number {
  let pain = 0;

  // ── rating dimension (0..30) ──
  // baseline 4.5; pain grows as rating drops below 4.5
  if (c.rating > 0 && c.reviewsCount >= 5) {
    const ratingDelta = Math.max(0, 4.5 - c.rating);
    pain += clamp(ratingDelta * 20, 0, 30);
  }

  // ── review volume (0..10) ──
  // enough reviews = statistically relevant
  if (c.reviewsCount >= 20) pain += 5;
  if (c.reviewsCount >= 50) pain += 3;
  if (c.reviewsCount >= 100) pain += 2;

  // ── fresh negative reviews (0..25) ──
  pain += clamp(c.negativeReviews30d * 4, 0, 16);
  pain += clamp((c.negativeReviews90d - c.negativeReviews30d) * 1.5, 0, 9);

  // ── unanswered negatives (0..15) ──
  pain += clamp(c.unansweredNegativeReviews * 4, 0, 15);

  // ── negative SERP ──
  // In brand_serp mode this is the primary signal, so weight and cap are higher
  if (c.sourceMode === 'brand_serp') {
    pain += clamp(c.negativeSerpResultsTop10 * 18, 0, 50);
  } else {
    pain += clamp(c.negativeSerpResultsTop10 * 8, 0, 25);
  }

  // ── issue theme concentration (0..5) ──
  if (c.issueThemes.length >= 3) {
    const freq = new Map<string, number>();
    for (const t of c.issueThemes) freq.set(t, (freq.get(t) ?? 0) + 1);
    const maxFreq = Math.max(...freq.values());
    if (maxFreq >= 3) pain += 5;
    else if (maxFreq >= 2) pain += 2;
  }

  // ── second-source bonus (0..5) ──
  if (c.secondSourceConfirmed) pain += 5;

  return clamp(Math.round(pain), 0, 100);
}

/* ---------- Confidence Score ---------- */

/**
 * 0..100. Higher = more trustworthy data.
 *
 * Dimensions:
 *  - Has primary source URL (verifiable)
 *  - Has proof snippets
 *  - Review count (statistical mass)
 *  - Second-source confirmation
 *  - Has geo data
 */
export function computeConfidenceScore(c: ReputationCandidate): number {
  let conf = 0;

  // ── source URL present (0..25) ──
  if (c.primarySourceUrl) conf += 25;

  // ── proof snippets (0..20) ──
  if (c.proofSnippets.length > 0) conf += 15;
  if (c.proofSnippets.length >= 3) conf += 5;

  // ── review count (0..20) ──
  if (c.reviewsCount >= 10) conf += 10;
  if (c.reviewsCount >= 30) conf += 5;
  if (c.reviewsCount >= 50) conf += 5;

  // ── second source (0..20) ──
  if (c.secondSourceConfirmed) conf += 20;

  // ── geo data (0..15) ──
  if (c.city) conf += 10;
  if (c.category) conf += 5;

  return clamp(Math.round(conf), 0, 100);
}

/* ---------- Classification ---------- */

const THRESHOLDS = {
  autoExport: { pain: 60, confidence: 70 },
  review:     { pain: 30, confidence: 40 },
} as const;

export function classifyCandidate(
  c: ReputationCandidate,
  thresholds = THRESHOLDS,
): ClassificationResult {
  const painScore = computePainScore(c);
  const confidenceScore = computeConfidenceScore(c);

  let classification: Classification;

  if (
    painScore >= thresholds.autoExport.pain &&
    confidenceScore >= thresholds.autoExport.confidence
  ) {
    classification = 'auto_export';
  } else if (
    painScore >= thresholds.review.pain ||
    confidenceScore >= thresholds.review.confidence
  ) {
    classification = 'review';
  } else {
    classification = 'discard';
  }

  return { painScore, confidenceScore, classification };
}
