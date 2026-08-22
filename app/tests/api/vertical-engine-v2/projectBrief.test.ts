/** @jest-environment node */

/**
 * Бриф клиента на входе проекта: загрузка файла, чтение и ручная правка полей.
 *
 * Бриф — ДОПОЛНЕНИЕ к сайту, а не замена: website_url проекта остаётся
 * авторитетным адресом, даже когда в строке брифа проза («сайт в разработке»).
 * И загрузка не имеет права затирать уже собранный site_profile — обе части
 * живут рядом в ve_projects.brief.
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const USER_ID = '00000000-0000-4000-8000-000000000221';

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

jest.mock('@/lib/emailSequenceV2/briefExtractor', () => ({
  extractTextFromBriefFile: jest.fn(async (file: File) => ({
    text: `ОПИСАНИЕ КОМПАНИИ\nСсылка на действующий сайт: в разработке\n(${file.name})`,
    companyHint: null,
  })),
}));

jest.mock('@/lib/verticalEngineV2/llm', () => ({
  callLLMWithSchema: jest.fn(async () => ({
    data: {
      fields: {
        company_website: 'в разработке: прототип лендинга',
        company_description: 'Консалтинг по ВЭД',
        deal_cycle: 'от 3 до 6 недель',
        special_offer: '-',
      },
    },
    tokensUsed: 100,
    costUsd: 0.001,
    promptTokens: 90,
    completionTokens: 10,
  })),
  getVeModel: jest.fn(() => 'test-research-model'),
}));

import { GET, POST, PUT } from '@/app/api/tools/vertical-engine-v2/projects/[id]/brief/route';

const params = { params: Promise.resolve({ id: 'p1' }) };

function seed(brief: Record<string, unknown> | null = null) {
  mockDb = createMockSupabase({
    tables: {
      ve_projects: [
        {
          id: 'p1',
          created_by: USER_ID,
          name: 'АМБ',
          website_url: 'https://amb.example/',
          status: 'draft',
          brief,
        },
      ],
      he_projects: [{ id: 'legacy-1', name: 'ENG project' }],
    },
  });
}

function uploadRequest(fileName: string): NextRequest {
  const form = new FormData();
  form.append('file', new File(['бриф'], fileName, { type: 'application/octet-stream' }));
  return new Request('http://x/api/tools/vertical-engine-v2/projects/p1/brief', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
    body: form,
  }) as unknown as NextRequest;
}

function jsonRequest(method: 'GET' | 'PUT', body?: unknown): NextRequest {
  return new Request('http://x/api/tools/vertical-engine-v2/projects/p1/brief', {
    method,
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as NextRequest;
}

function storedBrief(): Record<string, unknown> {
  return (mockDb.getRows('ve_projects')[0].brief ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  mockAuthorized = true;
  jest.clearAllMocks();
});

describe('POST /api/tools/vertical-engine-v2/projects/[id]/brief', () => {
  it('parses the uploaded brief and keeps the site profile and project url intact', async () => {
    seed({ site_profile: { company_name: 'АМБ' }, site_thin: true });

    const res = await POST(uploadRequest('amb.docx'), params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      ok: boolean;
      brief: { fields: Record<string, string>; missing: string[]; file_name: string };
    };
    expect(body.ok).toBe(true);
    expect(body.brief.file_name).toBe('amb.docx');
    expect(body.brief.fields.deal_cycle).toBe('от 3 до 6 недель');
    expect(body.brief.missing).toContain('special_offer');

    const brief = storedBrief();
    expect(brief.site_profile).toEqual({ company_name: 'АМБ' });
    expect(brief.site_thin).toBe(true);
    expect((brief.client_brief as { file_name: string }).file_name).toBe('amb.docx');

    // Проза в строке сайта не трогает адрес проекта.
    expect(mockDb.getRows('ve_projects')[0].website_url).toBe('https://amb.example/');
    expect(mockDb.mutations.every((m) => m.table.startsWith('ve_'))).toBe(true);
  });

  it('rejects formats the extractor cannot read', async () => {
    seed();
    const res = await POST(uploadRequest('brief.doc'), params);
    expect(res.status).toBe(400);
    expect(storedBrief().client_brief).toBeUndefined();
  });

  it('answers 404 for a project of another specialist', async () => {
    mockDb = createMockSupabase({ tables: { ve_projects: [] } });
    const res = await POST(uploadRequest('amb.docx'), params);
    expect(res.status).toBe(404);
  });
});

describe('GET/PUT /api/tools/vertical-engine-v2/projects/[id]/brief', () => {
  it('returns the stored brief with compiled text for prompts', async () => {
    seed({
      client_brief: {
        fields: { ...{ company_description: 'Консалтинг по ВЭД' } },
        missing: ['usp'],
        file_name: 'amb.docx',
        uploaded_at: '2026-08-22T10:00:00.000Z',
      },
    });

    const res = await GET(jsonRequest('GET'), params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      brief: { fields: Record<string, string>; file_name: string } | null;
      compiled_brief_text: string;
    };
    expect(body.brief?.file_name).toBe('amb.docx');
    expect(body.compiled_brief_text).toContain('Консалтинг по ВЭД');
  });

  it('answers null for a project without a brief', async () => {
    seed({ site_profile: { company_name: 'АМБ' } });
    const res = await GET(jsonRequest('GET'), params);
    const body = (await res.json()) as { brief: unknown };
    expect(body.brief).toBeNull();
  });

  it('applies a manual edit over the parsed fields and recomputes gaps', async () => {
    seed({
      client_brief: {
        fields: { company_description: 'Консалтинг по ВЭД' },
        missing: ['usp', 'avg_check'],
        file_name: 'amb.docx',
        uploaded_at: '2026-08-22T10:00:00.000Z',
      },
    });

    const res = await PUT(jsonRequest('PUT', { fields: { usp: 'Белый ВЭД под крупный бизнес' } }), params);
    expect(res.status).toBe(200);

    const stored = storedBrief().client_brief as {
      fields: Record<string, string>;
      missing: string[];
      file_name: string;
    };
    expect(stored.fields.usp).toBe('Белый ВЭД под крупный бизнес');
    expect(stored.fields.company_description).toBe('Консалтинг по ВЭД');
    expect(stored.missing).not.toContain('usp');
    expect(stored.missing).toContain('avg_check');
    expect(stored.file_name).toBe('amb.docx');
  });

  it('rejects a body without fields', async () => {
    seed({ client_brief: { fields: {}, missing: [], file_name: null, uploaded_at: 'x' } });
    const res = await PUT(jsonRequest('PUT', {}), params);
    expect(res.status).toBe(400);
  });
});
