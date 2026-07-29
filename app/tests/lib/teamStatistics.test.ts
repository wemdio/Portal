/** @jest-environment node */

import { collectPages } from '@/lib/collectPages';

import {
  buildTeamStatistics,
  getStatisticsCoverage,
  resolveReportingPeriod,
  teamStatisticsBusinessDate,
  type TeamProjectHistoryRow,
} from '@/lib/teamStatistics';

const NOW = new Date('2026-07-29T12:00:00.000Z');
const COVERAGE_START = '2026-07-30';

function history(
  patch: Partial<TeamProjectHistoryRow> & Pick<TeamProjectHistoryRow, 'project_id' | 'captured_at'>,
): TeamProjectHistoryRow {
  return {
    id: `${patch.project_id}-${patch.period_id ?? 'legacy'}-${patch.captured_at}`,
    period_id: null,
    project_name: 'Аутрич',
    client: patch.project_id,
    project_status: 'В работе',
    period_status: null,
    manager: 'Лид А',
    specialist: 'Специалист А',
    specialist_user_id: 'specialist-a',
    kpi_plan: '10',
    kpi_fact: '0',
    launch_date: '2026-07-01',
    deadline: null,
    period_start: null,
    period_end: null,
    capture_source: 'project_trigger',
    ...patch,
  };
}

describe('resolveReportingPeriod', () => {
  it.each([
    ['month', '2026-02-15', '2026-02-01', '2026-02-28', 'Февраль 2026', '2026-01-01', '2026-03-01'],
    ['quarter', '2026-05-31', '2026-04-01', '2026-06-30', 'II квартал 2026', '2026-01-01', '2026-07-01'],
    ['half', '2026-11-04', '2026-07-01', '2026-12-31', 'II полугодие 2026', '2026-01-01', null],
    ['year', '2025-08-10', '2025-01-01', '2025-12-31', '2025 год', '2024-01-01', '2026-01-01'],
  ] as const)(
    'resolves the calendar %s containing the anchor',
    (kind, anchor, start, end, label, previousAnchor, nextAnchor) => {
      expect(resolveReportingPeriod(kind, anchor, NOW)).toEqual({
        kind,
        start,
        end,
        label,
        previousAnchor,
        nextAnchor,
      });
    },
  );

  it('does not expose navigation into a reporting period after the current one', () => {
    expect(resolveReportingPeriod('quarter', '2026-07-01', NOW).nextAnchor).toBeNull();
  });

  it('uses the Moscow calendar date for navigation around UTC midnight', () => {
    const augustFirstInMoscow = new Date('2026-07-31T21:30:00.000Z');

    expect(
      resolveReportingPeriod('month', '2026-07-15', augustFirstInMoscow).nextAnchor,
    ).toBe('2026-08-01');
  });

  it('rejects invalid period kinds and impossible calendar dates', () => {
    expect(() => resolveReportingPeriod('rolling-30', '2026-07-01', NOW)).toThrow(
      'Unsupported statistics period',
    );
    expect(() => resolveReportingPeriod('month', '2026-02-30', NOW)).toThrow(
      'Invalid statistics anchor',
    );
  });
});

