/** @jest-environment node */

/**
 * Structured RU seasonality is deliberately a calendar/evidence contract,
 * not a keyword heuristic.  Evidence-stage persists the verified annual
 * windows; queue/launch code evaluates those windows for the current Moscow
 * date and freezes the result in a stable priority snapshot.
 */

import {
  buildRuSeasonalityPrioritySnapshot,
  evaluateRuSeasonality,
  moscowDateKey,
  normalizeVerifiedRuSeasonality,
  readStoredRuSeasonality,
  type VeRuSeasonality,
  type VeRuSeasonalityWindow,
} from '@/lib/verticalEngineV2/ruSeasonality';
import type { VeEvidenceItem } from '@/lib/verticalEngineV2/types';
import { buildBaseAnalysisMessages } from '@/lib/verticalEngineV2/prompts/baseAnalyze';

const SOURCE_URL = 'https://research.example/education-season';
const SOURCE_QUOTE = 'Основной набор учеников проходит с августа по сентябрь.';
const AVOID_SOURCE_QUOTE = 'С октября по май руководители школ не выбирают новых подрядчиков.';

const VERIFIED_EVIDENCE: VeEvidenceItem = {
  claim: 'Пик набора приходится на начало учебного года.',
  source_url: SOURCE_URL,
  quote: SOURCE_QUOTE,
};

const VERIFIED_AVOID_EVIDENCE: VeEvidenceItem = {
  claim: 'С октября по май ЛПР школ недоступны для выбора подрядчиков.',
  source_url: SOURCE_URL,
  quote: AVOID_SOURCE_QUOTE,
};

const SEPTEMBER_PEAK: VeRuSeasonalityWindow = {
  kind: 'peak',
  label: 'Набор к началу учебного года',
  start_mm_dd: '09-01',
  end_mm_dd: '09-30',
  lead_days: 45,
  evidence: [VERIFIED_EVIDENCE],
};

const OCTOBER_TO_MAY_AVOID: VeRuSeasonalityWindow = {
  kind: 'avoid',
  label: 'Низкий сезон после завершения набора',
  start_mm_dd: '10-01',
  end_mm_dd: '05-31',
  evidence: [VERIFIED_AVOID_EVIDENCE],
};

function seasonal(windows: VeRuSeasonalityWindow[]): VeRuSeasonality {
  return {
    version: 1,
    classification: 'seasonal',
    confidence: 'high',
    rationale: 'Спрос привязан к учебному году.',
    windows,
    evidence: windows.flatMap((window) => window.evidence),
  };
}

const NEUTRAL: VeRuSeasonality = {
  version: 1,
  classification: 'neutral',
  confidence: 'high',
  rationale: 'Подтверждён выраженно круглогодичный спрос.',
  windows: [],
  evidence: [VERIFIED_EVIDENCE],
};

const UNKNOWN: VeRuSeasonality = {
  version: 1,
  classification: 'unknown',
  confidence: 'low',
  rationale: 'Проверенных данных недостаточно.',
  windows: [],
  evidence: [],
};

describe('Moscow business date', () => {
  it('changes the date at midnight Europe/Moscow, not at UTC midnight', () => {
    expect(moscowDateKey(new Date('2026-08-31T20:59:59.999Z'))).toBe('2026-08-31');
    expect(moscowDateKey(new Date('2026-08-31T21:00:00.000Z'))).toBe('2026-09-01');
  });

  it('uses the Moscow boundary when evaluating a launch window', () => {
    const assessment = seasonal([{
      ...SEPTEMBER_PEAK,
      // Isolate the calendar boundary: the regular fixture starts outreach
      // 45 days before the peak and would already be launch_now on Aug 31.
      lead_days: 0,
    }]);

    expect(evaluateRuSeasonality(assessment, new Date('2026-08-31T20:59:59.999Z')).state)
      .toBe('prepare_now');
    expect(evaluateRuSeasonality(assessment, new Date('2026-08-31T21:00:00.000Z')).state)
      .toBe('launch_now');
  });
});

