/** @jest-environment node */

jest.mock('@/lib/supabaseClient', () => ({
  supabase: { auth: { getSession: jest.fn() } },
}));

import { supabase } from '@/lib/supabaseClient';
import * as teamApiModule from '@/components/team/teamApi';
import {
  buildTeamActivityPlanWrite,
  buildTeamReviewRequestActionWrite,
  buildTeamReviewRequestConversionWrite,
  buildTeamReviewRequestWrite,
  buildTeamReviewCompletionWrite,
  buildTeamReviewScheduleWrite,
  buildTeamTalentReserveWrite,
  normalizeActivityPlan,
  normalizeReviewRequestSummary,
  normalizeReviewRequests,
  normalizeReviews,
  normalizeStatistics,
  normalizeTalentReserve,
  teamApiFetch,
  teamStatisticsIsoDate,
} from '@/components/team/teamApi';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('team review write payloads', () => {
  it('builds a minimal scheduled review payload and trims its optional reason', () => {
    expect(buildTeamReviewScheduleWrite({
      subjectType: 'employee',
      reviewDate: '2026-08-12',
      employeeUserId: '00000000-0000-4000-8000-000000000002',
      reason: '  Проверить адаптацию  ',
    })).toEqual({
      reviewDate: '2026-08-12',
      employeeUserId: '00000000-0000-4000-8000-000000000002',
      reason: 'Проверить адаптацию',
    });

    expect(buildTeamReviewScheduleWrite({
      subjectType: 'employee',
      reviewDate: '2026-08-13',
      employeeUserId: '00000000-0000-4000-8000-000000000002',
      reason: '   ',
    })).toEqual({
      reviewDate: '2026-08-13',
      employeeUserId: '00000000-0000-4000-8000-000000000002',
      reason: null,
    });
  });

  it('builds a candidate payload with a trimmed manual name and no employee id', () => {
    expect(buildTeamReviewScheduleWrite({
      subjectType: 'candidate',
      reviewDate: '2026-08-14',
      candidateName: '  Мария Соколова  ',
      reason: '  Вакансия: аккаунт-менеджер, этап: финал  ',
    })).toEqual({
      reviewDate: '2026-08-14',
      candidateName: 'Мария Соколова',
      reason: 'Вакансия: аккаунт-менеджер, этап: финал',
    });
  });

  it('builds one atomic completion payload and normalizes optional notes', () => {
    expect(buildTeamReviewCompletionWrite({
      outcomes: '  Уверенно взяла новые проекты  ',
      problems: '   ',
      recommendations: '  Продолжить еженедельные разборы  ',
    })).toEqual({
      status: 'completed',
      outcomes: 'Уверенно взяла новые проекты',
      problems: null,
      recommendations: 'Продолжить еженедельные разборы',
    });
  });
});

describe('team activity plan write payloads', () => {
  const common = {
    planMonth: '2026-08',
    periodicity: '  Ежемесячно  ',
    activity: '  Профессиональный конкурс  ',
    format: '  Анонс в общем чате  ',
    note: '  Итоги и награждение  ',
    budgetAmount: '1400.50',
    budgetNote: '  Две премии по 700 ₽  ',
    status: 'planned' as const,
    position: 3,
  };

  it('builds an exact-date activity with optional time and clears schedule text', () => {
    expect(buildTeamActivityPlanWrite({
      ...common,
      timingType: 'date',
      plannedDate: '2026-09-01',
      plannedTime: '16:30',
      scheduleNote: '  каждую среду  ',
    })).toEqual({
      planMonth: '2026-08',
      periodicity: 'Ежемесячно',
      activity: 'Профессиональный конкурс',
      format: 'Анонс в общем чате',
      plannedDate: '2026-09-01',
      plannedTime: '16:30',
      scheduleNote: null,
      note: 'Итоги и награждение',
      budgetAmount: 1400.5,
      budgetNote: 'Две премии по 700 ₽',
      status: 'planned',
      position: 3,
    });
  });

  it('builds a recurring activity and clears exact date fields', () => {
    expect(buildTeamActivityPlanWrite({
      ...common,
      timingType: 'schedule',
      plannedDate: '2026-08-12',
      plannedTime: '14:00',
      scheduleNote: '  каждую среду, 14:00  ',
      format: '   ',
      note: '',
      budgetAmount: '',
      budgetNote: '  Размер премии уточнить  ',
    })).toEqual({
      planMonth: '2026-08',
      periodicity: 'Ежемесячно',
      activity: 'Профессиональный конкурс',
      format: null,
      plannedDate: null,
      plannedTime: null,
      scheduleNote: 'каждую среду, 14:00',
      note: null,
      budgetAmount: null,
      budgetNote: 'Размер премии уточнить',
      status: 'planned',
      position: 3,
    });
  });

  it('builds an activity without a date and clears all hidden timing fields', () => {
    expect(buildTeamActivityPlanWrite({
      ...common,
      timingType: 'none',
      plannedDate: '2026-08-12',
      plannedTime: '14:00',
      scheduleNote: '  каждую среду, 14:00  ',
    })).toEqual({
      planMonth: '2026-08',
      periodicity: 'Ежемесячно',
      activity: 'Профессиональный конкурс',
      format: 'Анонс в общем чате',
      plannedDate: null,
      plannedTime: null,
      scheduleNote: null,
      note: 'Итоги и награждение',
      budgetAmount: 1400.5,
      budgetNote: 'Две премии по 700 ₽',
      status: 'planned',
      position: 3,
    });
  });
});

