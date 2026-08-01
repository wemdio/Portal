/** @jest-environment node */

jest.mock('@/lib/supabaseClient', () => ({
  supabase: { auth: { getSession: jest.fn() } },
}));

import {
  buildTeamReviewCompletionWrite,
  buildTeamReviewScheduleWrite,
  normalizeReviews,
  normalizeStatistics,
  teamStatisticsIsoDate,
} from '@/components/team/teamApi';

describe('team review write payloads', () => {
  it('builds a minimal scheduled review payload and trims its optional reason', () => {
    expect(buildTeamReviewScheduleWrite({
      reviewDate: '2026-08-12',
      employeeUserId: '00000000-0000-4000-8000-000000000002',
      reason: '  Проверить адаптацию  ',
    })).toEqual({
      reviewDate: '2026-08-12',
      employeeUserId: '00000000-0000-4000-8000-000000000002',
      reason: 'Проверить адаптацию',
    });

    expect(buildTeamReviewScheduleWrite({
      reviewDate: '2026-08-13',
      employeeUserId: '00000000-0000-4000-8000-000000000002',
      reason: '   ',
    })).toEqual({
      reviewDate: '2026-08-13',
      employeeUserId: '00000000-0000-4000-8000-000000000002',
      reason: null,
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
    }));
    expect(reviews[1].status).toBe('completed');
  });
});

describe('normalizeStatistics', () => {
  it('preserves a missing coverage start so the UI can explain that no history exists yet', () => {
    expect(normalizeStatistics({
      coverage: { status: 'unavailable', startsAt: null },
    }).coverage.startsAt).toBeNull();
  });
});

describe('teamStatisticsIsoDate', () => {
  it('uses the Moscow calendar boundary instead of the browser timezone', () => {
    expect(teamStatisticsIsoDate(new Date('2026-07-31T20:59:59.999Z'))).toBe('2026-07-31');
    expect(teamStatisticsIsoDate(new Date('2026-07-31T21:00:00.000Z'))).toBe('2026-08-01');
  });
});