describe('RU seasonality state machine', () => {
  const assessment = seasonal([SEPTEMBER_PEAK, OCTOBER_TO_MAY_AVOID]);

  it.each([
    ['launch_now', '2026-09-12T09:00:00.000Z'],
    ['launch_now', '2026-08-10T09:00:00.000Z'],
    ['prepare_now', '2026-07-10T09:00:00.000Z'],
    ['wait', '2026-06-10T09:00:00.000Z'],
    ['avoid', '2026-01-10T09:00:00.000Z'],
  ] as const)('returns %s for the matching positive/negative window', (state, now) => {
    expect(evaluateRuSeasonality(assessment, new Date(now)).state).toBe(state);
  });

  it('keeps neutral and unknown explicit instead of inventing a seasonal window', () => {
    expect(evaluateRuSeasonality(NEUTRAL, new Date('2026-08-10T09:00:00.000Z')).state)
      .toBe('neutral');
    expect(evaluateRuSeasonality(UNKNOWN, new Date('2026-08-10T09:00:00.000Z')).state)
      .toBe('unknown');
  });

  it('treats both sides of a cross-year positive window as launch_now', () => {
    const winterPeak = seasonal([
      {
        kind: 'peak',
        label: 'Новогодний спрос',
        start_mm_dd: '12-15',
        end_mm_dd: '01-15',
        lead_days: 30,
        evidence: [VERIFIED_EVIDENCE],
      },
    ]);

    expect(evaluateRuSeasonality(winterPeak, new Date('2026-12-20T09:00:00.000Z')).state)
      .toBe('launch_now');
    expect(evaluateRuSeasonality(winterPeak, new Date('2027-01-05T09:00:00.000Z')).state)
      .toBe('launch_now');
  });

  it('treats both sides of a cross-year negative window as avoid', () => {
    expect(evaluateRuSeasonality(assessment, new Date('2026-11-10T09:00:00.000Z')).state)
      .toBe('avoid');
    expect(evaluateRuSeasonality(assessment, new Date('2027-03-10T09:00:00.000Z')).state)
      .toBe('avoid');
  });

  it('launches outside a verified negative-only cross-year window', () => {
    const holidayShutdown = seasonal([{
      kind: 'avoid',
      label: 'Все ЛПР в отпуске',
      start_mm_dd: '12-20',
      end_mm_dd: '01-10',
      evidence: [VERIFIED_AVOID_EVIDENCE],
    }]);

    expect(evaluateRuSeasonality(
      holidayShutdown,
      new Date('2026-12-25T09:00:00.000Z'),
    )).toEqual(expect.objectContaining({
      state: 'avoid',
      automatic_activation_eligible: false,
    }));
    expect(evaluateRuSeasonality(
      holidayShutdown,
      new Date('2027-01-05T09:00:00.000Z'),
    )).toEqual(expect.objectContaining({
      state: 'avoid',
      automatic_activation_eligible: false,
    }));
    expect(evaluateRuSeasonality(
      holidayShutdown,
      new Date('2027-01-11T09:00:00.000Z'),
    )).toEqual(expect.objectContaining({
      state: 'launch_now',
      planned_activation_date: '2027-01-11',
      seasonal_deadline_date: null,
      automatic_activation_eligible: true,
    }));
  });

  it('starts outreach at peak_start - lead_days and keeps preparation separate', () => {
    const firstOutreachDay = evaluateRuSeasonality(
      seasonal([SEPTEMBER_PEAK]),
      new Date('2026-07-18T09:00:00.000Z'),
    );
    const lastPreparationDay = evaluateRuSeasonality(
      seasonal([SEPTEMBER_PEAK]),
      new Date('2026-07-17T09:00:00.000Z'),
    );
    const firstPreparationDay = evaluateRuSeasonality(
      seasonal([SEPTEMBER_PEAK]),
      new Date('2026-07-04T09:00:00.000Z'),
    );
    const oneDayBeforePreparation = evaluateRuSeasonality(
      seasonal([SEPTEMBER_PEAK]),
      new Date('2026-07-03T09:00:00.000Z'),
    );

    expect(firstOutreachDay).toEqual(expect.objectContaining({
      state: 'launch_now',
      planned_activation_date: '2026-07-18',
      // Peak end is inclusive, so completion is due before Moscow midnight
      // immediately after 30 September.
      seasonal_deadline_date: '2026-10-01',
    }));
    expect(lastPreparationDay).toEqual(expect.objectContaining({
      state: 'prepare_now',
      planned_activation_date: '2026-07-18',
    }));
    expect(firstPreparationDay).toEqual(expect.objectContaining({
      state: 'prepare_now',
      planned_activation_date: '2026-07-18',
    }));
    expect(oneDayBeforePreparation).toEqual(expect.objectContaining({
      state: 'wait',
      planned_activation_date: '2026-07-18',
    }));
  });
});

