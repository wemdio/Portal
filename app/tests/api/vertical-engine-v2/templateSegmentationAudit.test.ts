/** @jest-environment node */

/**
 * Contract for the pre-launch segmentation audit.
 *
 * POST is intentionally asynchronous: it persists a pending ve_* audit and
 * enqueues a dedicated ve_jobs stage. GET exposes the latest audit summary for
 * specialist review, but never returns the full row-level assignments payload.
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';
import {
  computeSegmentationAuditHash,
  prepareSegmentationAudience,
} from '@/lib/verticalEngineV2/segmentationAudit';
import { VE_LAUNCH_MAX_LEADS } from '@/lib/verticalEngineV2/launchHandoff';

const USER_ID = '00000000-0000-4000-8000-000000000281';
const PROJECT_ID = 'project-audit-1';
const TEMPLATE_ID = 'template-audit-1';
const BASE_ID = 'base-audit-1';

let mockDb: MockSupabaseClient = createMockSupabase();
let mockAuthorized = true;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: jest.fn(async () =>
    mockAuthorized
      ? { auth: { supabase: mockDb, userId: USER_ID, role: 'specialist' } }
      : {
          error: new Response(JSON.stringify({ error: 'Forbidden' }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          }),
        },
  ),
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

import {
  GET,
  PATCH,
  POST,
} from '@/app/api/tools/vertical-engine-v2/templates/[id]/segmentation-audit/route';

const params = { params: Promise.resolve({ id: TEMPLATE_ID }) };

function request(method: 'GET' | 'PATCH' | 'POST', body?: unknown): NextRequest {
  return new Request(
    `http://x/api/tools/vertical-engine-v2/templates/${TEMPLATE_ID}/segmentation-audit`,
    {
      method,
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    },
  ) as unknown as NextRequest;
}

function seed(options: {
  audits?: Array<Record<string, unknown>>;
  jobs?: Array<Record<string, unknown>>;
  baseRows?: Array<Record<string, unknown>>;
  templateLaunchInfo?: Record<string, unknown> | null;
  enforceQueryWindows?: boolean;
} = {}) {
  mockDb = createMockSupabase({
    enforceQueryWindows: options.enforceQueryWindows,
    rpcHandlers: {
      ve_enqueue_segmentation_audit: async (params, db) => {
        const existing = db
          .getRows('ve_segmentation_audits')
          .find(
            (audit) =>
              audit.template_id === params.p_template_id &&
              (audit.status === 'pending' || audit.status === 'running'),
          );
        if (existing) {
          let job = db
            .getRows('ve_jobs')
            .find(
              (candidate) =>
                candidate.project_id === params.p_project_id &&
                candidate.stage === 'segmentation_audit' &&
                (candidate.payload as { audit_id?: unknown } | undefined)?.audit_id === existing.id,
            );
          if (!job) {
            const inserted = await db
              .from('ve_jobs')
              .insert({
                project_id: params.p_project_id,
                stage: 'segmentation_audit',
                status: 'pending',
                payload: {
                  audit_id: existing.id,
                  template_id: params.p_template_id,
                  base_id: params.p_base_id,
                },
              })
              .select()
              .single();
            job = inserted.data ?? undefined;
          }
          return { data: [{ audit_row: existing, job_row: job, created: false }] };
        }

        const insertedAudit = await db
          .from('ve_segmentation_audits')
          .insert({
            project_id: params.p_project_id,
            template_id: params.p_template_id,
            base_id: params.p_base_id,
            requested_by: params.p_requested_by,
            status: 'pending',
            launch_status: 'idle',
          })
          .select()
          .single();
        const audit = insertedAudit.data as Record<string, unknown>;
        const insertedJob = await db
          .from('ve_jobs')
          .insert({
            project_id: params.p_project_id,
            stage: 'segmentation_audit',
            status: 'pending',
            payload: {
              audit_id: audit.id,
              template_id: params.p_template_id,
              base_id: params.p_base_id,
            },
          })
          .select()
          .single();
        return {
          data: [{ audit_row: audit, job_row: insertedJob.data, created: true }],
        };
      },
      ve_resolve_template_launch: async (params, db) => {
        const audit = db
          .getRows('ve_segmentation_audits')
          .find(
            (row) =>
              row.id === params.p_audit_id &&
              row.template_id === params.p_template_id &&
              row.launch_reservation_id === params.p_launch_reservation_id &&
              row.launch_status === 'uncertain',
          );
        if (!audit) return { data: { resolved: false } };
        if (params.p_resolution === 'campaign_created') {
          const updatedTemplate = await db
            .from('ve_templates')
            .update({ launch_info: params.p_launch_info })
            .eq('id', params.p_template_id);
          const templateError = (updatedTemplate as { error?: { message: string } | null }).error;
          if (templateError) return { data: null, error: templateError };
        }
        const terminalStatus = params.p_resolution === 'campaign_created' ? 'succeeded' : 'failed';
        const updatedAudit = await db
          .from('ve_segmentation_audits')
          .update({
            launch_status: terminalStatus,
            launch_error:
              params.p_resolution === 'no_campaign'
                ? 'Специалист подтвердил: кампания не создана'
                : null,
            launch_resolution_id: params.p_resolution_id,
            launch_resolved_by: params.p_resolved_by,
            launch_resolved_at: params.p_now,
            launch_completed_at: params.p_now,
            updated_at: params.p_now,
          })
          .eq('id', params.p_audit_id)
          .select('*')
          .maybeSingle();
        return {
          data: {
            resolved: true,
            audit_row: updatedAudit.data,
            launch_info: params.p_launch_info,
          },
        };
      },
    },
    tables: {
      ve_projects: [{ id: PROJECT_ID, created_by: USER_ID, status: 'researched' }],
      ve_templates: [
        {
          id: TEMPLATE_ID,
          base_id: BASE_ID,
          vertical_id: 'vertical-audit-1',
          status: 'ready',
          letters: [
            {
              subject: 'Тема',
              body: 'Основной текст',
              wait_days: 0,
              segment_variants: [{ when: 'частные школы', text: 'Текст для школ' }],
            },
          ],
          launch_info: options.templateLaunchInfo ?? null,
          updated_at: '2026-08-28T10:00:00.000Z',
        },
      ],
      ve_bases: [
        {
          id: BASE_ID,
          project_id: PROJECT_ID,
          vertical_id: 'vertical-audit-1',
          filename: 'schools.csv',
          source: 'upload',
          columns: ['Email', 'Компания', 'Отрасль'],
          data:
            options.baseRows ??
            [
              { Email: 'alpha@example.test', Компания: 'Альфа', Отрасль: 'Школа' },
              { Email: 'beta@example.test', Компания: 'Бета', Отрасль: 'Образование' },
            ],
          updated_at: '2026-08-28T09:00:00.000Z',
        },
      ],
      ve_segmentation_audits: options.audits ?? [],
      ve_jobs: options.jobs ?? [],
      he_jobs: [{ id: 'legacy-job', status: 'done' }],
    },
  });
}

function readyAuditRow(overrides: Record<string, unknown> = {}) {
  const assignments = new Map<number, string | null>([
    [0, null],
    [1, 'частные школы'],
  ]);
  const audience = prepareSegmentationAudience({
    rows: [
      { Email: 'alpha@example.test', Компания: 'Альфа', Отрасль: 'Школа' },
      { Email: 'beta@example.test', Компания: 'Бета', Отрасль: 'Образование' },
    ],
    columns: ['Email', 'Компания', 'Отрасль'],
    source: 'upload',
  });
  const inputHash = computeSegmentationAuditHash({
    templateId: TEMPLATE_ID,
    baseId: BASE_ID,
    segments: ['частные школы'],
    audience,
    assignments,
  });
  return {
    id: 'audit-ready',
    project_id: PROJECT_ID,
    template_id: TEMPLATE_ID,
    base_id: BASE_ID,
    requested_by: USER_ID,
    status: 'ready',
    input_hash: inputHash,
    segment_keys: ['частные школы'],
    summary: {
      version: 1,
      status: 'complete',
      base_rows_total: 2,
      total_base_rows: 2,
      launchable_rows_total: 2,
      launchable_rows: 2,
      covered_rows_total: 2,
      default_rows_total: 1,
      unclassified_rows_total: 0,
      unclassified_count: 0,
      excluded: {
        low_relevance: 0,
        invalid_verification: 0,
        invalid_email_status: 0,
        invalid_email: 0,
        duplicate_email: 0,
      },
      segments: [
        {
          key: 'частные школы',
          count: 1,
          share_pct: 50,
          examples: [{ row_index: 1, label: 'Бета', email: 'beta@example.test' }],
        },
      ],
      default: {
        count: 1,
        share_pct: 50,
        examples: [{ row_index: 0, label: 'Альфа', email: 'alpha@example.test' }],
      },
      failed_batches: 0,
      total_batches: 1,
    },
    assignments: [...assignments].map(([row_index, segment]) => ({ row_index, segment })),
    error: null,
    tokens_used: 10,
    cost_usd: 0.001,
    completed_at: '2026-08-28T11:00:10.000Z',
    launch_status: 'idle',
    launch_reservation_id: null,
    launch_preset_id: null,
    launch_started_at: null,
    launch_heartbeat_at: null,
    launch_completed_at: null,
    launch_error: null,
    launch_resolution_id: null,
    launch_resolved_by: null,
    launch_resolved_at: null,
    created_at: '2026-08-28T11:00:00.000Z',
    updated_at: '2026-08-28T11:00:10.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorized = true;
  seed();
});

describe('POST /api/tools/vertical-engine-v2/templates/[id]/segmentation-audit', () => {
  it('persists a pending v2 audit and enqueues the dedicated worker stage', async () => {
    const response = await POST(request('POST'), params);
    expect(response.status).toBe(201);

    const body = (await response.json()) as {
      ok: boolean;
      audit: Record<string, unknown>;
      job: Record<string, unknown>;
    };
    expect(body.ok).toBe(true);
    expect(body.audit).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        project_id: PROJECT_ID,
        template_id: TEMPLATE_ID,
        base_id: BASE_ID,
        status: 'pending',
      }),
    );
    expect(body.job).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        project_id: PROJECT_ID,
        stage: 'segmentation_audit',
        status: 'pending',
        payload: expect.objectContaining({
          audit_id: body.audit.id,
          template_id: TEMPLATE_ID,
          base_id: BASE_ID,
        }),
      }),
    );

    expect(mockDb.getRows('ve_segmentation_audits')).toHaveLength(1);
    expect(mockDb.getRows('ve_jobs')).toHaveLength(1);
    expect(mockDb.getRows('he_jobs')).toEqual([{ id: 'legacy-job', status: 'done' }]);
    expect(mockDb.mutations.map((mutation) => mutation.table)).toEqual([
      've_segmentation_audits',
      've_jobs',
    ]);
    expect(mockDb.rpcCalls).toEqual([
      expect.objectContaining({ fn: 've_enqueue_segmentation_audit' }),
    ]);
  });

  it('is idempotent while an audit job for this template is active', async () => {
    seed({
      audits: [
        {
          id: 'audit-active',
          project_id: PROJECT_ID,
          template_id: TEMPLATE_ID,
          base_id: BASE_ID,
          status: 'pending',
          created_at: '2026-08-28T10:01:00.000Z',
        },
      ],
      jobs: [
        {
          id: 'job-active',
          project_id: PROJECT_ID,
          stage: 'segmentation_audit',
          status: 'pending',
          payload: { audit_id: 'audit-active', template_id: TEMPLATE_ID, base_id: BASE_ID },
        },
      ],
    });

    const response = await POST(request('POST'), params);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      existing?: boolean;
      audit: { id: string };
      job: { id: string };
    };
    expect(body).toEqual(
      expect.objectContaining({
        ok: true,
        existing: true,
        audit: expect.objectContaining({ id: 'audit-active' }),
        job: expect.objectContaining({ id: 'job-active' }),
      }),
    );
    expect(mockDb.inserts).toHaveLength(0);
  });

  it('does not enqueue an audit whose exact launch audience exceeds the launch cap', async () => {
    seed({
      baseRows: Array.from({ length: VE_LAUNCH_MAX_LEADS + 1 }, (_, index) => ({
        Email: `lead-${index}@example.test`,
        Компания: `Компания ${index}`,
      })),
    });

    const response = await POST(request('POST'), params);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(
      expect.objectContaining({ error: expect.stringMatching(/2.?001|лимит/i) }),
    );
    expect(mockDb.getRows('ve_segmentation_audits')).toHaveLength(0);
    expect(mockDb.getRows('ve_jobs')).toHaveLength(0);
  });

  it('repairs a legacy orphan inside the transactional enqueue RPC', async () => {
    seed({
      audits: [
        {
          id: 'audit-fresh-orphan',
          project_id: PROJECT_ID,
          template_id: TEMPLATE_ID,
          base_id: BASE_ID,
          status: 'pending',
          created_at: new Date().toISOString(),
        },
      ],
    });

    const response = await POST(request('POST'), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        ok: true,
        existing: true,
        audit: expect.objectContaining({ id: 'audit-fresh-orphan' }),
        job: expect.objectContaining({
          stage: 'segmentation_audit',
          payload: expect.objectContaining({ audit_id: 'audit-fresh-orphan' }),
        }),
      }),
    );
    expect(mockDb.inserts).toEqual([
      expect.objectContaining({ table: 've_jobs' }),
    ]);
  });
});

describe('GET /api/tools/vertical-engine-v2/templates/[id]/segmentation-audit', () => {
  it('returns the latest ready summary without leaking row-level assignments', async () => {
    const ready = readyAuditRow();
    seed({
      enforceQueryWindows: true,
      audits: [
        {
          id: 'audit-old',
          project_id: PROJECT_ID,
          template_id: TEMPLATE_ID,
          base_id: BASE_ID,
          status: 'failed',
          created_at: '2026-08-28T09:00:00.000Z',
        },
        ready,
      ],
    });

    const response = await GET(request('GET'), params);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { audit: Record<string, unknown> };
    expect(body.audit).toEqual(
      expect.objectContaining({
        id: 'audit-ready',
        status: 'ready',
        current: true,
        input_hash: ready.input_hash,
        summary: ready.summary,
        launch_status: 'idle',
      }),
    );
    expect(body.audit).not.toHaveProperty('assignments');
  });

  it('turns an expired running launch into an explicit uncertain blocker', async () => {
    seed({
      audits: [
        readyAuditRow({
          launch_status: 'running',
          launch_reservation_id: 'reservation-expired',
          launch_preset_id: 'preset-1',
          launch_started_at: new Date(Date.now() - 20 * 60_000).toISOString(),
        }),
      ],
    });

    const response = await GET(request('GET'), params);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { audit: Record<string, unknown> };
    expect(body.audit).toEqual(
      expect.objectContaining({
        id: 'audit-ready',
        launch_status: 'uncertain',
        launch_error: expect.stringMatching(/истёк|провер/i),
      }),
    );
    expect(mockDb.getRows('ve_segmentation_audits')[0]).toEqual(
      expect.objectContaining({ launch_status: 'uncertain' }),
    );
  });
});

describe('PATCH /api/tools/vertical-engine-v2/templates/[id]/segmentation-audit', () => {
  it('releases an uncertain reservation only after the specialist confirms there is no campaign', async () => {
    seed({
      audits: [
        readyAuditRow({
          launch_status: 'uncertain',
          launch_reservation_id: 'reservation-1',
          launch_preset_id: 'preset-1',
          launch_started_at: '2026-08-28T11:05:00.000Z',
          launch_error: 'timeout',
        }),
      ],
    });

    const response = await PATCH(
      request('PATCH', {
        audit_id: 'audit-ready',
        launch_reservation_id: 'reservation-1',
        resolution: 'no_campaign',
        confirm: true,
      }),
      params,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { audit: Record<string, unknown> };
    expect(body.audit).toEqual(
      expect.objectContaining({ launch_status: 'failed', current: true }),
    );
    expect(mockDb.getRows('ve_segmentation_audits')[0]).toEqual(
      expect.objectContaining({
        launch_status: 'failed',
        launch_error: expect.stringMatching(/не создана/i),
      }),
    );
  });

  it('records manually verified campaign ids before releasing an uncertain reservation', async () => {
    seed({
      audits: [
        readyAuditRow({
          launch_status: 'uncertain',
          launch_reservation_id: 'reservation-2',
          launch_preset_id: 'preset-1',
          launch_started_at: '2026-08-28T11:05:00.000Z',
          launch_error: 'network timeout',
        }),
      ],
    });

    const response = await PATCH(
      request('PATCH', {
        audit_id: 'audit-ready',
        launch_reservation_id: 'reservation-2',
        resolution: 'campaign_created',
        campaign_ids: ['campaign-primary', 'campaign-segment'],
        confirm: true,
      }),
      params,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      audit: { launch_status: string; launch?: { campaign_id?: string; campaigns?: unknown[] } };
    };
    expect(body.audit.launch_status).toBe('succeeded');
    expect(body.audit.launch).toEqual(
      expect.objectContaining({
        campaign_id: 'campaign-primary',
        preset_id: 'preset-1',
        segmentation_audit_id: 'audit-ready',
        campaigns: expect.arrayContaining([
          expect.objectContaining({ campaign_id: 'campaign-primary' }),
          expect.objectContaining({ campaign_id: 'campaign-segment' }),
        ]),
      }),
    );
    expect(mockDb.getRows('ve_templates')[0]?.launch_info).toEqual(body.audit.launch);
    expect(mockDb.getRows('ve_segmentation_audits')[0]).toEqual(
      expect.objectContaining({ launch_status: 'succeeded' }),
    );
  });

  it('rejects a stale resolver that does not echo the current launch reservation', async () => {
    seed({
      audits: [
        readyAuditRow({
          launch_status: 'uncertain',
          launch_reservation_id: 'reservation-current',
          launch_preset_id: 'preset-1',
        }),
      ],
    });

    const response = await PATCH(
      request('PATCH', {
        audit_id: 'audit-ready',
        launch_reservation_id: 'reservation-stale',
        resolution: 'no_campaign',
        confirm: true,
      }),
      params,
    );
    expect(response.status).toBe(409);
    expect(mockDb.getRows('ve_segmentation_audits')[0]).toEqual(
      expect.objectContaining({
        launch_status: 'uncertain',
        launch_reservation_id: 'reservation-current',
      }),
    );
  });

  it('never releases no-campaign when Portal already knows a campaign from this audit', async () => {
    const knownLaunch = {
      campaign_id: 'campaign-known',
      campaign_name: 'Known campaign',
      campaign_url: 'https://app.instantly.ai/app/campaign/campaign-known',
      leads_count: 1,
      preset_id: 'preset-1',
      created_at: '2026-08-28T11:06:00.000Z',
      segmentation_audit_id: 'audit-ready',
      reconciliation_required: true,
    };
    seed({
      templateLaunchInfo: knownLaunch,
      audits: [
        readyAuditRow({
          launch_status: 'uncertain',
          launch_reservation_id: 'reservation-known',
          launch_preset_id: 'preset-1',
        }),
      ],
    });

    const response = await PATCH(
      request('PATCH', {
        audit_id: 'audit-ready',
        launch_reservation_id: 'reservation-known',
        resolution: 'no_campaign',
        confirm: true,
      }),
      params,
    );
    expect(response.status).toBe(409);
    expect(mockDb.getRows('ve_templates')[0]?.launch_info).toEqual(knownLaunch);
    expect(mockDb.getRows('ve_segmentation_audits')[0]).toEqual(
      expect.objectContaining({ launch_status: 'uncertain' }),
    );
  });

  it('keeps every known campaign id when the specialist adds recovered ids', async () => {
    const knownLaunch = {
      campaign_id: 'campaign-known',
      campaign_name: 'Known campaign',
      campaign_url: 'https://app.instantly.ai/app/campaign/campaign-known',
      leads_count: 1,
      preset_id: 'preset-1',
      created_at: '2026-08-28T11:06:00.000Z',
      segmentation_audit_id: 'audit-ready',
      reconciliation_required: true,
      campaigns: [
        {
          campaign_id: 'campaign-known',
          campaign_name: 'Known campaign',
          campaign_url: 'https://app.instantly.ai/app/campaign/campaign-known',
          segment: null,
          leads_count: 1,
        },
      ],
    };
    seed({
      templateLaunchInfo: knownLaunch,
      audits: [
        readyAuditRow({
          launch_status: 'uncertain',
          launch_reservation_id: 'reservation-union',
          launch_preset_id: 'preset-1',
        }),
      ],
    });

    const response = await PATCH(
      request('PATCH', {
        audit_id: 'audit-ready',
        launch_reservation_id: 'reservation-union',
        resolution: 'campaign_created',
        campaign_ids: ['campaign-recovered'],
        confirm: true,
      }),
      params,
    );
    expect(response.status).toBe(200);
    const launch = (mockDb.getRows('ve_templates')[0]?.launch_info ?? {}) as {
      campaigns?: Array<{ campaign_id?: string }>;
    };
    expect(launch.campaigns?.map((campaign) => campaign.campaign_id)).toEqual([
      'campaign-known',
      'campaign-recovered',
    ]);
  });
});
