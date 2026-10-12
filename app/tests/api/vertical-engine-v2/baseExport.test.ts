/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient, type MockSupabaseSeed } from '@/../tests/helpers/mockSupabase';
import { NextRequest, NextResponse } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { buildBaseCsv, csvField } from '@/lib/verticalEngineV2/baseCsv';

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
jest.mock('@/lib/instantly/client', () => ({
  getCampaign: jest.fn(() => { throw new Error('Export must not call Instantly'); }),
  getCampaignAnalyticsOverview: jest.fn(() => { throw new Error('Export must not call Instantly'); }),
}));

import { GET } from '@/app/api/tools/vertical-engine-v2/bases/[id]/export/route';
import { GET as GET_ALL_CONTACTS } from '@/app/api/tools/vertical-engine-v2/projects/[id]/contacts/export/route';

const EXPORT_PROJECT = '59d6a38a-8ab8-4aa7-b6bd-47d186dbd29e';
const EXPORT_HYPOTHESIS = 'af9aac80-4f61-4890-abee-d7c629d020c8';
const SAVED_AT = '2026-09-01T00:00:00.000Z';
const allContactsRequest = (hypothesisId = EXPORT_HYPOTHESIS) => new NextRequest(
  `http://portal.test/api/tools/vertical-engine-v2/projects/${EXPORT_PROJECT}/contacts/export?hypothesis_id=${hypothesisId}`,
  { headers: { authorization: 'Bearer test-token' } },
);
const allContactsContext = () => ({ params: Promise.resolve({ id: EXPORT_PROJECT }) });