describe('normalizeActivityPlan', () => {
  it('normalizes snake_case rows, nullable planning fields and numeric summary values', () => {
    expect(normalizeActivityPlan({
      period: {
        month: '2026-08',
        label: 'Август 2026',
        previous_month: '2026-07',
        next_month: '2026-09',
      },
      items: [{
        id: 'activity-1',
        plan_month: '2026-08',
        periodicity: 'Еженедельно',
        activity: 'Обучающий созвон',
        format: null,
        planned_date: null,
        planned_time: null,
        schedule_note: 'Каждую среду, 14:00',
        note: '',
        budget_amount: '700.50',
        budget_note: null,
        status: 'completed',
        position: '2',
        created_at: '2026-08-01T10:00:00.000Z',
        updated_at: '2026-08-02T10:00:00.000Z',
      }],
      summary: {
        total: '1',
        planned: 0,
        completed: '1',
        cancelled: 0,
        overdue: 0,
        budget_amount: '700.50',
        budget_unspecified: '0',
      },
      as_of: '2026-08-08',
      can_manage: true,
    })).toEqual({
      period: {
        month: '2026-08',
        label: 'Август 2026',
        previousMonth: '2026-07',
        nextMonth: '2026-09',
      },
      items: [{
        id: 'activity-1',
        planMonth: '2026-08',
        periodicity: 'Еженедельно',
        activity: 'Обучающий созвон',
        format: null,
        plannedDate: null,
        plannedTime: null,
        scheduleNote: 'Каждую среду, 14:00',
        note: null,
        budgetAmount: 700.5,
        budgetNote: null,
        status: 'completed',
        position: 2,
        createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-08-02T10:00:00.000Z',
      }],
      summary: {
        total: 1,
        planned: 0,
        completed: 1,
        cancelled: 0,
        overdue: 0,
        budgetAmount: 700.5,
        budgetUnspecified: 0,
      },
      asOf: '2026-08-08',
      canManage: true,
    });
  });

  it('keeps one timing mode for legacy rows by preferring an exact date', () => {
    const normalized = normalizeActivityPlan({
      period: {
        month: '2026-08',
        label: 'Август 2026',
        previousMonth: '2026-07',
        nextMonth: '2026-09',
      },
      items: [{
        id: 'legacy-both',
        planMonth: '2026-08',
        periodicity: 'Ситуативно',
        activity: 'Встреча с командой',
        plannedDate: '2026-08-12',
        plannedTime: '14:00',
        scheduleNote: 'Каждую среду, 14:00',
        status: 'planned',
        position: 0,
        createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-08-01T10:00:00.000Z',
      }, {
        id: 'legacy-time-only',
        planMonth: '2026-08',
        periodicity: 'По возможности',
        activity: 'Публикация',
        plannedDate: null,
        plannedTime: '16:00',
        scheduleNote: null,
        status: 'planned',
        position: 1,
        createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-08-01T10:00:00.000Z',
      }],
      summary: {},
      asOf: '2026-08-08',
      canManage: true,
    });

    expect(normalized.items[0]).toEqual(expect.objectContaining({
      plannedDate: '2026-08-12',
      plannedTime: '14:00',
      scheduleNote: null,
    }));
    expect(normalized.items[1]).toEqual(expect.objectContaining({
      plannedDate: null,
      plannedTime: null,
      scheduleNote: null,
    }));
  });
});

