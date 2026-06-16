/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

let mockMainDb: MockSupabaseClient | null = null;
let mockInstantlyDb: MockSupabaseClient | null = null;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockMainDb;
  },
}));

jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return mockInstantlyDb;
  },
}));

function makePeriodReq(body: unknown): NextRequest {
  return new Request('http://x/api/projects/project-1/periods', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe('POST /api/projects/[id]/periods', () => {
  beforeEach(() => {
    jest.resetModules();
    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          {
            id: 'project-1',
            contacts_obligation: '8000-16000',
            contacts_done: '182',
            contacts_done_synced_at: '2026-05-19T12:00:00.000Z',
            kpi_plan: '20',
            kpi_fact: '3',
            deadline: '2026-05-04',
            launch_date: '2026-03-27',
            payment_date: '2026-03-27',
            budget: '100000',
            margin: '30%',
            payment_method: 'bank',
            created_at: '2026-03-27T00:00:00.000Z',
          },
        ],
        project_periods: [],
      },
    });
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [],
        instantly_campaign_catalog: [],
      },
    });
  });

  it('stores old commercial terms in the closed period and new terms in the active period', async () => {
    const { POST } = await import('@/app/api/projects/[id]/periods/route');

    const res = await POST(
      makePeriodReq({
        period_start: '2026-05-20',
        contacts_obligation: '12000',
        kpi_plan: '30',
        deadline: '2026-06-20',
        budget: '150000',
        margin: '40%',
        payment_date: '2026-05-21',
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(res.status).toBe(200);

    const periods = mockMainDb!.getRows('project_periods');
    expect(periods).toHaveLength(2);
    expect(periods[0]).toEqual(
      expect.objectContaining({
        name: 'Period 1',
        status: 'closed',
        period_start: '2026-03-27',
        period_end: '2026-05-19',
        contacts_obligation: '8000-16000',
        contacts_done: '182',
        kpi_plan: '20',
        kpi_fact: '3',
        deadline: '2026-05-04',
        budget: '100000',
        margin: '30%',
        payment_date: '2026-03-27',
      }),
    );
    expect(periods[0]).not.toHaveProperty('payment_method');
    expect(periods[1]).toEqual(
      expect.objectContaining({
        name: 'Period 2',
        status: 'active',
        period_start: '2026-05-20',
        period_end: null,
        contacts_obligation: '12000',
        contacts_done: '0',
        kpi_plan: '30',
        kpi_fact: '0',
        deadline: '2026-06-20',
        budget: '150000',
        margin: '40%',
        payment_date: '2026-05-21',
      }),
    );
    expect(periods[1]).not.toHaveProperty('payment_method');

    const project = mockMainDb!.getRows('projects')[0];
    expect(project).toEqual(
      expect.objectContaining({
        contacts_obligation: '12000',
        contacts_done: '0',
        contacts_done_synced_at: null,
        kpi_plan: '30',
        kpi_fact: '0',
        deadline: '2026-06-20',
        budget: '150000',
        margin: '40%',
        payment_method: 'bank',
        payment_date: '2026-05-21',
      }),
    );
  });

  it('rejects a period_start earlier than the preceding period start (no backwards range)', async () => {
    const { POST } = await import('@/app/api/projects/[id]/periods/route');

    // launch_date = 2026-03-27 → Period 1 стартовал бы 03-27. Старт 03-20
    // раньше — у Period 1 получился бы period_end < period_start. Отклоняем.
    const res = await POST(
      makePeriodReq({ period_start: '2026-03-20', contacts_obligation: '12000' }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(res.status).toBe(400);
    // Ничего не записали: ни периодов, ни сброса проекта.
    expect(mockMainDb!.getRows('project_periods')).toHaveLength(0);
    expect(mockMainDb!.getRows('projects')[0]).toEqual(
      expect.objectContaining({ contacts_done: '182' }),
    );
  });
});
