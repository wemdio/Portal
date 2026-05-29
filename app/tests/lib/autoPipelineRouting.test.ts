/**
 * Unit tests for the auto-pipeline routing & filtering helpers.
 *
 * Routing — главный момент истины пайплайна: один и тот же endpoint-score
 * должен всегда вести в один и тот же bucket; пустой score или email должны
 * становиться `skipped`. Bucket с непустой sequence → routed; bucket с
 * пустой sequence → stored (клиент сам решил не писать в этот диапазон).
 */

import {
  buildExcludePatterns,
  decideRoute,
  shouldDoEmailWork,
  type EnrichmentResult,
  type ScoreBucket,
} from '@/lib/jobs/autoPipelineRunner';
import type { HhEmployer } from '@/lib/jobs/hhAutoParser';
import type { ClientLaunchSequence } from '@/lib/clientLaunch/types';

function mockEmployer(): HhEmployer {
  return {
    id: '1',
    name: 'TestCo',
    siteUrl: 'https://test.example',
    hhUrl: null,
    area: 'Москва',
    industries: [],
    employeeCount: 50,
  };
}

function mockEnrichment(overrides: Partial<EnrichmentResult>): EnrichmentResult {
  return {
    employer: mockEmployer(),
    domain: 'test.example',
    email: 'info@test.example',
    emailValidation: null,
    additionalEmails: [],
    score: 100,
    spf: 'v=spf1 -all',
    endpointRaw: null,
    enrichError: null,
    ...overrides,
  };
}

function nonEmptySequence(): ClientLaunchSequence {
  return {
    name: 'seq',
    steps: [{ subject: 'Hi', body: 'Hello', wait_days: 0 }],
  };
}

function emptySequence(): ClientLaunchSequence {
  return { name: 'seq', steps: [] };
}

function mockBucket(
  scoreMin: number,
  scoreMax: number | null,
  id: string,
  sequence: ClientLaunchSequence = nonEmptySequence(),
): ScoreBucket {
  return {
    id,
    label: `Bucket ${scoreMin}-${scoreMax ?? '∞'}`,
    score_min: scoreMin,
    score_max: scoreMax,
    instantly_campaign_id: `camp-${id}`,
    sequence,
  };
}

describe('shouldDoEmailWork — sequential enrichment gate', () => {
  const activeBuckets = [
    mockBucket(0, 1000, 'low', emptySequence()),
    mockBucket(1001, 15000, 'mid'),
    mockBucket(15001, null, 'high'),
  ];

  it('returns false for null score', () => {
    expect(shouldDoEmailWork(null, activeBuckets)).toBe(false);
  });

  it('returns false for score=0 (storage_only bucket)', () => {
    expect(shouldDoEmailWork(0, activeBuckets)).toBe(false);
  });

  it('returns false for score 1-1000 (empty sequence bucket)', () => {
    expect(shouldDoEmailWork(500, activeBuckets)).toBe(false);
  });

  it('returns true for score 1001-15000 (active bucket)', () => {
    expect(shouldDoEmailWork(5000, activeBuckets)).toBe(true);
  });

  it('returns true for score 15001+ (open-ended active bucket)', () => {
    expect(shouldDoEmailWork(5_000_000, activeBuckets)).toBe(true);
  });

  it('returns false for score in no bucket at all', () => {
    const gapped = [mockBucket(0, 1000, 'low', emptySequence()), mockBucket(15001, null, 'high')];
    // 5000 between the two ranges — out of buckets entirely.
    expect(shouldDoEmailWork(5000, gapped)).toBe(false);
  });

  describe('fallback: empty buckets array (fresh dry-run client)', () => {
    it('treats score > 0 as active when no buckets configured', () => {
      expect(shouldDoEmailWork(100, [])).toBe(true);
      expect(shouldDoEmailWork(50_000, [])).toBe(true);
    });

    it('treats score = 0 as inactive even with empty buckets', () => {
      expect(shouldDoEmailWork(0, [])).toBe(false);
    });

    it('treats null score as inactive even with empty buckets', () => {
      expect(shouldDoEmailWork(null, [])).toBe(false);
    });
  });
});

describe('decideRoute — happy path', () => {
  it('routes to matching range bucket', () => {
    const buckets = [
      mockBucket(0, 1000, 'low', emptySequence()),
      mockBucket(1001, 15000, 'mid'),
      mockBucket(15001, 1_000_000, 'high'),
      mockBucket(1_000_001, null, 'top'),
    ];
    const decision = decideRoute(mockEnrichment({ score: 5000 }), {
      score_buckets: buckets,
    });
    expect(decision.kind).toBe('routed');
    if (decision.kind === 'routed') {
      expect(decision.bucket.id).toBe('mid');
    }
  });

  it('routes to unbounded top bucket via score_max=null', () => {
    const buckets = [
      mockBucket(0, 1000, 'low', emptySequence()),
      mockBucket(1_000_001, null, 'top'),
    ];
    const decision = decideRoute(mockEnrichment({ score: 999_999_999 }), {
      score_buckets: buckets,
    });
    expect(decision.kind).toBe('routed');
    if (decision.kind === 'routed') {
      expect(decision.bucket.id).toBe('top');
    }
  });

  it('uses inclusive boundaries (score_min and score_max both included)', () => {
    const buckets = [mockBucket(100, 200, 'mid')];
    expect(decideRoute(mockEnrichment({ score: 100 }), { score_buckets: buckets }).kind).toBe('routed');
    expect(decideRoute(mockEnrichment({ score: 200 }), { score_buckets: buckets }).kind).toBe('routed');
    expect(decideRoute(mockEnrichment({ score: 99 }), { score_buckets: buckets }).kind).toBe('skipped');
    expect(decideRoute(mockEnrichment({ score: 201 }), { score_buckets: buckets }).kind).toBe('skipped');
  });
});