describe('getStatisticsCoverage', () => {
  it('derives the first captured business date in Moscow, including the UTC-midnight edge', () => {
    expect(teamStatisticsBusinessDate('2026-07-29T20:59:59.999Z')).toBe('2026-07-29');
    expect(teamStatisticsBusinessDate('2026-07-29T21:00:00.000Z')).toBe('2026-07-30');
    expect(teamStatisticsBusinessDate('not-a-timestamp')).toBeNull();
  });

  it('reports that history has not accumulated while there is no first snapshot', () => {
    expect(getStatisticsCoverage('2026-07-01', '2026-07-31', null, '2026-07-30')).toEqual({
      status: 'unavailable',
      startsAt: null,
      asOf: '2026-07-30',
      periodComplete: false,
      message: 'История пока не накоплена',
    });
  });

  it('marks ranges before history collection as unavailable', () => {
    expect(getStatisticsCoverage('2026-06-01', '2026-06-30', COVERAGE_START, '2026-07-30')).toEqual({
      status: 'unavailable',
      startsAt: COVERAGE_START,
      asOf: '2026-06-30',
      periodComplete: true,
      message: 'История за этот период не собиралась',
    });
  });

  it('marks the launch calendar range as partial, including a launch on its first day', () => {
    expect(getStatisticsCoverage('2026-07-01', '2026-07-31', COVERAGE_START, '2026-07-30')).toEqual({
      status: 'partial',
      startsAt: COVERAGE_START,
      asOf: '2026-07-30',
      periodComplete: false,
      message: 'История собирается с 30.07.2026; день запуска и более ранние данные неполные',
    });
    expect(getStatisticsCoverage('2026-07-30', '2026-07-31', COVERAGE_START, '2026-07-30').status).toBe('partial');
  });

  it('marks completed later calendar ranges as complete', () => {
    expect(getStatisticsCoverage('2026-08-01', '2026-08-31', COVERAGE_START, '2026-09-01')).toEqual({
      status: 'complete',
      startsAt: COVERAGE_START,
      asOf: '2026-08-31',
      periodComplete: true,
      message: 'Данные собраны за весь период',
    });
  });

  it('labels an ongoing later period as complete only through the current date', () => {
    expect(getStatisticsCoverage('2026-08-01', '2026-08-31', COVERAGE_START, '2026-08-15')).toEqual({
      status: 'complete',
      startsAt: COVERAGE_START,
      asOf: '2026-08-15',
      periodComplete: false,
      message: 'Данные полные по состоянию на 15.08.2026',
    });
  });

  it('uses the Moscow calendar date for default coverage around UTC midnight', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-31T21:30:00.000Z'));

    try {
      expect(getStatisticsCoverage('2026-08-01', '2026-08-31', COVERAGE_START)).toEqual({
        status: 'complete',
        startsAt: COVERAGE_START,
        asOf: '2026-08-01',
        periodComplete: false,
        message: 'Данные полные по состоянию на 01.08.2026',
      });
    } finally {
      jest.useRealTimers();
    }
  });
});
describe('collectPages', () => {
  it('reads every page past the PostgREST 1000-row cap', async () => {
    const calls: Array<[number, number]> = [];
    const first = Array.from({ length: 1000 }, (_, index) => index);
    const second = [1000, 1001, 1002];

    const rows = await collectPages(async (from, to) => {
      calls.push([from, to]);
      return { data: calls.length === 1 ? first : second, error: null };
    });

    expect(calls).toEqual([[0, 999], [1000, 1999]]);
    expect(rows).toHaveLength(1003);
    expect(rows.at(-1)).toBe(1002);
  });

  it('propagates a page error instead of returning a truncated result', async () => {
    await expect(collectPages(async () => ({
      data: null,
      error: { message: 'page failed' },
    }))).rejects.toThrow('page failed');
  });
});
describe('buildTeamStatistics', () => {
  const range = resolveReportingPeriod('month', '2026-07-12', NOW);
  const profiles = [
    {
      id: 'lead-a',
      email: 'lead.a@example.com',
      full_name: 'Лид А',
    },
    {
      id: 'lead-b',
      email: 'lead.b@example.com',
      full_name: 'Лид Б',
    },
    {
      id: 'specialist-a',
      email: 'spec.a@example.com',
      full_name: 'Специалист А',
    },
    {
      id: 'specialist-b',
      email: 'spec.b@example.com',
      full_name: 'Специалист Б',
    },
  ];

  it('counts only closed numeric cycles as met/missed and excludes preparation fact', () => {
    const rows = [
      history({
        project_id: 'met',
        period_id: 'met-period',
        period_status: 'closed',
        period_start: '2026-07-01',
        period_end: '2026-07-10',
        kpi_plan: '10 лидов',
        kpi_fact: '12',
        manager: 'lead.a',
        captured_at: '2026-07-10T18:00:00.000Z',
      }),
      history({
        project_id: 'missed',
        period_id: 'missed-period',
        period_status: 'closed',
        period_start: '2026-07-01',
        period_end: '2026-07-20',
        kpi_plan: '10',
        kpi_fact: '6',
        specialist: 'Специалист Б',
        specialist_user_id: 'specialist-b',
        captured_at: '2026-07-20T18:00:00.000Z',
      }),
      history({
        project_id: 'preparation',
        project_status: 'Подготовка',
        kpi_plan: '5',
        kpi_fact: '4',
        captured_at: '2026-07-29T08:00:00.000Z',
      }),
      history({
        project_id: 'open',
        period_id: 'open-period',
        period_status: 'active',
        period_start: '2026-07-15',
        kpi_plan: '3',
        kpi_fact: '3',
        manager: 'Лид Б',
        captured_at: '2026-07-29T08:00:00.000Z',
      }),
      history({
        project_id: 'unclassified',
        project_status: 'Завершен',
        deadline: '2026-07-24',
        kpi_plan: null,
        kpi_fact: '7',
        captured_at: '2026-07-24T08:00:00.000Z',
      }),
    ];

    const result = buildTeamStatistics({ range, history: rows, profiles });

    expect(result.summary).toEqual({
      projects: 5,
      kpiMet: 1,
      kpiMissed: 1,
      inProgress: 2,
      unclassified: 1,
      leads: 28,
    });
    expect(result.summary.projects).toBe(
      result.summary.kpiMet
        + result.summary.kpiMissed
        + result.summary.inProgress
        + result.summary.unclassified,
    );

    expect(result.groups.leads.find((person) => person.id === 'lead-a')).toEqual(
      expect.objectContaining({
        name: 'Лид А',
        projects: 4,
        kpiMet: 1,
        kpiMissed: 1,
        inProgress: 1,
        unclassified: 1,
        leads: 25,
      }),
    );
    expect(result.groups.specialists.find((person) => person.id === 'specialist-a')).toEqual(
      expect.objectContaining({
        name: 'Специалист А',
        projects: 4,
        kpiMet: 1,
        inProgress: 2,
        unclassified: 1,
        leads: 22,
      }),
    );
    expect(
      result.groups.specialists
        .flatMap((person) => person.projectRows)
        .find((project) => project.id === 'preparation'),
    ).toEqual(expect.objectContaining({ result: 'in_progress', leads: 0 }));
  });

  it('uses the latest snapshot at period end for result and employee attribution', () => {
    const rows = [
      history({
        project_id: 'changed',
        period_id: 'cycle',
        manager: 'Лид А',
        specialist_user_id: 'specialist-a',
        period_status: 'active',
        kpi_fact: '2',
        captured_at: '2026-07-05T08:00:00.000Z',
      }),
      history({
        project_id: 'changed',
        period_id: 'cycle',
        manager: 'Лид Б',
        specialist: 'Специалист Б',
        specialist_user_id: 'specialist-b',
        period_status: 'closed',
        period_end: '2026-07-20',
        kpi_fact: '10',
        captured_at: '2026-07-20T08:00:00.000Z',
      }),
      history({
        project_id: 'changed',
        period_id: 'cycle',
        manager: 'Лид А',
        period_status: 'closed',
        kpi_fact: '99',
        captured_at: '2026-08-01T08:00:00.000Z',
      }),
    ];

    const result = buildTeamStatistics({ range, history: rows, profiles });

    expect(result.summary).toEqual({
      projects: 1,
      kpiMet: 1,
      kpiMissed: 0,
      inProgress: 0,
      unclassified: 0,
      leads: 10,
    });
    expect(result.groups.leads).toHaveLength(1);
    expect(result.groups.leads[0]).toEqual(expect.objectContaining({ id: 'lead-b', name: 'Лид Б' }));
    expect(result.groups.specialists[0]).toEqual(
      expect.objectContaining({ id: 'specialist-b', name: 'Специалист Б' }),
    );
  });

  it('counts KPI fact as a calendar-period delta and can use contacts history for partial coverage', () => {
    const teamRows = [
      history({
        project_id: 'long-running',
        period_id: 'long-cycle',
        period_status: 'active',
        period_start: '2026-06-01',
        kpi_fact: '50',
        captured_at: '2026-07-29T08:00:00.000Z',
      }),
    ];

    const result = buildTeamStatistics({
      range,
      history: teamRows,
      profiles,
      kpiHistory: [
        {
          project_id: 'long-running',
          period_id: 'long-cycle',
          kpi_fact: '40',
          recorded_at: '2026-06-30',
        },
        {
          project_id: 'long-running',
          period_id: 'long-cycle',
          kpi_fact: '50',
          recorded_at: '2026-07-29',
        },
      ],
    });

    expect(result.summary).toEqual(
      expect.objectContaining({ projects: 1, inProgress: 1, leads: 10 }),
    );
  });
  it('replaces a legacy snapshot when explicit project periods appear', () => {
    const result = buildTeamStatistics({
      range,
      profiles,
      history: [
        history({ project_id: 'renewed', period_id: null, captured_at: '2026-07-01T08:00:00.000Z' }),
        history({
          project_id: 'renewed',
          period_id: 'period-1',
          period_status: 'active',
          period_start: '2026-07-15',
          captured_at: '2026-07-15T08:00:00.000Z',
        }),
      ],
    });

    expect(result.summary.projects).toBe(1);
  });

  it('does not resurrect a legacy row after the project switched to completed explicit cycles', () => {
    const august = resolveReportingPeriod(
      'month',
      '2026-08-15',
      new Date('2026-08-15T12:00:00.000Z'),
    );
    const result = buildTeamStatistics({
      range: august,
      profiles,
      history: [
        history({
          project_id: 'renewed-finished',
          period_id: null,
          period_start: '2026-07-01',
          captured_at: '2026-07-01T08:00:00.000Z',
        }),
        history({
          project_id: 'renewed-finished',
          period_id: 'period-1',
          period_status: 'closed',
          period_start: '2026-07-01',
          period_end: '2026-07-31',
          captured_at: '2026-07-31T08:00:00.000Z',
        }),
      ],
    });

    expect(result.summary.projects).toBe(0);
    expect(result.groups).toEqual({ leads: [], specialists: [] });
  });

  it('subtracts preparation KPI captured after Moscow midnight but before UTC midnight', () => {
    const result = buildTeamStatistics({
      range,
      profiles,
      history: [
        history({
          project_id: 'prep-transition',
          project_status: 'Подготовка',
          kpi_fact: '5',
          captured_at: '2026-06-30T21:30:00.000Z',
        }),
        history({
          project_id: 'prep-transition',
          project_status: 'В работе',
          kpi_fact: '7',
          captured_at: '2026-07-10T08:00:00.000Z',
        }),
      ],
    });

    expect(result.summary).toEqual(expect.objectContaining({ projects: 1, leads: 2 }));
  });

  it('cuts owner attribution off at the end of the Moscow calendar day', () => {
    const result = buildTeamStatistics({
      range,
      profiles,
      history: [
        history({
          project_id: 'midnight-owner',
          period_id: 'july-cycle',
          period_status: 'active',
          manager: 'Лид А',
          kpi_fact: '1',
          captured_at: '2026-07-31T20:30:00.000Z',
        }),
        history({
          project_id: 'midnight-owner',
          period_id: 'july-cycle',
          period_status: 'active',
          manager: 'Лид Б',
          kpi_fact: '9',
          captured_at: '2026-07-31T21:30:00.000Z',
        }),
      ],
    });

    expect(result.summary).toEqual(expect.objectContaining({ projects: 1, leads: 1 }));
    expect(result.groups.leads).toEqual([
      expect.objectContaining({ id: 'lead-a', name: 'Лид А', leads: 1 }),
    ]);
  });

  it('uses Moscow midnight as the KPI baseline boundary', () => {
    const result = buildTeamStatistics({
      range,
      profiles,
      history: [
        history({
          project_id: 'midnight-baseline',
          period_id: 'long-cycle',
          period_status: 'active',
          period_start: '2026-06-01',
          kpi_fact: '5',
          captured_at: '2026-06-30T20:30:00.000Z',
        }),
        history({
          project_id: 'midnight-baseline',
          period_id: 'long-cycle',
          period_status: 'active',
          period_start: '2026-06-01',
          kpi_fact: '7',
          captured_at: '2026-06-30T21:30:00.000Z',
        }),
        history({
          project_id: 'midnight-baseline',
          period_id: 'long-cycle',
          period_status: 'active',
          period_start: '2026-06-01',
          kpi_fact: '10',
          captured_at: '2026-07-10T08:00:00.000Z',
        }),
      ],
    });

    expect(result.summary).toEqual(expect.objectContaining({ projects: 1, leads: 5 }));
  });

  it('excludes KPI history recorded after the end of the Moscow calendar day', () => {
    const result = buildTeamStatistics({
      range,
      profiles,
      history: [
        history({
          project_id: 'midnight-kpi',
          period_id: 'july-cycle',
          period_status: 'active',
          kpi_fact: null,
          captured_at: '2026-07-31T20:00:00.000Z',
        }),
      ],
      kpiHistory: [
        {
          project_id: 'midnight-kpi',
          period_id: 'july-cycle',
          kpi_fact: '10',
          recorded_at: '2026-07-31T20:30:00.000Z',
        },
        {
          project_id: 'midnight-kpi',
          period_id: 'july-cycle',
          kpi_fact: '99',
          recorded_at: '2026-07-31T21:30:00.000Z',
        },
      ],
    });

    expect(result.summary).toEqual(expect.objectContaining({ projects: 1, leads: 10 }));
  });

  it('does not backdate a project closed after Moscow midnight without a semantic end date', () => {
    const result = buildTeamStatistics({
      range,
      profiles,
      history: [
        history({
          project_id: 'closed-after-midnight',
          project_status: 'Завершен',
          period_status: null,
          period_start: null,
          period_end: null,
          deadline: null,
          captured_at: '2026-07-31T21:30:00.000Z',
        }),
      ],
    });

    expect(result.summary.projects).toBe(0);
  });
  it('counts preparation captured in the period even when planned launch is next month', () => {
    const result = buildTeamStatistics({
      range,
      profiles,
      history: [history({
        project_id: 'future-launch-prep',
        project_status: 'Подготовка',
        launch_date: '2026-08-05',
        period_start: '2026-08-05',
        kpi_fact: '4',
        captured_at: '2026-07-29T08:00:00.000Z',
      })],
    });

    expect(result.summary).toEqual(expect.objectContaining({ projects: 1, inProgress: 1, leads: 0 }));
  });
  it('uses a delayed close snapshot for final KPI but keeps the owner at period end', () => {
    const result = buildTeamStatistics({
      range,
      profiles,
      history: [
        history({
          project_id: 'delayed-close',
          period_id: 'july-cycle',
          period_status: 'active',
          period_start: '2026-07-01',
          kpi_plan: '10',
          kpi_fact: '9',
          manager: 'Лид А',
          captured_at: '2026-07-31T20:00:00.000Z',
        }),
        history({
          project_id: 'delayed-close',
          period_id: 'july-cycle',
          period_status: 'closed',
          period_start: '2026-07-01',
          period_end: '2026-07-31',
          kpi_plan: '10',
          kpi_fact: '10',
          manager: 'Лид Б',
          captured_at: '2026-08-01T08:00:00.000Z',
        }),
      ],
      kpiHistory: [
        {
          project_id: 'delayed-close',
          period_id: 'july-cycle',
          kpi_fact: '9',
          recorded_at: '2026-07-31T20:30:00.000Z',
        },
      ],
    });

    expect(result.summary).toEqual(expect.objectContaining({ projects: 1, kpiMet: 1, inProgress: 0, leads: 10 }));
    expect(result.groups.leads).toEqual([
      expect.objectContaining({ id: 'lead-a', name: 'Лид А', kpiMet: 1 }),
    ]);
  });

  it('uses unique row ids when one project has multiple cycles in the period', () => {
    const result = buildTeamStatistics({
      range,
      profiles,
      history: [
        history({
          project_id: 'renewed-twice',
          period_id: 'cycle-1',
          period_status: 'closed',
          period_start: '2026-07-01',
          period_end: '2026-07-10',
          kpi_plan: '5',
          kpi_fact: '5',
          captured_at: '2026-07-10T08:00:00.000Z',
        }),
        history({
          project_id: 'renewed-twice',
          period_id: 'cycle-2',
          period_status: 'closed',
          period_start: '2026-07-11',
          period_end: '2026-07-31',
          kpi_plan: '5',
          kpi_fact: '3',
          captured_at: '2026-07-31T08:00:00.000Z',
        }),
      ],
    });

    const ids = result.groups.leads[0].projectRows.map((project) => project.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(result.summary).toEqual(expect.objectContaining({
      projects: 1,
      kpiMet: 1,
      kpiMissed: 1,
    }));
    expect(result.groups.leads[0].projects).toBe(1);
  });

  it('omits cycles that do not overlap the selected calendar range', () => {
    const result = buildTeamStatistics({
      range,
      profiles,
      history: [
        history({
          project_id: 'june',
          period_id: 'june-cycle',
          period_status: 'closed',
          period_start: '2026-06-01',
          period_end: '2026-06-30',
          captured_at: '2026-07-29T08:00:00.000Z',
        }),
      ],
    });

    expect(result.summary.projects).toBe(0);
    expect(result.groups).toEqual({ leads: [], specialists: [] });
  });
});