function seedAllContacts(options: Partial<MockSupabaseSeed> = {}) {
  const base = (id: string, data: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
    id, project_id: EXPORT_PROJECT, hypothesis_id: EXPORT_HYPOTHESIS, source: 'auto', status: 'analyzed',
    columns: ['company', 'email', 'inn', 'website', '_private'], data, created_at: SAVED_AT, ...extra,
  });
  const delivery = (id: string, email: string, status = 'accepted') => ({
    id, item_id: 'item-old', ve_project_id: EXPORT_PROJECT, source_row_index: 0,
    supply_batch_id: null, email_normalized: email, created_at: SAVED_AT, status,
    lead_payload: { email, company_name: 'Saved company', custom_variables: { label: 'Saved label', _private: 'secret' } },
  });
  const ready = Array.from({ length: 1100 }, (_, i) => ({
    company: `Company ${i}`, email: `lead-${i}@example.com`, _email_status: 'ok',
    ...(i === 0 ? { inn: '7701234567' } : {}), _private: 'secret',
  }));
  mockPortalDb = createMockSupabase({
    enforceQueryWindows: true, maxRowsPerQuery: 200,
    tables: {
      ve_projects: [{ id: EXPORT_PROJECT, name: 'Аудит Профи' }],
      ve_hypotheses: [{ id: EXPORT_HYPOTHESIS, project_id: EXPORT_PROJECT, title: 'Производство' }],
      ve_project_exclusions: [{ project_id: EXPORT_PROJECT, revision: 1, inns: ['7701234567'], domains: ['blocked.ru'], emails: [] }],
      ve_bases: [
        base('base-first', [...ready, ...ROWS.slice(1, 4), { company: 'No verdict', email: 'unverified@example.com' }]),
        base('base-daily', [ready[1], { company: 'Fresh', email: 'fresh@new-company.ru', _email_status: 'ok' },
          { company: 'Blocked domain', email: 'hi@sub.blocked.ru', _email_status: 'ok' }], { status: 'collecting' }),
        base('base-old', [{ company: 'Latest saved', email: 'current@legacy.ru', _email_status: 'ok' }]),
        base('foreign-hypothesis', [{ email: 'other-hypothesis@example.com', _email_status: 'ok' }], { hypothesis_id: 'other' }),
        base('foreign-project', [{ email: 'other-project@example.com', _email_status: 'ok' }], { project_id: 'other' }),
        base('raw-upload', [{ email: 'not-verified-upload@example.com' }], { source: 'upload' }),
        base('future-base', [{ email: 'future@example.com', _email_status: 'ok' }], { created_at: '2099-01-01T00:00:00.000Z' }),
      ],
      ve_launch_queue_items: [{ id: 'item-old', project_id: EXPORT_PROJECT, hypothesis_id: EXPORT_HYPOTHESIS,
        base_id: 'base-old', status: 'released', created_at: SAVED_AT },
      { id: 'item-first', project_id: EXPORT_PROJECT, hypothesis_id: EXPORT_HYPOTHESIS,
        base_id: 'base-first', status: 'active', created_at: SAVED_AT }],
      ve_contact_delivery_rows: [delivery('accepted-old', 'uploaded@archive.ru'),
        delivery('uncertain-old', 'uncertain@archive.ru', 'uncertain'), delivery('skipped-old', 'skipped@archive.ru', 'skipped'),
        { ...delivery('excluded-old', 'lead-0@example.com'), item_id: 'item-first' },
        { ...delivery('foreign', 'foreign-delivery@example.com'), ve_project_id: 'other' }],
      ...options.tables,
    }, ...Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'tables')),
  });
}

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

  it('exports up to 500 checked contacts while collection continues and rejects unverified rows', async () => {
    const ready = Array.from({ length: 1100 }, (_, i) => ({ company: `Company ${i}`, email: `lead-${i}@example.com`, _email_status: 'ok' }));
    await mockPortalDb.from('ve_bases').update({
      status: 'analyzed', row_count: ready.length, data: ready,
      collect_info: { collection_mode: 'preview', target_progress: { status: 'target_reached' } },
    }).eq('id', BASE_ID);
    const result = await GET(request('preview'), { params: Promise.resolve({ id: BASE_ID }) });
    expect(result.status).toBe(200);
    expect((await result.text()).split('\r\n')).toHaveLength(501);
    const partial = [
      ROWS[0], ROWS[1], ROWS[2], ROWS[3], ROWS[4],
      { company: 'Catch all', email: 'catch@example.com', _email_status: 'catch_all' },
      { company: 'No verdict', email: 'pending@example.com' },
      { company: 'Unprepared name', email: 'name@example.com', _email_status: 'ok',
        _ve_company_name: { version: 1, status: 'failed', value: '', source_name: 'Unprepared name' } },
    ];
    for (const status of ['collecting', 'failed']) {
      await mockPortalDb.from('ve_bases').update({ status, data: partial, row_count: partial.length,
        collect_info: { collection_mode: 'preview', target_progress: { status: status === 'failed' ? 'error' : 'collecting' } },
      }).eq('id', BASE_ID);
      const response = await GET(request('preview'), { params: Promise.resolve({ id: BASE_ID }) });
      expect(response.status).toBe(200);
      expect((await response.text()).split('\r\n')).toEqual([
        'company;email', 'Alpha;alpha@example.com', 'Catch all;catch@example.com',
      ]);
    }
    await mockPortalDb.from('ve_bases').update({ status: 'collecting', data: [ROWS[1], ROWS[2]], row_count: 2 }).eq('id', BASE_ID);
    expect((await GET(request('preview'), { params: Promise.resolve({ id: BASE_ID }) })).status).toBe(409);
    await mockPortalDb.from('ve_bases').update({ data: [ROWS[0]], collect_info: { collection_mode: 'supply' } }).eq('id', BASE_ID);
    expect((await GET(request('preview'), { params: Promise.resolve({ id: BASE_ID }) })).status).toBe(409);

    // The standalone download does not need a template, preset or launch. It
    // includes every saved daily cohort and immutable history after a launch.
    seedAllContacts();
    const full = await GET_ALL_CONTACTS(allContactsRequest(), allContactsContext());
    expect(full.status).toBe(200);
    expect(full.headers.get('Cache-Control')).toBe('no-store');
    expect(full.headers.get('X-VE-Exported-Contacts')).toBe('1103');
    expect(full.headers.get('Content-Disposition')).toContain('all-verified-');
    const fullCsv = await full.text();
    expect(fullCsv.split('\r\n')).toHaveLength(1104);
    for (const email of ['lead-1099@example.com', 'fresh@new-company.ru', 'current@legacy.ru', 'uploaded@archive.ru', 'uncertain@archive.ru']) {
      expect(fullCsv).toContain(email);
    }
    for (const absent of ['lead-0@example.com', 'hi@sub.blocked.ru', 'unverified@example.com', 'unchecked@example.com',
      'status@example.com', 'low@example.com', 'other-hypothesis@example.com', 'other-project@example.com',
      'foreign-delivery@example.com', 'skipped@archive.ru', 'not-verified-upload@example.com', 'future@example.com', '_private', 'secret', '[object Object]']) {
      expect(fullCsv).not.toContain(absent);
    }
    expect(fullCsv.match(/lead-1@example\.com/g)).toHaveLength(1);
    expect(mockPortalDb.mutations).toHaveLength(0);
    expect(mockPortalDb.rpcCalls).toHaveLength(0);
    expect(mockPortalDb.selects.every(select => !select.columns.includes('collect_info'))).toBe(true);
    // A later download sees newly persisted supply, while uploaded contacts stay.
    await mockPortalDb.from('ve_bases').insert({ id: 'next-day', project_id: EXPORT_PROJECT, hypothesis_id: EXPORT_HYPOTHESIS,
      source: 'auto', status: 'failed', created_at: SAVED_AT, columns: ['company', 'email'],
      data: [{ company: 'Tomorrow', email: 'next-day@example.com', _email_status: 'ok' }] });
    const nextDay = await GET_ALL_CONTACTS(allContactsRequest(), allContactsContext());
    expect(nextDay.headers.get('X-VE-Exported-Contacts')).toBe('1104');
    expect(await nextDay.text()).toContain('next-day@example.com');
    await mockPortalDb.from('ve_project_exclusions').update({ revision: 2, domains: ['archive.ru', 'blocked.ru'] }).eq('project_id', EXPORT_PROJECT);
    const filtered = await GET_ALL_CONTACTS(allContactsRequest(), allContactsContext());
    expect(await filtered.text()).not.toContain('uploaded@archive.ru');
    await mockPortalDb.from('ve_project_exclusions').update({ revision: 3, inns: [], domains: [],
      emails: ['fresh@new-company.ru', 'uploaded@archive.ru', 'lead-1@example.com'],
    }).eq('project_id', EXPORT_PROJECT);
    const emailFiltered = await GET_ALL_CONTACTS(allContactsRequest(), allContactsContext());
    expect(emailFiltered.status).toBe(200);
    const emailCsv = await emailFiltered.text();
    for (const removed of ['fresh@new-company.ru', 'uploaded@archive.ru', 'lead-1@example.com']) expect(emailCsv).not.toContain(removed);
    for (const kept of ['uncertain@archive.ru', 'lead-2@example.com', 'next-day@example.com']) expect(emailCsv).toContain(kept);

    // Aliased source columns and immutable daily history preserve their cells,
    // while old vertical-wide bases contribute only the owned delivery rows.
    seedAllContacts();
    await mockPortalDb.from('ve_bases').insert({ id: 'base-alias', project_id: EXPORT_PROJECT, hypothesis_id: EXPORT_HYPOTHESIS,
      source: 'auto', created_at: SAVED_AT, columns: ['Организация', 'E-mail', 'ИНН', 'Сайт', '_ve_relevance'],
      data: [{ 'Организация': 'Фабрика', 'E-mail': 'ALIAS@FACTORY.RU', 'ИНН': '1234567890', 'Сайт': 'factory.ru', _email_status: 'ok' }] });
    await mockPortalDb.from('ve_bases').update({ hypothesis_id: null, data: [
      { company: 'Other legacy audience', email: 'not-owned@legacy.ru', _email_status: 'ok' },
    ] }).eq('id', 'base-old');
    await mockPortalDb.from('ve_contact_supply_batches').insert({ id: 'supply-batch', base_id: 'base-daily' });
    await mockPortalDb.from('ve_contact_delivery_rows').insert({ id: 'daily-history', item_id: 'item-first',
      ve_project_id: EXPORT_PROJECT, supply_batch_id: 'supply-batch', status: 'accepted', created_at: SAVED_AT,
      email_normalized: 'daily-history@archive.ru', lead_payload: { email: 'daily-history@archive.ru' } });
    const aliases = await GET_ALL_CONTACTS(allContactsRequest(), allContactsContext());
    expect(aliases.status).toBe(200);
    const aliasesCsv = await aliases.text();
    expect(aliasesCsv).toContain('alias@factory.ru');
    expect(aliasesCsv).toContain('Фабрика');
    expect(aliasesCsv).toContain('1234567890');
    expect(aliasesCsv).toContain('daily-history@archive.ru');
    expect(aliasesCsv).toContain('uploaded@archive.ru');
    expect(aliasesCsv).not.toContain('not-owned@legacy.ru');
    expect(aliasesCsv).not.toContain('_ve_relevance');
    await mockPortalDb.from('ve_contact_supply_batches').update({ base_id: 'foreign-project' }).eq('id', 'supply-batch');
    expect((await GET_ALL_CONTACTS(allContactsRequest(), allContactsContext())).status).toBe(503);

    // All pages, even when PostgREST returns fewer than the requested page size.
    seedAllContacts({ tables: { ve_bases: [{ id: 'base-old', project_id: EXPORT_PROJECT, hypothesis_id: EXPORT_HYPOTHESIS,
      source: 'auto', created_at: SAVED_AT, columns: ['email'], data: [] }],
    ve_contact_delivery_rows: Array.from({ length: 1003 }, (_, i) => ({
      id: `snapshot-${String(i).padStart(4, '0')}`, item_id: 'item-old', ve_project_id: EXPORT_PROJECT,
      status: 'accepted', email_normalized: `saved-${i}@archive.ru`, lead_payload: { email: `saved-${i}@archive.ru` },
      created_at: SAVED_AT,
    })) } });
    const allPages = await GET_ALL_CONTACTS(allContactsRequest(), allContactsContext());
    expect(allPages.headers.get('X-VE-Exported-Contacts')).toBe('1003');
    expect(await allPages.text()).toContain('saved-1002@archive.ru');

    for (const table of ['ve_project_exclusions', 've_bases', 've_launch_queue_items', 've_contact_delivery_rows']) {
      seedAllContacts({ errorTables: { [table]: 'private database error' } });
      const unavailable = await GET_ALL_CONTACTS(allContactsRequest(), allContactsContext());
      expect(unavailable.status).toBe(503);
      expect(await unavailable.text()).not.toContain('private database error');
    }
    seedAllContacts({ errorSelects: { ve_bases: { columnsInclude: 'columns,data', message: 'source payload lost' } } });
    expect((await GET_ALL_CONTACTS(allContactsRequest(), allContactsContext())).status).toBe(503);
    seedAllContacts();
    const readFrom = mockPortalDb.from.bind(mockPortalDb);
    let policyReads = 0;
    mockPortalDb.from = ((table: string) => {
      if (table === 've_project_exclusions' && ++policyReads === 2) {
        return createMockSupabase({ tables: { ve_project_exclusions: [
          { ...mockPortalDb.getRows('ve_project_exclusions')[0], revision: 2 },
        ] } }).from(table);
      }
      return readFrom(table);
    }) as typeof mockPortalDb.from;
    expect((await GET_ALL_CONTACTS(allContactsRequest(), allContactsContext())).status).toBe(503);
    seedAllContacts({ tables: { ve_bases: [], ve_contact_delivery_rows: [] } });
    expect((await GET_ALL_CONTACTS(allContactsRequest(), allContactsContext())).status).toBe(409);
    expect((await GET_ALL_CONTACTS(allContactsRequest('invalid'), allContactsContext())).status).toBe(400);
    seedAllContacts({ tables: { ve_hypotheses: [{ id: EXPORT_HYPOTHESIS, project_id: 'different-project' }] } });
    expect((await GET_ALL_CONTACTS(allContactsRequest(), allContactsContext())).status).toBe(404);
    jest.mocked(requireInternalToolAuth).mockResolvedValueOnce({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await GET_ALL_CONTACTS(allContactsRequest(), allContactsContext())).status).toBe(401);
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
    await mockPortalDb.from('ve_project_exclusions').insert({ project_id: 'project-export-1',
      revision: 1, inns: [], domains: ['example.com'], emails: [] });
    const excluded = await GET(request('launch-ready', true), { params: Promise.resolve({ id: BASE_ID }) });
    expect(excluded.status).toBe(409);
    const raw = await GET(request('raw'), { params: Promise.resolve({ id: BASE_ID }) });
    expect(await raw.text()).toContain('alpha@example.com');
    await mockPortalDb.from('ve_project_exclusions').update({ inns: ['1234567890'], domains: [] }).eq('project_id', 'project-export-1');
    const unknown = await GET(request('launch-ready', true), { params: Promise.resolve({ id: BASE_ID }) });
    expect(unknown.status).toBe(200);
    expect(unknown.headers.get('X-VE-Project-Unidentified')).toBe('1');
    expect(await unknown.text()).toContain('alpha@example.com');
    await mockPortalDb.from('ve_project_exclusions').update({ inns: [], emails: ['alpha@example.com'] }).eq('project_id', 'project-export-1');
    expect((await GET(request('launch-ready', true), { params: Promise.resolve({ id: BASE_ID }) })).status).toBe(409);
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
    for (const [input, output] of [
      ['=1+1', "'=1+1"],
      [' \t=1+1', "' \t=1+1"],
      ['\t+1', "'\t+1"],
      ['\r\n@SUM(A1)', '"\'\r\n@SUM(A1)"'],
      ['\u0000-1', "'\u0000-1"],
      ['\ufeff=1', "'\ufeff=1"],
      ['  Обычный текст', '  Обычный текст'],
      ['1234567890', '1234567890'],
    ]) expect(csvField(input)).toBe(output);
    expect(buildBaseCsv([' \t=1'], [{ ' \t=1': '\n+2' }])).toBe('\ufeff\' \t=1\r\n"\'\n+2"');
  });
});