describe('verified structured seasonality', () => {
  it('drops an unsupported window from a mixed seasonal answer', () => {
    const unsupportedAvoidEvidence: VeEvidenceItem = {
      claim: 'После сентября все ЛПР недоступны до июня.',
      source_url: 'https://hallucinated.example/decision-maker-vacations',
      quote: 'С октября по май все лица, принимающие решения, находятся в отпуске.',
    };
    const mixed = {
      ...seasonal([SEPTEMBER_PEAK, OCTOBER_TO_MAY_AVOID]),
      windows: [
        { ...SEPTEMBER_PEAK, evidence: [VERIFIED_EVIDENCE] },
        { ...OCTOBER_TO_MAY_AVOID, evidence: [unsupportedAvoidEvidence] },
      ],
      evidence: [VERIFIED_EVIDENCE, unsupportedAvoidEvidence],
    } as unknown as VeRuSeasonality;

    const normalized = normalizeVerifiedRuSeasonality(mixed, [{
      url: SOURCE_URL,
      text: `Отраслевой обзор. ${SOURCE_QUOTE}`,
    }]);

    expect(normalized).toEqual(expect.objectContaining({
      classification: 'seasonal',
      windows: [{ ...SEPTEMBER_PEAK, evidence: [VERIFIED_EVIDENCE] }],
      evidence: [VERIFIED_EVIDENCE],
    }));
  });

  it('retains separate seasonal evidence when its URL and quote are fetched verbatim', () => {
    const normalized = normalizeVerifiedRuSeasonality(
      seasonal([SEPTEMBER_PEAK, OCTOBER_TO_MAY_AVOID]),
      [{
        url: SOURCE_URL,
        text: `Отраслевой обзор. ${SOURCE_QUOTE} ${AVOID_SOURCE_QUOTE}`,
      }],
    );

    expect(normalized).toEqual(expect.objectContaining({
      classification: 'seasonal',
      windows: [SEPTEMBER_PEAK, OCTOBER_TO_MAY_AVOID],
      evidence: [VERIFIED_EVIDENCE, VERIFIED_AVOID_EVIDENCE],
    }));
  });

  it('turns unsupported seasonal output into unknown instead of trusting the model', () => {
    const unsupported = seasonal([SEPTEMBER_PEAK]);
    const unsupportedEvidence = {
      claim: 'Модель придумала сезон.',
      source_url: 'https://hallucinated.example/season',
      quote: 'Непроверенная цитата про сезонный спрос в сентябре.',
    };
    unsupported.windows = [{ ...SEPTEMBER_PEAK, evidence: [unsupportedEvidence] }];
    unsupported.evidence = [unsupportedEvidence];

    const normalized = normalizeVerifiedRuSeasonality(unsupported, [{
      url: SOURCE_URL,
      text: 'В реально скачанном источнике такой цитаты нет.',
    }]);

    expect(normalized).toEqual(expect.objectContaining({
      classification: 'unknown',
      confidence: 'low',
      windows: [],
      evidence: [],
    }));
    expect(evaluateRuSeasonality(normalized, new Date('2026-09-10T09:00:00.000Z')).state)
      .toBe('unknown');
  });
});

describe('base analysis receives evidence instead of a keyword fallback', () => {
  function prompt(seasonality: VeRuSeasonality | null): string {
    return buildBaseAnalysisMessages({
      filename: 'education.csv',
      rowCount: 10,
      columns: ['company', 'industry'],
      sampleRows: [{ company: 'Школа', industry: 'образование' }],
      verticalName: 'Частное образование',
      today: '2026-08-28',
      verifiedSeasonality: seasonality,
    }).map((message) => message.content).join('\n');
  }

  it('passes the verified windows and Moscow date downstream', () => {
    const text = prompt(seasonal([SEPTEMBER_PEAK]));

    expect(text).toContain('СЕГОДНЯ: 2026-08-28');
    expect(text).toContain('ПРОВЕРЕННАЯ СЕЗОННОСТЬ');
    expect(text).toContain('09-01');
    expect(text).toContain(SOURCE_URL);
  });

  it('explicitly forbids a seasonal angle for legacy/null evidence', () => {
    const text = prompt(null);

    expect(text).toContain('ПРОВЕРЕННАЯ СЕЗОННОСТЬ: нет');
    expect(text).toMatch(/не выводи сезонность из названия|не придумывай сезон/i);
  });
});