describe('decideRoute — stored (empty sequence)', () => {
  it('returns stored when matching bucket has empty sequence', () => {
    const buckets = [
      mockBucket(0, 1000, 'low', emptySequence()),
      mockBucket(1001, null, 'high'),
    ];
    const decision = decideRoute(mockEnrichment({ score: 500 }), {
      score_buckets: buckets,
    });
    expect(decision.kind).toBe('stored');
    if (decision.kind === 'stored') {
      expect(decision.bucket.id).toBe('low');
    }
  });

  it('returns stored when sequence.steps is missing entirely', () => {
    const bucket: ScoreBucket = {
      id: 'borked',
      label: 'No-sequence bucket',
      score_min: 0,
      score_max: 100,
      instantly_campaign_id: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sequence: { name: 'x' } as any,
    };
    const decision = decideRoute(mockEnrichment({ score: 50 }), {
      score_buckets: [bucket],
    });
    expect(decision.kind).toBe('stored');
  });
});

describe('decideRoute — skipped', () => {
  it('skips when no email even if score is valid', () => {
    const buckets = [mockBucket(0, 1000, 'low')];
    const decision = decideRoute(mockEnrichment({ email: null, score: 100 }), {
      score_buckets: buckets,
    });
    expect(decision.kind).toBe('skipped');
    if (decision.kind === 'skipped') {
      expect(decision.reason).toBe('no_email');
    }
  });

  it('skips when score is null and surfaces enrichError', () => {
    const buckets = [mockBucket(0, 1000, 'low')];
    const decision = decideRoute(
      mockEnrichment({ score: null, enrichError: 'HTTP 500' }),
      { score_buckets: buckets },
    );
    expect(decision.kind).toBe('skipped');
    if (decision.kind === 'skipped') {
      expect(decision.reason).toBe('HTTP 500');
    }
  });

  it('falls back to no_score reason when score is null and enrichError empty', () => {
    const buckets = [mockBucket(0, 1000, 'low')];
    const decision = decideRoute(
      mockEnrichment({ score: null, enrichError: null }),
      { score_buckets: buckets },
    );
    expect(decision.kind).toBe('skipped');
    if (decision.kind === 'skipped') {
      expect(decision.reason).toBe('no_score');
    }
  });

  it('skips when score falls outside all buckets', () => {
    const buckets = [
      mockBucket(0, 1000, 'low'),
      mockBucket(2000, 3000, 'mid'),
    ];
    const decision = decideRoute(mockEnrichment({ score: 1500 }), {
      score_buckets: buckets,
    });
    expect(decision.kind).toBe('skipped');
    if (decision.kind === 'skipped') {
      expect(decision.reason).toBe('score_out_of_buckets');
    }
  });
});

describe('decideRoute — bucket order matters', () => {
  it('returns the first matching bucket when ranges overlap (no validation here — UI prevents)', () => {
    const buckets = [
      mockBucket(0, 1000, 'first'),
      mockBucket(500, 1500, 'second'),  // overlaps with first
    ];
    const decision = decideRoute(mockEnrichment({ score: 750 }), {
      score_buckets: buckets,
    });
    expect(decision.kind).toBe('routed');
    if (decision.kind === 'routed') {
      expect(decision.bucket.id).toBe('first');
    }
  });
});

describe('buildExcludePatterns', () => {
  it('always includes built-in federal brand patterns', () => {
    const patterns = buildExcludePatterns([]);
    expect(patterns.some((p) => p.test('ПАО Сбербанк'))).toBe(true);
    expect(patterns.some((p) => p.test('Wildberries'))).toBe(true);
    expect(patterns.some((p) => p.test('ООО Яндекс'))).toBe(true);
  });

  it('compiles extra regex patterns from strings', () => {
    const patterns = buildExcludePatterns(['тест(овая)?', 'company\\.exe']);
    expect(patterns.some((p) => p.test('Тестовая компания'))).toBe(true);
    expect(patterns.some((p) => p.test('My company.exe'))).toBe(true);
  });

  it('silently ignores invalid regex without throwing', () => {
    const patterns = buildExcludePatterns(['[invalid', 'valid']);
    expect(patterns.some((p) => p.test('valid match'))).toBe(true);
    expect(patterns.every((p) => p instanceof RegExp)).toBe(true);
  });

  it('skips empty / whitespace-only patterns', () => {
    const baseLen = buildExcludePatterns([]).length;
    const patternsWithEmpties = buildExcludePatterns(['', '   ', '\t']);
    expect(patternsWithEmpties.length).toBe(baseLen);
  });
});
