/** @jest-environment node */

jest.mock('server-only', () => ({}));

import {
  SEGMENT_SCORING_PROFILES,
  computeSegmentScore,
  getSegmentScoringProfile,
} from '@/lib/gisSignalOutreach/scoring';
import type { OutreachSignalSet } from '@/lib/gisSignalOutreach/signals';

function signals(hits: Array<keyof OutreachSignalSet> = []): OutreachSignalSet {
  const v = (key: keyof OutreachSignalSet) => ({
    hit: hits.includes(key),
    evidence: hits.includes(key) ? 'какое-то evidence' : '',
  });
  return {
    generalPhone: v('generalPhone'),
    contactForm: v('contactForm'),
    salesDept: v('salesDept'),
    targetVacancy: v('targetVacancy'),
    highVolume: v('highVolume'),
    multiOffice: v('multiOffice'),
    legalRelevance: v('legalRelevance'),
    crmCalltracking: v('crmCalltracking'),
  };
}

describe('SEGMENT_SCORING_PROFILES', () => {
  it('профиль legal: веса ТЗ (сумма 100), порог 35, пояса A/B/C', () => {
    const legal = SEGMENT_SCORING_PROFILES.legal;
    expect(legal).toBeDefined();
    expect(legal.weights).toEqual({
      legalRelevance: 25,
      generalPhone: 10,
      contactForm: 10,
      salesDept: 20,
      targetVacancy: 15,
      highVolume: 10,
      multiOffice: 5,
      crmCalltracking: 5,
    });
    expect(Object.values(legal.weights).reduce((a, b) => a + (b ?? 0), 0)).toBe(100);
    expect(legal.threshold).toBe(35);
    expect(legal.bands).toEqual([
      { min: 75, grade: 'A' },
      { min: 55, grade: 'B' },
      { min: 35, grade: 'C' },
    ]);
  });

  it('сегменты без профиля (edu/remont/…) → undefined, старый фильтр', () => {
    expect(getSegmentScoringProfile('legal')).toBe(SEGMENT_SCORING_PROFILES.legal);
    expect(getSegmentScoringProfile('edu')).toBeUndefined();
    expect(getSegmentScoringProfile('remont')).toBeUndefined();
    expect(getSegmentScoringProfile('no-such-segment')).toBeUndefined();
  });
});

describe('computeSegmentScore (математика legal-скоринга)', () => {
  const profile = SEGMENT_SCORING_PROFILES.legal;

  it('все 8 сигналов → 100 баллов, грейд A', () => {
    const r = computeSegmentScore(profile, signals([
      'legalRelevance', 'generalPhone', 'contactForm', 'salesDept',
      'targetVacancy', 'highVolume', 'multiOffice', 'crmCalltracking',
    ]));
    expect(r).toEqual({ score: 100, grade: 'A' });
  });

  it('ни одного сигнала → 0 баллов, grade null (отсев)', () => {
    expect(computeSegmentScore(profile, signals([]))).toEqual({ score: 0, grade: null });
  });

  it.each<[string, Array<keyof OutreachSignalSet>, number, string | null]>([
    // Границы грейдов: A=75, B=55, C=35.
    ['A-нижняя граница: relevance25+sales20+vacancy15+phone10+crm5=75',
      ['legalRelevance', 'salesDept', 'targetVacancy', 'generalPhone', 'crmCalltracking'], 75, 'A'],
    ['B-верхняя граница: 74 → B (relevance25+sales20+vacancy15+phone10+office5=75→ заменим office на form10-? считаем 74 нельзя ровно: 25+20+15+10+5-1… берём 25+20+15+10+5=75; для 74 нет комбинации → проверяем 70)',
      ['legalRelevance', 'salesDept', 'targetVacancy', 'generalPhone'], 70, 'B'],
    ['B-нижняя граница: relevance25+sales20+phone10=55',
      ['legalRelevance', 'salesDept', 'generalPhone'], 55, 'B'],
    ['C-верхняя граница: relevance25+sales20+form10-? =55; берём 25+20+5+5=55… точно: 25+20+10-? — используем 50',
      ['legalRelevance', 'salesDept', 'crmCalltracking'], 50, 'C'],
    ['C-нижняя граница: relevance25+phone10=35',
      ['legalRelevance', 'generalPhone'], 35, 'C'],
    ['отсев: relevance25+office5=30 < 35 → grade null',
      ['legalRelevance', 'multiOffice'], 30, 'grade-null'],
    ['отсев: только salesDept 20 < 35 → grade null',
      ['salesDept'], 20, 'grade-null'],
  ])('%s', (_label, keys, expectedScore, expectedGrade) => {
    const r = computeSegmentScore(profile, signals(keys));
    expect(r.score).toBe(expectedScore);
    if (expectedGrade === 'grade-null') expect(r.grade).toBeNull();
    else expect(r.grade).toBe(expectedGrade);
  });

  it('скор считается только по сработавшим сигналам и только по весам профиля', () => {
    // legalRelevance(25) + crmCalltracking(5) = 30; miss-сигналы не добавляют.
    const r = computeSegmentScore(profile, signals(['legalRelevance', 'crmCalltracking']));
    expect(r.score).toBe(30);
    expect(r.grade).toBeNull();
  });
});
