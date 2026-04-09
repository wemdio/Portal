import {
  computePainScore,
  computeConfidenceScore,
  classifyCandidate,
  type ReputationCandidate,
  type ReputationEvidence,
} from '@/lib/reputationFinder/scoring';

function makeCandidate(overrides: Partial<ReputationCandidate> = {}): ReputationCandidate {
  return {
    id: 'test-1',
    jobId: 'job-1',
    company: 'ООО Тест',
    city: 'Москва',
    category: 'Стоматология',
    sourceMode: 'local_reviews',
    primarySource: 'yandex_maps',
    primarySourceUrl: 'https://yandex.ru/maps/org/123',
    website: null,
    rating: 3.5,
    reviewsCount: 45,
    negativeReviews30d: 4,
    negativeReviews90d: 8,
    unansweredNegativeReviews: 3,
    negativeSerpResultsTop10: 0,
    issueThemes: ['сервис', 'ожидание'],
    proofUrls: ['https://yandex.ru/maps/org/123/reviews'],
    proofSnippets: ['Ужасный сервис, ждали 2 часа'],
    collectedAt: new Date().toISOString(),
    secondSourceConfirmed: false,
    ...overrides,
  };
}

describe('computePainScore', () => {
  it('scores high for low rating + many reviews + fresh negatives + unanswered', () => {
    const c = makeCandidate({
      rating: 3.2,
      reviewsCount: 60,
      negativeReviews30d: 5,
      negativeReviews90d: 10,
      unansweredNegativeReviews: 4,
      issueThemes: ['сервис', 'сервис', 'сервис'],
      secondSourceConfirmed: true,
    });
    const score = computePainScore(c);
    expect(score).toBeGreaterThanOrEqual(80);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('scores medium for borderline rating with some negatives', () => {
    const c = makeCandidate({
      rating: 4.0,
      reviewsCount: 35,
      negativeReviews30d: 2,
      negativeReviews90d: 4,
      unansweredNegativeReviews: 1,
      issueThemes: [],
      secondSourceConfirmed: false,
    });
    const score = computePainScore(c);
    expect(score).toBeGreaterThanOrEqual(30);
    expect(score).toBeLessThan(70);
  });

  it('scores low for decent rating with few reviews', () => {
    const c = makeCandidate({
      rating: 4.5,
      reviewsCount: 50,
      negativeReviews30d: 0,
      negativeReviews90d: 1,
      unansweredNegativeReviews: 0,
    });
    const score = computePainScore(c);
    expect(score).toBeLessThan(30);
  });

  it('adds SERP pain for brand_serp mode', () => {
    const c = makeCandidate({
      sourceMode: 'brand_serp',
      rating: 0,
      reviewsCount: 0,
      negativeReviews30d: 0,
      negativeReviews90d: 0,
      unansweredNegativeReviews: 0,
      negativeSerpResultsTop10: 3,
    });
    const score = computePainScore(c);
    expect(score).toBeGreaterThanOrEqual(50);
  });

  it('caps at 100', () => {
    const c = makeCandidate({
      rating: 2.0,
      reviewsCount: 200,
      negativeReviews30d: 20,
      negativeReviews90d: 50,
      unansweredNegativeReviews: 15,
      issueThemes: ['a', 'a', 'a'],
      secondSourceConfirmed: true,
      negativeSerpResultsTop10: 5,
    });
    expect(computePainScore(c)).toBe(100);
  });
});

describe('computeConfidenceScore', () => {
  it('high when source URL, geo match, snippets, second source', () => {
    const c = makeCandidate({
      primarySourceUrl: 'https://yandex.ru/maps/org/123',
      proofSnippets: ['bad review'],
      secondSourceConfirmed: true,
      reviewsCount: 30,
    });
    const score = computeConfidenceScore(c);
    expect(score).toBeGreaterThanOrEqual(70);
  });

  it('penalizes missing proof', () => {
    const c = makeCandidate({
      primarySourceUrl: '',
      proofSnippets: [],
      secondSourceConfirmed: false,
      reviewsCount: 5,
    });
    const score = computeConfidenceScore(c);
    expect(score).toBeLessThan(50);
  });

  it('penalizes low review count', () => {
    const c = makeCandidate({ reviewsCount: 3 });
    const score = computeConfidenceScore(c);
    expect(score).toBeLessThan(60);
  });
});

describe('classifyCandidate', () => {
  it('auto_export for high pain + high confidence', () => {
    const c = makeCandidate({
      rating: 3.0,
      reviewsCount: 80,
      negativeReviews30d: 8,
      negativeReviews90d: 15,
      unansweredNegativeReviews: 5,
      issueThemes: ['сервис', 'сервис', 'сервис'],
      secondSourceConfirmed: true,
      proofSnippets: ['terrible'],
    });
    const result = classifyCandidate(c);
    expect(result.classification).toBe('auto_export');
    expect(result.painScore).toBeGreaterThanOrEqual(60);
    expect(result.confidenceScore).toBeGreaterThanOrEqual(70);
  });

  it('review for medium scores', () => {
    const c = makeCandidate({
      rating: 3.9,
      reviewsCount: 25,
      negativeReviews30d: 2,
      negativeReviews90d: 5,
      unansweredNegativeReviews: 2,
      secondSourceConfirmed: false,
    });
    const result = classifyCandidate(c);
    expect(['review', 'auto_export']).toContain(result.classification);
  });

  it('discard for weak signals', () => {
    const c = makeCandidate({
      rating: 4.8,
      reviewsCount: 10,
      negativeReviews30d: 0,
      negativeReviews90d: 0,
      unansweredNegativeReviews: 0,
      proofSnippets: [],
      primarySourceUrl: '',
    });
    const result = classifyCandidate(c);
    expect(result.classification).toBe('discard');
  });
});
