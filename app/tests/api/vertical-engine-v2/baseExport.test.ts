/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import { NextRequest } from 'next/server';

const BASE_ID = 'base-export-1';
const TEMPLATE_ID = 'template-export-1';
const AUDIT_ID = 'audit-export-1';
const PRESET_ID = 'preset-export-1';
const CLIENT_ID = 'client-export-1';
const COLUMNS = ['company', 'email'];
const ROWS: Array<Record<string, unknown>> = [
  { company: 'Alpha', email: 'alpha@example.com', _email_status: 'ok' },
  { company: 'Bad status', email: 'status@example.com', _email_status: 'invalid' },
  {
    company: 'Unchecked relevance',
    email: 'unchecked@example.com',
    _email_status: 'ok',
    _relevance_unchecked: true,
  },
  {
    company: 'Low relevance',
    email: 'low@example.com',
    _email_status: 'ok',
    _low_relevance: true,
  },
  { company: 'Alpha duplicate', email: 'ALPHA@example.com', _email_status: 'ok' },
  { company: 'Beta', email: 'beta@example.com', _email_status: 'ok' },
  { company: 'Broken email', email: 'not-an-email', _email_status: 'ok' },
];

let mockPortalDb: MockSupabaseClient = createMockSupabase();
let mockInstantlyDb: MockSupabaseClient = createMockSupabase();
let mockAuditValidation: Record<string, unknown>;

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

jest.mock('@/lib/verticalEngineV2/stages/segmentationAudit', () => ({
  validateStoredAuditSnapshot: jest.fn(() => mockAuditValidation),
}));

jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: jest.fn(async () => ({
    auth: { supabase: mockPortalDb, userId: 'user-1', role: 'technician' },
  })),
}));

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (_options: unknown, handler: () => Promise<unknown>) => handler(),
}));

import { GET } from '@/app/api/tools/vertical-engine-v2/bases/[id]/export/route';

function request(mode?: 'raw' | 'launch-ready' | 'preview', withLaunchContext = false): NextRequest {
  const query = new URLSearchParams();
  if (mode) query.set('mode', mode);
  if (withLaunchContext) {
    query.set('template_id', TEMPLATE_ID);
    query.set('segmentation_audit_id', AUDIT_ID);
    query.set('preset_id', PRESET_ID);
  }
  return new NextRequest(
    `http://portal.test/api/tools/vertical-engine-v2/bases/${BASE_ID}/export${query.size > 0 ? `?${query}` : ''}`,
    { headers: { authorization: 'Bearer test-token' } },
  );
}

function seed(options: {
  blockedEmails?: string[];
  blocklistError?: string;
  templateStatus?: string;
} = {}) {
  mockPortalDb = createMockSupabase({
    tables: {
      ve_bases: [
        {
          id: BASE_ID,
          project_id: 'project-export-1',
          filename: 'contacts.csv',
          row_count: ROWS.length,
          columns: COLUMNS,
          data: ROWS,
          source: 'auto',
        },
      ],
      ve_templates: [
        {
          id: TEMPLATE_ID,
          base_id: BASE_ID,
          status: options.templateStatus ?? 'ready',
          letters: [
            {
              subject: 'Subject',
              body: 'Body',
              wait_days: 0,
              segment_variants: [{ when: 'Enterprise', text: 'Enterprise body' }],
            },
          ],
          personalization_plan: {},
        },
      ],
      ve_segmentation_audits: [
        {
          id: AUDIT_ID,
          project_id: 'project-export-1',
          template_id: TEMPLATE_ID,
          base_id: BASE_ID,
          status: 'ready',
          input_hash: 'a'.repeat(64),
          segment_keys: ['Enterprise'],
          assignments: [
            { row_index: 0, segment: 'Enterprise' },
            { row_index: 1, segment: null },
          ],
          summary: {},
        },
      ],
    },
  });
  const blockedEmails = options.blockedEmails ?? ['beta@example.com'];
  mockInstantlyDb = createMockSupabase({
    tables: {
      client_campaign_presets: [
        { id: PRESET_ID, client_user_id: CLIENT_ID },
      ],
    },
    rpcHandlers: {
      client_blocklist_snapshot: () => options.blocklistError
        ? { data: null, error: { message: options.blocklistError } }
        : { data: { count: blockedEmails.length, emails: blockedEmails } },
    },
  });
  mockAuditValidation = {
    state: 'current',
    snapshot: {
      segments: ['Enterprise'],
      audience: {
        totalRows: ROWS.length,
        rows: [ROWS[0], ROWS[5]],
        leads: [
          { email: 'alpha@example.com' },
          { email: 'beta@example.com' },
        ],
        originalRowIndices: [0, 5],
        labels: ['Alpha', 'Beta'],
        excluded: {
          lowRelevance: 1,
          relevanceUnchecked: 1,
          invalidEmailStatus: 1,
          invalidEmail: 1,
          duplicateEmail: 1,
        },
      },
    },
    assignments: new Map<number, string | null>([
      [0, 'Enterprise'],
      [1, null],
    ]),
  };
}