describe('normalizeReviews', () => {
  it('preserves nullable scheduled fields and treats legacy rows as completed', () => {
    const employee = {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Анна Ким',
      email: null,
      role: 'technician',
      avatarUrl: null,
    };
    const { reviews } = normalizeReviews({
      reviews: [
        {
          id: 'scheduled',
          reviewDate: '2026-08-12',
          employee,
          candidateName: null,
          reviewer: null,
          status: 'scheduled',
          reason: null,
          outcomes: null,
          problems: null,
          recommendations: null,
          createdAt: '2026-08-01T10:00:00.000Z',
          updatedAt: '2026-08-01T10:00:00.000Z',
        },
        {
          id: 'legacy',
          reviewDate: '2026-07-12',
          employee,
          candidateName: null,
          reviewer: null,
          outcomes: 'Итоги старого ревью',
          problems: null,
          recommendations: null,
          createdAt: '2026-07-12T10:00:00.000Z',
          updatedAt: '2026-07-12T10:00:00.000Z',
        },
      ],
      employees: [employee],
      canManage: true,
      currentUserId: null,
    });

    expect(reviews[0]).toEqual(expect.objectContaining({
      status: 'scheduled',
      reason: null,
      outcomes: null,
      problems: null,
      recommendations: null,
      candidateName: null,
    }));
    expect(reviews[1].status).toBe('completed');
  });

  it('normalizes a candidate without inventing a placeholder employee profile', () => {
    const { reviews } = normalizeReviews({
      reviews: [
        {
          id: 'candidate-review',
          reviewDate: '2026-08-15',
          employee: null,
          candidateName: 'Мария Соколова',
          reviewer: null,
          status: 'scheduled',
          reason: 'Вакансия: аккаунт-менеджер',
          outcomes: null,
          problems: null,
          recommendations: null,
          createdAt: '2026-08-01T10:00:00.000Z',
          updatedAt: '2026-08-01T10:00:00.000Z',
        },
      ],
      employees: [],
      canManage: true,
      currentUserId: null,
    });

    expect(reviews[0]).toEqual(expect.objectContaining({
      employee: null,
      candidateName: 'Мария Соколова',
      reason: 'Вакансия: аккаунт-менеджер',
    }));
  });
});

describe('normalizeStatistics', () => {
  it('preserves a missing coverage start so the UI can explain that no history exists yet', () => {
    expect(normalizeStatistics({
      coverage: { status: 'unavailable', startsAt: null },
    }).coverage.startsAt).toBeNull();
  });
});

