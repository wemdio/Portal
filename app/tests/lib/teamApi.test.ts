/** @jest-environment node */

jest.mock('@/lib/supabaseClient', () => ({
  supabase: { auth: { getSession: jest.fn() } },
}));

import { supabase } from '@/lib/supabaseClient';
import * as teamApiModule from '@/components/team/teamApi';
import {
  buildTeamReviewCompletionWrite,
  buildTeamReviewScheduleWrite,
  normalizeReviews,
  normalizeStatistics,
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
