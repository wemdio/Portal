/** @jest-environment node */

jest.mock('@/lib/supabaseClient', () => ({
  supabase: { auth: { getSession: jest.fn() } },
}));

import { buildTeamReviewWrite, normalizeStatistics, teamStatisticsIsoDate } from '@/components/team/teamApi';

describe('buildTeamReviewWrite', () => {
  it('keeps empty optional fields in PATCH payloads so existing text can be cleared', () => {
    const payload = buildTeamReviewWrite({
      reviewDate: '2026-07-29',
      employeeUserId: '00000000-0000-4000-8000-000000000002',
      outcomes: '  Итоги  ',
      problems: '   ',
      recommendations: '',
    });

    expect(payload).toEqual({
      reviewDate: '2026-07-29',
      employeeUserId: '00000000-0000-4000-8000-000000000002',
      outcomes: 'Итоги',
      problems: '',
      recommendations: '',
    });
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
