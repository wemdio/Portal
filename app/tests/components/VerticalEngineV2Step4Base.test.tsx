import { act, render, screen } from '@testing-library/react';
import { Step4Base } from '@/components/vertical-engine-v2/engine/steps/Step4Base';
import type { VeHypothesis, VeVertical } from '@/lib/verticalEngineV2/types';
import type { VeBaseSummary } from '@/components/vertical-engine-v2/engine/api';

const mockEnginePost = jest.fn();

jest.mock('@/components/vertical-engine-v2/engine/api', () => ({
  VE_API: '/api/tools/vertical-engine-v2',
  veEnginePost: (...args: unknown[]) => mockEnginePost(...args),
}));

const VERTICAL: VeVertical = {
  id: 'vertical-private-healthcare',
  project_id: 'project-vbi',
  name: 'Частная медицина',
  summary: 'Коммерческие медицинские организации России',
  synonyms: ['частные клиники'],
  potential_pct: 55,
  rank: 1,
  created_at: '2026-08-26T08:00:00.000Z',
  updated_at: '2026-08-26T08:00:00.000Z',
};

const HYPOTHESIS: VeHypothesis = {
  id: 'hyp-clinics',
  project_id: 'project-vbi',
  vertical_id: VERTICAL.id,
  tier: 1,
  title: 'Сети частных клиник',
  description: 'Городские многопрофильные клиники с несколькими филиалами',
  evidence: [],
  potential_pct: 60,
  status: 'accepted',
  created_at: '2026-08-26T08:00:00.000Z',
  updated_at: '2026-08-26T08:00:00.000Z',
};

/**
 * Single-directory-task contract. Multiple directory tasks can overlap and
 * therefore must not be summed as unique companies.
 */
const BASE = {
  id: 'base-clinics',
  vertical_id: VERTICAL.id,
  hypothesis_id: HYPOTHESIS.id,
  filename: 'auto: Частная медицина — Сети частных клиник',
  row_count: 1514,
  columns: ['company', 'email'],
  sample_rows: [],
  status: 'analyzed',
  source: 'auto',
  analysis: null,
  collect_info: {
    limit: 2000,
    estimate: {
      unique_companies: 8410,
      companies_with_email: 6842,
    },
    stats: {
      tasks_total: 3,
      tasks_done: 3,
      tasks_failed: 0,
      rows_total: 2000,
      processed_rows: 1514,
      launchable_rows: 651,
      low_relevance: 408,
      excluded_existing_bases: 0,
      excluded_during_fetch: 0,
      finished_at: '2026-08-30T08:15:00.000Z',
    },
  },
  created_at: '2026-08-30T08:00:00.000Z',
} as unknown as VeBaseSummary;

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
});

