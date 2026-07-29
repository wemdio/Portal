/** @jest-environment node */

import {
  HeSiteProfileSchema,
  HeCompetitorListSchema,
  HeBrandCloudSchema,
  HeHypothesesBatchSchema,
  HeEvidenceVerdictSchema,
  HeClusteringSchema,
  HeVocabSchema,
  HeBaseAnalysisSchema,
  HeTemplatePlanSchema,
} from '@/lib/hypothesisEngine/schemas';

describe('hypothesisEngine schemas — валидные payload', () => {
  it('site profile: минимум + дефолты', () => {
    const r = HeSiteProfileSchema.safeParse({ company_name: 'Польза', product_summary: 'Аутрич-агентство' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.price_tier).toBe('unknown');
      expect(r.data.usp).toEqual([]);
      expect(r.data.current_clients).toEqual([]);
    }
  });

  it('competitors: список с одним конкурентом проходит, why/geo дефолтятся', () => {
    const r = HeCompetitorListSchema.safeParse({ competitors: [{ name: 'X', url: 'https://x.ru' }] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.competitors[0].why).toBe('');
  });

  it('brand cloud: сущность с классификацией potential', () => {
    const r = HeBrandCloudSchema.safeParse({
      entities: [{ name: 'Сбер', classification: 'potential', potential_pct: 70 }],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.entities[0].kind).toBe('other');
  });

  it('hypotheses batch: кандидат tier 1..3 с search_queries и обязательным fit_rationale', () => {
    const fit = 'Собственник производства БАД → выйти в маркетплейсы → нет отдела продаж под канал → аутрич-кампания под ключ';
    const r = HeHypothesesBatchSchema.safeParse({
      hypotheses: [
        { tier: 3, title: 'Производители БАД', description: 'd', fit_rationale: fit, potential_pct: 25, search_queries: ['q1', 'q2'] },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.hypotheses[0].rationale).toBe('');
      expect(r.data.hypotheses[0].fit_rationale).toBe(fit);
    }
  });

  it('evidence verdict: keep с доказательствами; merge_with_title дефолтится в null', () => {
    const r = HeEvidenceVerdictSchema.safeParse({
      verdict: 'keep',
      fit_rationale: 'Директор по продажам → рост выручки → мало входящих лидов → аутрич-кампания',
      evidence: [{ claim: 'Рынок растёт', source_url: 'https://rbc.ru/x', quote: 'объём рынка вырос' }],
      potential_pct: 60,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.merge_with_title).toBeNull();
      expect(r.data.fit_rationale).toContain('Директор по продажам');
    }
  });

  it('evidence verdict: fit_rationale при пропуске дефолтится в пустую строку (drop)', () => {
    const r = HeEvidenceVerdictSchema.safeParse({ verdict: 'drop', potential_pct: 5 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.fit_rationale).toBe('');
  });

  it('clustering: вертикаль с member_titles', () => {
    const r = HeClusteringSchema.safeParse({
      verticals: [{ name: 'Финтех и платежи', member_titles: ['Банки', 'Необанки'] }],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.verticals[0].synonyms).toEqual([]);
  });

  it('vocab: kind дефолтится в synonym, optional-поля отсутствуют', () => {
    const r = HeVocabSchema.safeParse({
      company_types: [{ term: 'iGaming' }],
      job_titles: [{ title: 'Коммерческий директор', audience_side: 'buyer' }],
      search_queries: [{ source: 'Registry', query: 'ОКВЭД 62.01 — Разработка компьютерного программного обеспечения' }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.company_types[0].kind).toBe('synonym');
      expect(r.data.job_titles[0].alt_names).toBeUndefined();
      expect(r.data.search_queries[0].notes).toBeUndefined();
    }
  });

  it('vocab: обе стороны аудитории buyer/campaign_target проходят', () => {
    const r = HeVocabSchema.safeParse({
      job_titles: [
        { title: 'Собственник', audience_side: 'buyer' },
        { title: 'HRD', audience_side: 'campaign_target', alt_names: ['HR Director', 'Директор по персоналу'] },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.job_titles[0].audience_side).toBe('buyer');
      expect(r.data.job_titles[1].audience_side).toBe('campaign_target');
    }
  });

  it('base analysis: распределения с share_pct', () => {
    const r = HeBaseAnalysisSchema.safeParse({
      geo_distribution: [{ value: 'Москва', share_pct: 55 }],
      recommended_angles: ['угол'],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.industry_distribution).toEqual([]);
  });

  it('template plan: fixed_block + operators + additions', () => {
    const r = HeTemplatePlanSchema.safeParse({
      fixed_block: 'костяк',
      personalization_plan: [{ letter_index: 1, operators: [{ var: 'firstName', column: 'Имя' }] }],
      segment_additions: [{ letter_index: 2, addition: 'пример под HoReCa' }],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.segment_additions[0].why).toBe('');
  });
});

describe('hypothesisEngine schemas — невалидные payload', () => {
  it('site profile: левый price_tier и пропуск company_name отклоняются', () => {
    expect(HeSiteProfileSchema.safeParse({ company_name: 'X', product_summary: 'Y', price_tier: 'premium' }).success).toBe(false);
    expect(HeSiteProfileSchema.safeParse({ product_summary: 'Y' }).success).toBe(false);
  });

  it('hypotheses batch: tier вне 1..3, строковый tier и % вне 0..100 отклоняются', () => {
    const base = { title: 't', description: 'd', fit_rationale: 'f', potential_pct: 10 };
    expect(HeHypothesesBatchSchema.safeParse({ hypotheses: [{ ...base, tier: 4 }] }).success).toBe(false);
    expect(HeHypothesesBatchSchema.safeParse({ hypotheses: [{ ...base, tier: '2' }] }).success).toBe(false);
    expect(HeHypothesesBatchSchema.safeParse({ hypotheses: [{ ...base, tier: 2, potential_pct: 101 }] }).success).toBe(false);
    expect(HeHypothesesBatchSchema.safeParse({ hypotheses: [] }).success).toBe(false);
  });

  it('hypotheses batch: кандидат без fit_rationale или с пустым отклоняется', () => {
    const base = { tier: 2, title: 't', description: 'd', potential_pct: 10 };
    expect(HeHypothesesBatchSchema.safeParse({ hypotheses: [base] }).success).toBe(false);
    expect(
      HeHypothesesBatchSchema.safeParse({ hypotheses: [{ ...base, fit_rationale: '' }] }).success,
    ).toBe(false);
    // Позитивный контроль: тот же кандидат с непустым fit_rationale проходит —
    // значит отказ выше именно из-за fit_rationale.
    expect(
      HeHypothesesBatchSchema.safeParse({ hypotheses: [{ ...base, fit_rationale: 'ЛПР → цель → боль → оффер' }] })
        .success,
    ).toBe(true);
  });

  it('evidence verdict: неизвестный verdict, длинная quote и не-URL-структура отклоняются', () => {
    const base = { verdict: 'keep', potential_pct: 10 };
    expect(HeEvidenceVerdictSchema.safeParse({ ...base, verdict: 'verify' }).success).toBe(false);
    expect(
      HeEvidenceVerdictSchema.safeParse({
        ...base,
        evidence: [{ claim: 'c', source_url: 'https://a.ru', quote: 'q'.repeat(501) }],
      }).success,
    ).toBe(false);
    expect(HeEvidenceVerdictSchema.safeParse({ verdict: 'keep' }).success).toBe(false); // нет potential_pct
  });

  it('clustering: пустой member_titles отклоняется', () => {
    expect(HeClusteringSchema.safeParse({ verticals: [{ name: 'V', member_titles: [] }] }).success).toBe(false);
    expect(HeClusteringSchema.safeParse({ verticals: [] }).success).toBe(false);
  });

  it('vocab: неизвестный kind отклоняется', () => {
    expect(HeVocabSchema.safeParse({ company_types: [{ term: 'X', kind: 'weird' }] }).success).toBe(false);
  });

  it('vocab: должность без audience_side или с левым значением отклоняется', () => {
    expect(HeVocabSchema.safeParse({ job_titles: [{ title: 'HRD' }] }).success).toBe(false);
    expect(HeVocabSchema.safeParse({ job_titles: [{ title: 'HRD', audience_side: 'lead' }] }).success).toBe(false);
  });

  it('base analysis: share_pct >100 отклоняется', () => {
    expect(
      HeBaseAnalysisSchema.safeParse({ geo_distribution: [{ value: 'Москва', share_pct: 140 }] }).success,
    ).toBe(false);
  });

  it('template plan: letter_index 0 и оператор без column отклоняются', () => {
    const fixed = { fixed_block: 'b' };
    expect(
      HeTemplatePlanSchema.safeParse({ ...fixed, segment_additions: [{ letter_index: 0, addition: 'a' }] }).success,
    ).toBe(false);
    expect(
      HeTemplatePlanSchema.safeParse({
        ...fixed,
        personalization_plan: [{ letter_index: 1, operators: [{ var: 'firstName' }] }],
      }).success,
    ).toBe(false);
  });
});