describe('team talent reserve payloads and normalization', () => {
  it('builds the exact approved candidate payload and trims nullable values', () => {
    expect(buildTeamTalentReserveWrite({
      contact: '  @candidate  ',
      candidateName: '  Мария Кандидатова  ',
      vacancyDirection: '  Аккаунт-менеджер  ',
      testAssignment: '  Подготовить разбор кейса  ',
      testResult: '  Хороший результат  ',
      testSentOn: '2026-08-05',
      interviewOn: '2026-08-10',
      comment: '  Сильная коммуникация  ',
      revisitOn: '2026-09-01',
      revisitNote: '  Вернуться после отпуска  ',
      stage: 'return_later',
    })).toEqual({
      contact: '@candidate',
      candidateName: 'Мария Кандидатова',
      vacancyDirection: 'Аккаунт-менеджер',
      testAssignment: 'Подготовить разбор кейса',
      testResult: 'Хороший результат',
      testSentOn: '2026-08-05',
      interviewOn: '2026-08-10',
      comment: 'Сильная коммуникация',
      revisitOn: '2026-09-01',
      revisitNote: 'Вернуться после отпуска',
      stage: 'return_later',
    });
  });

  it('clears hidden return fields outside return_later and normalizes blank optional fields', () => {
    expect(buildTeamTalentReserveWrite({
      contact: 'candidate@example.com',
      candidateName: 'Иван Смирнов',
      vacancyDirection: 'Аутрич',
      testAssignment: '   ',
      testResult: '',
      testSentOn: '',
      interviewOn: '',
      comment: '   ',
      revisitOn: '2026-09-01',
      revisitNote: 'Скрытый старый черновик',
      stage: 'new',
    })).toEqual({
      contact: 'candidate@example.com',
      candidateName: 'Иван Смирнов',
      vacancyDirection: 'Аутрич',
      testAssignment: null,
      testResult: null,
      testSentOn: null,
      interviewOn: null,
      comment: null,
      revisitOn: null,
      revisitNote: null,
      stage: 'new',
    });
  });

  it('normalizes canonical rows, numeric summaries and the server as-of date', () => {
    expect(normalizeTalentReserve({
      entries: [{
        id: 'talent-1',
        contact: '@candidate',
        candidate_name: 'Мария Кандидатова',
        vacancy_direction: 'Аккаунт-менеджер',
        test_assignment: null,
        test_result: 'Хорошо',
        test_sent_on: '2026-08-05',
        interview_on: '2026-08-11',
        comment: '',
        revisit_on: null,
        revisit_note: null,
        stage: 'interview',
        created_by: 'user-1',
        updated_by: 'user-2',
        created_at: '2026-08-01T10:00:00.000Z',
        updated_at: '2026-08-02T10:00:00.000Z',
      }],
      summary: {
        total: '1',
        attention_count: '1',
        active_count: '1',
        history_count: '0',
      },
      as_of: '2026-08-11',
      can_manage: true,
    })).toEqual({
      entries: [{
        id: 'talent-1',
        contact: '@candidate',
        candidateName: 'Мария Кандидатова',
        vacancyDirection: 'Аккаунт-менеджер',
        testAssignment: null,
        testResult: 'Хорошо',
        testSentOn: '2026-08-05',
        interviewOn: '2026-08-11',
        comment: null,
        revisitOn: null,
        revisitNote: null,
        stage: 'interview',
        createdBy: 'user-1',
        updatedBy: 'user-2',
        createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-08-02T10:00:00.000Z',
      }],
      summary: {
        total: 1,
        attentionCount: 1,
        activeCount: 1,
        historyCount: 0,
      },
      asOf: '2026-08-11',
      canManage: true,
    });
  });
});

