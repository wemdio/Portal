/** @jest-environment node */

import type { NextRequest } from 'next/server';
import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

const BASE_ID = 'base-portfolio-read-1';
const TEMPLATE_ID = 'template-portfolio-read-1';
const ITEM_ID = 'item-portfolio-read-1';

let portalDb: MockSupabaseClient = createMockSupabase();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return portalDb;
  },
}));

jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: jest.fn(async () => ({
    auth: { supabase: portalDb, userId: 'user-portfolio-read', role: 'specialist' },
  })),
}));

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (
    _options: unknown,
    handler: (trace: { end: () => Promise<void>; fail: () => Promise<void> }) => Promise<unknown>,
  ) => handler({ end: async () => {}, fail: async () => {} }),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

jest.mock('@/lib/verticalEngineV2/segmentClassify', () => ({
  classifyBaseRowsIntoSegments: jest.fn(async () => null),
  detectSegmentLanguage: jest.fn(() => 'ru'),
}));

import { GET } from '@/app/api/tools/vertical-engine-v2/bases/[id]/template/route';

const params = { params: Promise.resolve({ id: BASE_ID }) };

beforeEach(() => {
  portalDb = createMockSupabase({
    tables: {
      ve_templates: [{
        id: TEMPLATE_ID,
        base_id: BASE_ID,
        vertical_id: 'vertical-portfolio-read-1',
        status: 'ready',
        letters: [{ subject: 'Тема', body: 'Текст', wait_days: 0 }],
        launch_info: { campaign_id: 'campaign-portfolio-read-1' },
        created_at: '2026-08-28T10:00:00.000Z',
      }],
      ve_bases: [{ id: BASE_ID, columns: ['Email'], sample_rows: [] }],
      ve_launch_queue_items: [{
        id: ITEM_ID,
        portfolio_id: 'ru',
        template_id: TEMPLATE_ID,
        instantly_account_id: 'workspace-a',
        mailbox_ids: ['sender@example.test'],
        status: 'queued',
        plan_version: 4,
        priority_snapshot: {
          version: 1,
          state: 'launch_now',
          automatic_activation_eligible: true,
        },
        created_at: '2026-08-28T10:01:00.000Z',
      }],
      ve_launch_portfolio_settings: [{
        id: 'ru',
        mode: 'enforced',
        max_active_bundles: 1,
        plan_version: 4,
      }],
    },
  });
});

it('returns the persisted launch portfolio gate beside a prepared template', async () => {
  const request = new Request(`http://x/api/tools/vertical-engine-v2/bases/${BASE_ID}/template`, {
    headers: { authorization: 'Bearer test-token' },
  }) as unknown as NextRequest;

  const response = await GET(request, params);
  const payload = await response.json();

  expect(response.status).toBe(200);
  expect(payload.template).toEqual(expect.objectContaining({
    id: TEMPLATE_ID,
    launch_portfolio: {
      item_id: ITEM_ID,
      status: 'queued',
      mode: 'enforced',
      plan_version: 4,
      priority_snapshot: expect.objectContaining({ state: 'launch_now' }),
      capacity: { max_active_bundles: 1, active_bundles: 0 },
    },
  }));
  expect(portalDb.selects.some((select) => select.table.startsWith('he_'))).toBe(false);
});

it('counts an overlapping active holder beyond the first default response page', async () => {
  const baseTables = {
    ve_templates: portalDb.getRows('ve_templates'),
    ve_bases: portalDb.getRows('ve_bases'),
    ve_launch_portfolio_settings: portalDb.getRows('ve_launch_portfolio_settings'),
  };
  const candidate = portalDb.getRows('ve_launch_queue_items')[0];
  const disjoint = Array.from({ length: 100 }, (_, index) => ({
    ...candidate,
    id: `disjoint-${index}`,
    template_id: `other-template-${index}`,
    mailbox_ids: [`other-${index}@example.test`],
    status: 'active',
  }));
  portalDb = createMockSupabase({
    enforceQueryWindows: true,
    tables: {
      ...baseTables,
      ve_launch_queue_items: [
        candidate,
        ...disjoint,
        {
          ...candidate,
          id: 'overlapping-holder',
          template_id: 'other-template-overlap',
          mailbox_ids: ['sender@example.test'],
          status: 'active',
        },
      ],
    },
  });
  const request = new Request(`http://x/api/tools/vertical-engine-v2/bases/${BASE_ID}/template`, {
    headers: { authorization: 'Bearer test-token' },
  }) as unknown as NextRequest;

  const response = await GET(request, params);
  const payload = await response.json();

  expect(response.status).toBe(200);
  expect(payload.template.launch_portfolio.capacity).toEqual({
    max_active_bundles: 1,
    active_bundles: 1,
  });
});