describe('<Step4Base /> collection funnel', () => {
  it('does not duplicate collection polling while the project parent is already polling', () => {
    jest.useFakeTimers();
    const onUploaded = jest.fn();

    try {
      render(
        <Step4Base
          projectId="project-vbi"
          vertical={VERTICAL}
          hypotheses={[HYPOTHESIS]}
          bases={[{ ...BASE, status: 'collecting' } as VeBaseSummary]}
          jobs={[]}
          parentPollingActive
          onUploaded={onUploaded}
          onTemplateStarted={jest.fn()}
          onGoToTemplate={jest.fn()}
        />,
      );

      act(() => jest.advanceTimersByTime(8_000));
      expect(onUploaded).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the local collection polling fallback when the parent cannot see an active job', () => {
    jest.useFakeTimers();
    const onUploaded = jest.fn();

    try {
      render(
        <Step4Base
          projectId="project-vbi"
          vertical={VERTICAL}
          hypotheses={[HYPOTHESIS]}
          bases={[{ ...BASE, status: 'collecting' } as VeBaseSummary]}
          jobs={[]}
          parentPollingActive={false}
          onUploaded={onUploaded}
          onTemplateStarted={jest.fn()}
          onGoToTemplate={jest.fn()}
        />,
      );

      act(() => jest.advanceTimersByTime(8_000));
      expect(onUploaded).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('separates hypothesis population, run cap, processed rows and launchable recipients', () => {
    render(
      <Step4Base
        projectId="project-vbi"
        vertical={VERTICAL}
        hypotheses={[HYPOTHESIS]}
        bases={[BASE]}
        jobs={[]}
        onUploaded={jest.fn()}
        onTemplateStarted={jest.fn()}
        onGoToTemplate={jest.fn()}
      />,
    );

    // ru-RU formatting may use either an ordinary or a non-breaking space.
    const gap = '[\\s\\u00a0]';
    expect(
      screen.getByText(
        new RegExp(`8${gap}410 уникальных компаний в реестровом срезе гипотезы`, 'i'),
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`Из них 6${gap}842 с email в реестре`, 'i')),
    ).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`Лимит этого прогона: 2${gap}000 кандидатов`, 'i')),
    ).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`Собрано до обработки: 2${gap}000 кандидатов`, 'i')),
    ).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`После обработки: 1${gap}514 строк`, 'i')),
    ).toBeInTheDocument();
    expect(screen.getByText(/Прошли проверки: 651 получатель/i)).toBeInTheDocument();
    expect(screen.queryByText(/Готовы к запуску/i)).not.toBeInTheDocument();

    // Neither the market/hypothesis population nor the technical cap is a
    // count of contacts ready for outreach.
    expect(screen.queryByText(new RegExp(`8${gap}410 контактов`, 'i'))).not.toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`2${gap}000 контактов`, 'i'))).not.toBeInTheDocument();
  });

  it('warns when the verified audience is larger than one launch can accept', () => {
    const oversized = {
      ...BASE,
      id: 'base-oversized',
      row_count: 2501,
      collect_info: {
        ...BASE.collect_info!,
        limit: 10_000,
        stats: {
          ...BASE.collect_info!.stats!,
          rows_total: 10_000,
          processed_rows: 3_000,
          launchable_rows: 2_501,
        },
      },
    } as unknown as VeBaseSummary;

    render(
      <Step4Base
        projectId="project-vbi"
        vertical={VERTICAL}
        hypotheses={[HYPOTHESIS]}
        bases={[oversized]}
        jobs={[]}
        onUploaded={jest.fn()}
        onTemplateStarted={jest.fn()}
        onGoToTemplate={jest.fn()}
      />,
    );

    expect(screen.getByText(/Прошли проверки: 2[\s\u00a0]501 получатель/i)).toBeInTheDocument();
    expect(screen.getByText(/лимит одного запуска[^\d]*2[\s\u00a0]000/i)).toBeInTheDocument();
    expect(screen.queryByText(/Готовы к запуску/i)).not.toBeInTheDocument();
  });

  it('shows incomplete relevance coverage and keeps unchecked rows out of the verified total', () => {
    const partialCoverage = {
      ...BASE,
      id: 'base-partial-relevance-coverage',
      collect_info: {
        ...BASE.collect_info!,
        stats: {
          ...BASE.collect_info!.stats!,
          relevance_unchecked: 205,
          relevance_checked_companies: 100,
          relevance_total_companies: 125,
          relevance_coverage_complete: false,
        },
      },
    } as unknown as VeBaseSummary;

    render(
      <Step4Base
        projectId="project-vbi"
        vertical={VERTICAL}
        hypotheses={[HYPOTHESIS]}
        bases={[partialCoverage]}
        jobs={[]}
        onUploaded={jest.fn()}
        onTemplateStarted={jest.fn()}
        onGoToTemplate={jest.fn()}
      />,
    );

    expect(
      screen.getByText(/Релевантность проверена[^\d]*100 из 125 компаний/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/205 строк[^.]*не (?:входят|включены)[^.]*«?Прошли проверки»?/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Прошли проверки: 651 получатель/i)).toBeInTheDocument();
  });

  it('does not invent processed rows from row_count for a failed pre-constructor base', () => {
    const failed = {
      ...BASE,
      id: 'base-failed-before-construct',
      status: 'failed',
      row_count: 123,
      collect_info: {
        limit: 2_000,
        estimate: BASE.collect_info!.estimate,
        stats: undefined,
      },
    } as unknown as VeBaseSummary;

    render(
      <Step4Base
        projectId="project-vbi"
        vertical={VERTICAL}
        hypotheses={[HYPOTHESIS]}
        bases={[failed]}
        jobs={[]}
        onUploaded={jest.fn()}
        onTemplateStarted={jest.fn()}
        onGoToTemplate={jest.fn()}
      />,
    );

    expect(screen.queryByText(/После обработки: 123 строк/i)).not.toBeInTheDocument();
  });
});