describe('Vertical Engine v2 base CSV export', () => {
  beforeEach(seed);

  it('exports at most 1000 checked preview contacts and refuses an unfinished preview', async () => {
    const ready = Array.from({ length: 1100 }, (_, i) => ({ company: `Company ${i}`, email: `lead-${i}@example.com`, _email_status: 'ok' }));
    await mockPortalDb.from('ve_bases').update({
      status: 'analyzed', row_count: ready.length, data: ready,
      collect_info: { collection_mode: 'preview', target_progress: { status: 'target_reached' } },
    }).eq('id', BASE_ID);
    const result = await GET(request('preview'), { params: Promise.resolve({ id: BASE_ID }) });
    expect(result.status).toBe(200);
    expect((await result.text()).split('\r\n')).toHaveLength(1001);
    await mockPortalDb.from('ve_bases').update({ status: 'collecting' }).eq('id', BASE_ID);
    expect((await GET(request('preview'), { params: Promise.resolve({ id: BASE_ID }) })).status).toBe(409);
  });

  it('exports only the fresh audited, unblocked audience with its segment assignment', async () => {
    const response = await GET(request('launch-ready', true), {
      params: Promise.resolve({ id: BASE_ID }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('contacts-launch-ready.csv');

    const csv = await response.text();
    expect(csv.split('\r\n')).toEqual([
      'company;email;_ve_segment',
      'Alpha;alpha@example.com;Enterprise',
    ]);
    expect(csv).not.toContain('status@example.com');
    expect(csv).not.toContain('unchecked@example.com');
    expect(csv).not.toContain('low@example.com');
    expect(csv).not.toContain('ALPHA@example.com');
    expect(csv).not.toContain('beta@example.com');
    expect(csv).not.toContain('not-an-email');
  });

  it('requires the exact template, audit and preset context for launch-ready export', async () => {
    const response = await GET(request('launch-ready'), {
      params: Promise.resolve({ id: BASE_ID }),
    });

    expect(response.status).toBe(400);
  });

  it.each(['stale', 'incomplete'] as const)(
    'fails closed when the stored segmentation audit is %s',
    async (state) => {
      mockAuditValidation = { state, reason: 'test' };

      const response = await GET(request('launch-ready', true), {
        params: Promise.resolve({ id: BASE_ID }),
      });

      expect(response.status).toBe(409);
    },
  );

  it('fails closed while the selected template is not ready', async () => {
    seed({ templateStatus: 'generating' });

    const response = await GET(request('launch-ready', true), {
      params: Promise.resolve({ id: BASE_ID }),
    });

    expect(response.status).toBe(409);
  });

  it('fails closed when the client blocklist cannot be read', async () => {
    seed({ blocklistError: 'blocklist unavailable' });

    const response = await GET(request('launch-ready', true), {
      params: Promise.resolve({ id: BASE_ID }),
    });

    expect(response.status).toBe(500);
  });

  it('does not export a header-only file when every audited contact is blocked', async () => {
    seed({ blockedEmails: ['alpha@example.com', 'beta@example.com'] });

    const response = await GET(request('launch-ready', true), {
      params: Promise.resolve({ id: BASE_ID }),
    });

    expect(response.status).toBe(409);
  });

  it('keeps both explicit and legacy raw modes unfiltered', async () => {
    const explicit = await GET(request('raw'), { params: Promise.resolve({ id: BASE_ID }) });
    const legacy = await GET(request(), { params: Promise.resolve({ id: BASE_ID }) });

    expect(explicit.status).toBe(200);
    expect(legacy.status).toBe(200);
    expect(explicit.headers.get('content-disposition')).toContain('contacts-raw.csv');
    expect(legacy.headers.get('content-disposition')).toContain('contacts.csv');
    const csv = await explicit.text();
    expect(csv).toBe(await legacy.text());

    expect(csv.split('\r\n')).toHaveLength(ROWS.length + 1);
    expect(csv).toContain('status@example.com');
    expect(csv).toContain('unchecked@example.com');
    expect(csv).toContain('low@example.com');
    expect(csv).toContain('ALPHA@example.com');
    expect(csv).toContain('not-an-email');
  });
});
