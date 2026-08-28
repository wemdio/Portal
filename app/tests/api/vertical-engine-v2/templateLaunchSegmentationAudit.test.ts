/** @jest-environment node */

/**
 * Launch must be fail-closed behind the persisted segmentation audit.
 * A reviewed ready audit is the source of truth for campaign groups: launch
 * must never classify the same rows again and risk a different LLM result.
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';
import {
  computeSegmentationAuditHash,
  prepareSegmentationAudience,
} from '@/lib/verticalEngineV2/segmentationAudit';

const USER_ID = '00000000-0000-4000-8000-000000000282';
const PROJECT_ID = 'project-launch-audit-1';
const TEMPLATE_ID = 'template-launch-audit-1';
const BASE_ID = 'base-launch-audit-1';
const PRESET_ID = 'preset-launch-audit-1';
const READY_AUDIT_ID = 'audit-ready-1';

let mockPortalDb: MockSupabaseClient = createMockSupabase();
let mockInstantlyDb: MockSupabaseClient = createMockSupabase();

const mockCreateCampaign = jest.fn();
const mockUpdateCampaign = jest.fn();
const mockCreateLeads = jest.fn();
const mockClassify = jest.fn();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockPortalDb;
  },
}));

jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return mockInstantlyDb;
  },
}));

jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: jest.fn(async () => ({
    auth: { supabase: mockPortalDb, userId: USER_ID, role: 'specialist' },
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

jest.mock('@/lib/instantly/client', () => ({
  createCampaign: (...args: unknown[]) => mockCreateCampaign(...args),
  updateCampaign: (...args: unknown[]) => mockUpdateCampaign(...args),
  createLeads: (...args: unknown[]) => mockCreateLeads(...args),
}));

jest.mock('@/lib/verticalEngineV2/segmentClassify', () => ({
  classifyBaseRowsIntoSegments: (...args: unknown[]) => mockClassify(...args),
  detectSegmentLanguage: jest.fn(() => 'ru'),
}));

import { POST } from '@/app/api/tools/vertical-engine-v2/templates/[id]/launch/route';

const params = { params: Promise.resolve({ id: TEMPLATE_ID }) };

const LETTERS = [
  {
    subject: 'Тема',
    body: 'Основной текст для {{companyName}}',
    wait_days: 0,
    segment_variants: [{ when: 'частные школы', text: 'Текст для частных школ {{companyName}}' }],
  },
];

const BASE_ROWS = [
  { Email: 'default@example.test', Компания: 'Альфа', Отрасль: 'Образование' },
  { Email: 'school@example.test', Компания: 'Бета', Отрасль: 'Частная школа' },
];

const READY_ASSIGNMENTS = new Map<number, string | null>([
  [0, null],
  [1, 'частные школы'],
]);
const INPUT_HASH = computeSegmentationAuditHash({
  templateId: TEMPLATE_ID,
  baseId: BASE_ID,
  segments: ['частные школы'],
  audience: prepareSegmentationAudience({
    rows: BASE_ROWS,
    columns: ['Email', 'Компания', 'Отрасль'],
    source: 'upload',
    operatorMapping: [{ operator: 'companyName', column: 'Компания', matched: true }],
  }),
  assignments: READY_ASSIGNMENTS,
});

const PRESET_ROW = {
  id: PRESET_ID,
  client_user_id: 'client-launch-audit-1',
  instantly_account_id: 'main',
  email_account_ids: ['sender@example.test'],
  daily_limit: 100,
  daily_max_leads: 50,
  email_gap_minutes: 15,
  open_tracking: true,
  link_tracking: true,
  stop_on_reply: true,
  text_only: false,
  schedule_from: '09:00',
  schedule_to: '18:00',
  schedule_days: [1, 2, 3, 4, 5],
  schedule_timezone: 'Europe/Kirov',
};

function readyAudit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: READY_AUDIT_ID,
    project_id: PROJECT_ID,
    template_id: TEMPLATE_ID,
    base_id: BASE_ID,
    status: 'ready',
    launch_status: 'idle',
    launch_reservation_id: null,
    launch_preset_id: null,
    launch_started_at: null,
    launch_heartbeat_at: null,
    launch_completed_at: null,
    launch_error: null,
    input_hash: INPUT_HASH,
    segment_keys: ['частные школы'],
    summary: {
      version: 1,
      base_rows_total: 2,
      launchable_rows_total: 2,
      covered_rows_total: 2,
      default_rows_total: 1,
      unclassified_rows_total: 0,
      excluded: {
        low_relevance: 0,
        invalid_verification: 0,
        invalid_email: 0,
        duplicate_email: 0,
      },
      segments: [{ key: 'частные школы', count: 1, share_pct: 50, examples: [] }],
      default: { count: 1, share_pct: 50, examples: [] },
    },
    assignments: [
      { row_index: 0, segment: null },
      { row_index: 1, segment: 'частные школы' },
    ],
    completed_at: '2026-08-28T11:00:00.000Z',
    ...overrides,
  };
}

function seed(
  audits: Array<Record<string, unknown>> = [],
  options: {
    errorUpdates?: Record<string, { message: string; patchIncludes?: Record<string, unknown> }>;
  } = {},
) {
  mockPortalDb = createMockSupabase({
    errorUpdates: options.errorUpdates,
    rpcHandlers: {
      ve_finalize_template_launch: async (params, db) => {
        const audit = db
          .getRows('ve_segmentation_audits')
          .find(
            (row) =>
              row.id === params.p_audit_id &&
              row.template_id === params.p_template_id &&
              row.launch_reservation_id === params.p_launch_reservation_id &&
              row.status === 'ready' &&
              row.launch_status === 'running',
          );
        if (!audit) return { data: { finalized: false } };
        if (params.p_launch_info) {
          const templateUpdate = await db
            .from('ve_templates')
            .update({ launch_info: params.p_launch_info })
            .eq('id', params.p_template_id);
          if (templateUpdate.error) return { data: null, error: templateUpdate.error };
        }
        const auditUpdate = await db
          .from('ve_segmentation_audits')
          .update({
            launch_status: params.p_launch_status,
            launch_error: params.p_error,
            launch_heartbeat_at: params.p_now,
            launch_completed_at: params.p_now,
            updated_at: params.p_now,
          })
          .eq('id', params.p_audit_id);
        if (auditUpdate.error) return { data: null, error: auditUpdate.error };
        return { data: { finalized: true } };
      },
    },
    tables: {
      ve_projects: [{ id: PROJECT_ID, created_by: USER_ID }],
      ve_templates: [
        {
          id: TEMPLATE_ID,
          base_id: BASE_ID,
          vertical_id: 'vertical-launch-audit-1',
          fixed_block: 'Фикс',
          personalization_plan: {
            operator_mapping: [{ operator: 'companyName', column: 'Компания', matched: true }],
          },
          letters: LETTERS,
          status: 'ready',
          launch_info: null,
          updated_at: '2026-08-28T10:00:00.000Z',
        },
      ],
      ve_bases: [
        {
          id: BASE_ID,
          project_id: PROJECT_ID,
          vertical_id: 'vertical-launch-audit-1',
          filename: 'schools.csv',
          columns: ['Email', 'Компания', 'Отрасль'],
          source: 'upload',
          data: BASE_ROWS,
          updated_at: '2026-08-28T09:00:00.000Z',
        },
      ],
      ve_segmentation_audits: audits,
      he_templates: [{ id: 'legacy-template', status: 'ready' }],
    },
  });
  mockInstantlyDb = createMockSupabase({
    tables: { client_campaign_presets: [PRESET_ROW] },
  });
}

function request(body: Record<string, unknown>): NextRequest {
  return new Request(
    `http://x/api/tools/vertical-engine-v2/templates/${TEMPLATE_ID}/launch`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  ) as unknown as NextRequest;
}

function launchBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    preset_id: PRESET_ID,
    segmentation_audit_id: READY_AUDIT_ID,
    confirm_segmentation: true,
    ...overrides,
  };
}

async function expectBlocked(
  body: Record<string, unknown>,
  code: string,
): Promise<void> {
  const response = await POST(request(body), params);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual(expect.objectContaining({ code }));
  expect(mockCreateCampaign).not.toHaveBeenCalled();
  expect(mockCreateLeads).not.toHaveBeenCalled();
  expect(mockPortalDb.updates.filter((update) => update.table === 've_templates')).toHaveLength(0);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateCampaign
    .mockReset()
    .mockImplementationOnce(async () => ({ id: 'campaign-default' }))
    .mockImplementationOnce(async () => ({ id: 'campaign-schools' }));
  mockUpdateCampaign.mockReset().mockResolvedValue({});
  mockCreateLeads
    .mockReset()
    .mockImplementation(async (leads: unknown[]) => ({ leads_uploaded: leads.length }));
  // Any invocation is a regression: launch must consume the reviewed persisted assignments.
  mockClassify.mockReset().mockRejectedValue(new Error('launch must not classify rows again'));
  seed();
});

describe('POST /api/tools/vertical-engine-v2/templates/[id]/launch — segmentation audit gate', () => {
  it('rejects a launch without an audit before any Instantly mutation', async () => {
    await expectBlocked(
      launchBody({ segmentation_audit_id: undefined }),
      'SEGMENTATION_AUDIT_REQUIRED',
    );
  });

  it('requires an explicit specialist confirmation of the reviewed audit', async () => {
    seed([readyAudit()]);
    await expectBlocked(
      launchBody({ confirm_segmentation: false }),
      'SEGMENTATION_CONFIRMATION_REQUIRED',
    );
  });

  it('rejects a stale audit tied to another base', async () => {
    seed([readyAudit({ id: 'audit-stale', base_id: 'base-before-regeneration' })]);
    await expectBlocked(
      launchBody({ segmentation_audit_id: 'audit-stale' }),
      'SEGMENTATION_AUDIT_STALE',
    );
  });

  it('rejects an audit when the current audience no longer matches its hash', async () => {
    seed([readyAudit({ input_hash: '0'.repeat(64) })]);
    await expectBlocked(launchBody(), 'SEGMENTATION_AUDIT_STALE');
  });

  it('rejects a ready row whose classification coverage is incomplete', async () => {
    seed([
      readyAudit({
        id: 'audit-incomplete',
        summary: {
          version: 1,
          base_rows_total: 2,
          launchable_rows_total: 2,
          covered_rows_total: 1,
          default_rows_total: 1,
          unclassified_rows_total: 1,
          excluded: {
            low_relevance: 0,
            invalid_verification: 0,
            invalid_email: 0,
            duplicate_email: 0,
          },
          segments: [],
          default: { count: 1, share_pct: 50, examples: [] },
        },
        assignments: [{ row_index: 0, segment: null }],
      }),
    ]);
    await expectBlocked(
      launchBody({ segmentation_audit_id: 'audit-incomplete' }),
      'SEGMENTATION_AUDIT_INCOMPLETE',
    );
  });

  it('rejects a concurrent launch while another audit owns the template reservation', async () => {
    seed([
      readyAudit({
        launch_status: 'running',
        launch_reservation_id: '00000000-0000-4000-8000-000000000999',
        launch_started_at: new Date().toISOString(),
      }),
    ]);

    await expectBlocked(launchBody(), 'TEMPLATE_LAUNCH_IN_PROGRESS');
  });

  it('stops before another campaign when project cancellation invalidates the audit mid-launch', async () => {
    seed([readyAudit()]);
    mockCreateCampaign
      .mockReset()
      .mockImplementationOnce(async () => {
        await mockPortalDb
          .from('ve_segmentation_audits')
          .update({ status: 'cancelled' })
          .eq('id', READY_AUDIT_ID);
        return { id: 'campaign-default' };
      })
      .mockResolvedValueOnce({ id: 'campaign-schools' });

    const response = await POST(request(launchBody()), params);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: 'TEMPLATE_LAUNCH_UNCERTAIN' }),
    );
    expect(mockCreateCampaign).toHaveBeenCalledTimes(1);
    expect(mockPortalDb.getRows('ve_segmentation_audits')[0]).toEqual(
      expect.objectContaining({ status: 'cancelled', launch_status: 'uncertain' }),
    );
  });

  it('uses persisted assignments verbatim, never reclassifies, and records the audit in launch_info', async () => {
    seed([readyAudit()]);

    const response = await POST(request(launchBody()), params);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      launch: {
        segmentation_audit_id?: string;
        segmentation_audit_input_hash?: string;
        campaigns?: Array<{ segment: string | null; leads_count: number }>;
      };
    };
    expect(body.ok).toBe(true);
    expect(mockClassify).not.toHaveBeenCalled();

    expect(mockCreateCampaign).toHaveBeenCalledTimes(2);
    expect(mockCreateLeads).toHaveBeenCalledTimes(2);
    const defaultLeads = mockCreateLeads.mock.calls[0][0] as Array<{ email: string }>;
    const schoolLeads = mockCreateLeads.mock.calls[1][0] as Array<{ email: string }>;
    expect(defaultLeads.map((lead) => lead.email)).toEqual(['default@example.test']);
    expect(schoolLeads.map((lead) => lead.email)).toEqual(['school@example.test']);

    expect(body.launch).toEqual(
      expect.objectContaining({
        segmentation_audit_id: READY_AUDIT_ID,
        segmentation_audit_input_hash: INPUT_HASH,
        campaigns: [
          expect.objectContaining({ segment: null, leads_count: 1 }),
          expect.objectContaining({ segment: 'частные школы', leads_count: 1 }),
        ],
      }),
    );

    const templateUpdate = mockPortalDb.updates.find((update) => update.table === 've_templates');
    expect(templateUpdate?.patch.launch_info).toEqual(
      expect.objectContaining({
        segmentation_audit_id: READY_AUDIT_ID,
        segmentation_audit_input_hash: INPUT_HASH,
      }),
    );
    expect(mockPortalDb.getRows('ve_segmentation_audits')[0]).toEqual(
      expect.objectContaining({
        launch_status: 'succeeded',
        launch_reservation_id: expect.any(String),
        launch_preset_id: PRESET_ID,
        launch_completed_at: expect.any(String),
        launch_error: null,
      }),
    );
    expect(
      mockPortalDb.selects.filter((select) => select.table === 've_templates'),
    ).toEqual([
      expect.objectContaining({ columns: '*' }),
      expect.objectContaining({ columns: 'launch_info' }),
    ]);
    expect(mockPortalDb.rpcCalls).toEqual([
      expect.objectContaining({
        fn: 've_finalize_template_launch',
        params: expect.objectContaining({
          p_audit_id: READY_AUDIT_ID,
          p_template_id: TEMPLATE_ID,
          p_launch_status: 'succeeded',
          p_launch_info: expect.objectContaining({ campaign_id: 'campaign-default' }),
        }),
      }),
    ]);
    expect(
      mockPortalDb.updates.some(
        (update) =>
          update.table === 've_segmentation_audits' &&
          typeof update.patch.launch_heartbeat_at === 'string',
      ),
    ).toBe(true);
    expect(mockPortalDb.getRows('he_templates')).toEqual([{ id: 'legacy-template', status: 'ready' }]);
  });

  it('keeps an uncertain reservation when the external launch may exist without launch_info', async () => {
    seed([readyAudit()], {
      errorUpdates: {
        ve_templates: { message: 'launch_info write failed' },
      },
    });

    const response = await POST(request(launchBody()), params);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: 'TEMPLATE_LAUNCH_UNCERTAIN' }),
    );
    expect(mockPortalDb.getRows('ve_segmentation_audits')[0]).toEqual(
      expect.objectContaining({
        launch_status: 'uncertain',
        launch_error: 'launch_info write failed',
      }),
    );

    const externalCalls = mockCreateCampaign.mock.calls.length;
    const retry = await POST(request(launchBody()), params);
    expect(retry.status).toBe(409);
    expect(await retry.json()).toEqual(
      expect.objectContaining({ code: 'TEMPLATE_LAUNCH_UNCERTAIN' }),
    );
    expect(mockCreateCampaign).toHaveBeenCalledTimes(externalCalls);
  });

  it('keeps the reservation uncertain when a later segment campaign call has an ambiguous outcome', async () => {
    seed([readyAudit()]);
    mockCreateCampaign
      .mockReset()
      .mockResolvedValueOnce({ id: 'campaign-default' })
      .mockRejectedValueOnce(new Error('second campaign timeout'));

    const response = await POST(request(launchBody()), params);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { warnings?: string[] };
    expect(body.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/second campaign timeout/i)]),
    );
    expect(mockPortalDb.getRows('ve_segmentation_audits')[0]).toEqual(
      expect.objectContaining({
        launch_status: 'uncertain',
        launch_error: expect.stringMatching(/second campaign timeout/i),
      }),
    );
  });

  it('expires an abandoned running reservation to uncertain instead of retrying externally', async () => {
    seed([
      readyAudit({
        launch_status: 'running',
        launch_reservation_id: '00000000-0000-4000-8000-000000000998',
        launch_preset_id: PRESET_ID,
        launch_started_at: new Date(Date.now() - 20 * 60_000).toISOString(),
      }),
    ]);

    await expectBlocked(launchBody(), 'TEMPLATE_LAUNCH_UNCERTAIN');
    expect(mockPortalDb.getRows('ve_segmentation_audits')[0]).toEqual(
      expect.objectContaining({ launch_status: 'uncertain' }),
    );
  });
});