describe('stable portfolio priority snapshot', () => {
  it.each([
    ['launch_now', '2026-08-10T09:00:00.000Z', 100, true, '2026-07-18'],
    ['prepare_now', '2026-07-10T09:00:00.000Z', 200, false, '2026-07-18'],
    ['wait', '2026-06-10T09:00:00.000Z', 500, false, '2026-07-18'],
    ['avoid', '2026-01-10T09:00:00.000Z', 600, false, '2026-07-18'],
  ] as const)(
    'freezes %s with stable display priority and separate auto eligibility',
    (state, now, priority, automaticActivationEligible, plannedActivationDate) => {
      const snapshot = buildRuSeasonalityPrioritySnapshot(
        seasonal([SEPTEMBER_PEAK, OCTOBER_TO_MAY_AVOID]),
        new Date(now),
      );

      expect(snapshot).toEqual(expect.objectContaining({
        version: 1,
        state,
        priority,
        confidence: 'high',
        automatic_activation_eligible: automaticActivationEligible,
        planned_activation_date: plannedActivationDate,
      }));
    },
  );

  it.each([
    [NEUTRAL, 'neutral', 300, true, 'high'],
    [UNKNOWN, 'unknown', 400, false, 'low'],
  ] as const)('keeps %s explicit in the queue snapshot', (assessment, state, priority, eligible, confidence) => {
    expect(buildRuSeasonalityPrioritySnapshot(
      assessment,
      new Date('2026-08-10T09:00:00.000Z'),
    )).toEqual(expect.objectContaining({
      state,
      priority,
      confidence,
      automatic_activation_eligible: eligible,
    }));
  });

  it('is deterministic when persisted windows arrive in a different insertion order', () => {
    const now = new Date('2026-06-10T09:00:00.000Z');
    const first = buildRuSeasonalityPrioritySnapshot(
      seasonal([SEPTEMBER_PEAK, OCTOBER_TO_MAY_AVOID]),
      now,
    );
    const reversed = buildRuSeasonalityPrioritySnapshot(
      seasonal([OCTOBER_TO_MAY_AVOID, SEPTEMBER_PEAK]),
      now,
    );

    expect(first).toEqual(reversed);
    expect(first).toEqual(expect.objectContaining({
      evaluated_on: '2026-06-10',
      state: 'wait',
      planned_activation_date: '2026-07-18',
      automatic_activation_eligible: false,
    }));
  });

  it('does not infer September from a title/rationale or activate a legacy null', () => {
    const legacyRow: { seasonality?: unknown } = {};
    const { evidence: _unlinkedEvidence, ...unlinkedPeak } = SEPTEMBER_PEAK;
    const clueOnly = readStoredRuSeasonality({
      classification: 'seasonal',
      confidence: 'high',
      rationale: 'Частные школы — значит, наверное, сентябрь.',
      windows: [unlinkedPeak],
      // Even a valid top-level citation cannot implicitly validate an
      // unlinked model-generated window.
      evidence: [VERIFIED_EVIDENCE],
    });
    const legacy = readStoredRuSeasonality(legacyRow.seasonality);
    const explicitNull = readStoredRuSeasonality(null);

    for (const assessment of [clueOnly, legacy, explicitNull]) {
      expect(evaluateRuSeasonality(assessment, new Date('2026-09-10T09:00:00.000Z')).state)
        .toBe('unknown');
      expect(buildRuSeasonalityPrioritySnapshot(
        assessment,
        new Date('2026-09-10T09:00:00.000Z'),
      )).toEqual(expect.objectContaining({
        state: 'unknown',
        confidence: 'low',
        planned_activation_date: null,
        automatic_activation_eligible: false,
      }));
    }
  });
});