describe('team review request payloads and normalization', () => {
  it('builds a staff request without any client-controlled initiator field', () => {
    const payload = buildTeamReviewRequestWrite({
      employeeUserId: 'employee-1',
      projectId: 'project-1',
      problem: '  Не хватает контекста  ',
      examples: '  https://t.me/c/123/456  ',
      desiredOutcome: '  Зафиксировать следующий шаг  ',
    });

    expect(payload).toEqual({
      employeeUserId: 'employee-1',
      projectId: 'project-1',
      problem: 'Не хватает контекста',
      examples: 'https://t.me/c/123/456',
      desiredOutcome: 'Зафиксировать следующий шаг',
    });
    expect(payload).not.toHaveProperty('initiator');
    expect(payload).not.toHaveProperty('initiatorUserId');
    expect(payload).not.toHaveProperty('createdBy');

    expect(buildTeamReviewRequestWrite({
      employeeUserId: 'employee-1',
      projectId: '',
      problem: 'Проблема',
      examples: '   ',
      desiredOutcome: 'Результат',
    })).toEqual({
      employeeUserId: 'employee-1',
      projectId: null,
      problem: 'Проблема',
      examples: null,
      desiredOutcome: 'Результат',
    });
  });

  it('builds explicit claim/decline and atomic conversion payloads with CAS', () => {
    expect(buildTeamReviewRequestActionWrite({
      action: 'claim',
      expectedUpdatedAt: '2026-08-11T08:00:00.000Z',
    })).toEqual({
      action: 'claim',
      expectedUpdatedAt: '2026-08-11T08:00:00.000Z',
    });
    expect(buildTeamReviewRequestActionWrite({
      action: 'decline',
      decisionNote: '  Сначала обсудить внутри команды  ',
      expectedUpdatedAt: '2026-08-11T08:00:00.000Z',
    })).toEqual({
      action: 'decline',
      decisionNote: 'Сначала обсудить внутри команды',
      expectedUpdatedAt: '2026-08-11T08:00:00.000Z',
    });
    expect(buildTeamReviewRequestConversionWrite({
      reviewDate: '2026-08-15',
      reviewReason: '  Обсудить приоритеты  ',
      expectedUpdatedAt: '2026-08-11T08:00:00.000Z',
    })).toEqual({
      reviewDate: '2026-08-15',
      reviewReason: 'Обсудить приоритеты',
      expectedUpdatedAt: '2026-08-11T08:00:00.000Z',
    });
  });

  it('normalizes four stable groups even when the server payload is sparse and unordered', () => {
    const normalized = normalizeReviewRequests({
      groups: [
        {
          state: 'converted',
          requests: [{
            id: 'request-converted',
            state: 'converted',
            employee: { id: 'employee-1', name: 'Анна Ким', email: null, avatar_url: null },
            initiator: { id: 'lead-1', name: 'Иван', email: 'lead@example.com', avatar_url: null },
            project: { id: 'project-1', name: 'Acme · Аутрич' },
            problem: 'Ревью запланировано',
            examples: null,
            desired_outcome: 'План действий',
            claimed_by: { id: 'hr-1', name: 'Алина' },
            linked_review_id: 'review-1',
            decision_note: null,
            created_at: '2026-08-11T08:00:00.000Z',
            updated_at: '2026-08-11T09:00:00.000Z',
          }],
        },
        { state: 'new', requests: [] },
      ],
      summary: {
        total: '1',
        new_count: '0',
        in_progress_count: '0',
        converted_count: '1',
        declined_count: '0',
      },
      employees: [],
      projects: [],
      can_manage: true,
    });

    expect(normalized.groups.map((group) => group.state)).toEqual([
      'new',
      'in_progress',
      'converted',
      'declined',
    ]);
    expect(normalized.groups.map((group) => group.requests.length)).toEqual([0, 0, 1, 0]);
    expect(normalized.groups[2].requests[0]).toEqual(expect.objectContaining({
      id: 'request-converted',
      state: 'converted',
      desiredOutcome: 'План действий',
      claimedBy: expect.objectContaining({ id: 'hr-1', name: 'Алина' }),
      linkedReviewId: 'review-1',
      decisionNote: null,
      createdAt: '2026-08-11T08:00:00.000Z',
      updatedAt: '2026-08-11T09:00:00.000Z',
    }));
    expect(normalized.summary).toEqual({
      total: 1,
      newCount: 0,
      inProgressCount: 0,
      convertedCount: 1,
      declinedCount: 0,
    });
    expect(normalized.canManage).toBe(true);
  });

  it('normalizes the lightweight badge count and fails closed for invalid values', () => {
    expect(normalizeReviewRequestSummary({ new_count: '12' })).toEqual({ newCount: 12 });
    expect(normalizeReviewRequestSummary({ newCount: -3 })).toEqual({ newCount: 0 });
    expect(normalizeReviewRequestSummary({ newCount: 'not-a-number' })).toEqual({ newCount: 0 });
  });
});

describe('teamApiFetch', () => {
  it('throws a typed TeamApiError with the 409 conflict metadata intact', async () => {
    const payload = {
      error: 'Review changed; reload and try again',
      code: 'review_conflict',
      currentUpdatedAt: '2026-08-02T10:15:00.000Z',
    };
    (supabase.auth.getSession as jest.Mock).mockResolvedValue({
      data: { session: { access_token: 'test-token' } },
    });
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => payload,
    } as Response);

    let thrown: unknown;
    try {
      await teamApiFetch('/api/team/reviews/review-1', {
        method: 'PATCH',
        body: JSON.stringify({ expectedUpdatedAt: '2026-08-02T10:00:00.000Z' }),
      });
    } catch (error) {
      thrown = error;
    }

    const TeamApiError = (teamApiModule as typeof teamApiModule & {
      TeamApiError?: new (...args: never[]) => Error;
    }).TeamApiError;
    expect(TeamApiError).toBeDefined();
    expect((thrown as Error).constructor).toBe(TeamApiError);
    expect(thrown).toMatchObject({
      message: payload.error,
      status: 409,
      code: 'review_conflict',
      payload,
    });
  });
});

describe('teamStatisticsIsoDate', () => {
  it('uses the Moscow calendar boundary instead of the browser timezone', () => {
    expect(teamStatisticsIsoDate(new Date('2026-07-31T20:59:59.999Z'))).toBe('2026-07-31');
    expect(teamStatisticsIsoDate(new Date('2026-07-31T21:00:00.000Z'))).toBe('2026-08-01');
  });
});
