/** @jest-environment node */

/**
 * Tests for /api/tools/hypothesis-engine/projects/[id]/cases.
 *
 *   POST   201 -> { case } — LLM-структуризация текста → he_cases (source 'upload').
 *   POST   400 -> { error } for missing/empty/whitespace text.
 *   POST   404 -> { error } when the project does not exist.
 *   POST   413 -> { error } when text exceeds the 20000-char cap.
 *   GET    200 -> { cases } — список кейсов проекта (лёгкая проекция).
 *   DELETE 200/404 — удаление по ?id= или body {id}, только внутри проекта.
 *
 * LLM (structureCaseText из lib/hypothesisEngine/caseBank) замокан.
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const USER_ID = '00000000-0000-4000-8000-000000000001';

let mockDb: MockSupabaseClient = createMockSupabase();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: jest.fn(async () => ({
    auth: { supabase: mockDb, userId: USER_ID, role: 'admin' },
  })),
}));

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (
    _o: unknown,
    h: (t: { end: () => Promise<void>; fail: () => Promise<void> }) => Promise<unknown>,
  ) => h({ end: async () => {}, fail: async () => {} }),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

jest.mock('@/lib/hypothesisEngine/caseBank', () => ({
  structureCaseText: jest.fn(),
}));

import { structureCaseText } from '@/lib/hypothesisEngine/caseBank';
import { DELETE, GET, POST } from '@/app/api/tools/hypothesis-engine/projects/[id]/cases/route';

const structureMock = structureCaseText as jest.Mock;

const STRUCTURED = {
  industry: 'Ритейл',
  client_type: 'сеть кофеен, 40 точек',
  task: 'закрыть 120 позиций бариста на новые точки',
  metrics: { 'закрыто_позиций': 120, 'срок': '2 месяца' },
  result: 'закрыли 120 позиций за 2 месяца, все точки открылись в срок',
  text: 'Сеть кофеен из 40 точек открывала новые локации. Подобрали 120 бариста за 2 месяца. Все точки открылись в срок.',
};

const PROJECT_ID = 'p1';

function seedProject() {
  mockDb = createMockSupabase({
    tables: {
      he_projects: [{ id: PROJECT_ID, name: 'P', website_url: 'https://x.example/', status: 'researched' }],
      he_cases: [],
    },
  });
}

function makeReq(method: string, body?: unknown, query = ''): NextRequest {
  return new Request(`http://x/api/tools/hypothesis-engine/projects/${PROJECT_ID}/cases${query}`, {
    method,
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }) as unknown as NextRequest;
}

const params = { params: Promise.resolve({ id: PROJECT_ID }) };

beforeEach(() => {
  structureMock.mockReset();
  structureMock.mockResolvedValue(STRUCTURED);
});

describe('POST cases — validation', () => {
  beforeEach(seedProject);

  it('returns 400 when text is missing, empty or whitespace-only', async () => {
    for (const body of [{}, { text: '' }, { text: '   \n ' }, { text: 42 }]) {
      const res = await POST(makeReq('POST', body), params);
      expect(res.status).toBe(400);
    }
    expect(mockDb.getRows('he_cases')).toHaveLength(0);
    expect(structureMock).not.toHaveBeenCalled();
  });

  it('returns 413 when text exceeds the 20000-char cap', async () => {
    const res = await POST(makeReq('POST', { text: 'x'.repeat(20001) }), params);
    expect(res.status).toBe(413);
    expect(mockDb.getRows('he_cases')).toHaveLength(0);
    expect(structureMock).not.toHaveBeenCalled();
  });

  it('accepts text exactly at the 20000-char cap', async () => {
    const res = await POST(makeReq('POST', { text: 'x'.repeat(20000) }), params);
    expect(res.status).toBe(201);
  });

  it('returns 404 when the project does not exist', async () => {
    const res = await POST(makeReq('POST', { text: 'кейс' }), { params: Promise.resolve({ id: 'unknown' }) });
    expect(res.status).toBe(404);
  });
});

describe('POST cases — happy path', () => {
  beforeEach(seedProject);

  it('structures the pasted text via LLM and stores he_cases row with source=upload', async () => {
    const res = await POST(
      makeReq('POST', { text: 'Кейс про сеть кофеен: закрыли 120 позиций…', filename: 'case-coffee.pdf' }),
      params,
    );
    expect(res.status).toBe(201);

    const body = (await res.json()) as { case: { id: string; source: string; filename: string | null } };
    expect(body.case.id).toBeTruthy();
    expect(body.case.source).toBe('upload');
    expect(body.case.filename).toBe('case-coffee.pdf');

    expect(structureMock).toHaveBeenCalledTimes(1);

    const rows = mockDb.getRows('he_cases');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        project_id: PROJECT_ID,
        source: 'upload',
        filename: 'case-coffee.pdf',
        industry: STRUCTURED.industry,
        client_type: STRUCTURED.client_type,
        task: STRUCTURED.task,
        metrics: STRUCTURED.metrics,
        result: STRUCTURED.result,
        text: STRUCTURED.text,
      }),
    );
  });

  it('filename is optional → null', async () => {
    const res = await POST(makeReq('POST', { text: 'кейс без имени файла' }), params);
    expect(res.status).toBe(201);
    expect(mockDb.getRows('he_cases')[0].filename).toBeNull();
  });

  it('returns 502 when LLM structuring fails', async () => {
    structureMock.mockRejectedValue(new Error('LLM вернул невалидный JSON дважды'));
    const res = await POST(makeReq('POST', { text: 'битый кейс' }), params);
    expect(res.status).toBe(502);
    expect(mockDb.getRows('he_cases')).toHaveLength(0);
  });
});

describe('GET cases — список кейсов проекта', () => {
  it('returns project cases with the light projection', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_cases: [
          { id: 'c1', project_id: PROJECT_ID, source: 'site', filename: null, industry: 'HR', client_type: 'агентство', result: 'ok', text: 'long', metrics: { a: 1 }, created_at: '2026-01-01' },
          { id: 'c2', project_id: 'other', source: 'upload', filename: 'x.pdf', industry: 'IT', client_type: '', result: '', text: 'long', metrics: {}, created_at: '2026-01-02' },
        ],
      },
    });

    const res = await GET(makeReq('GET'), params);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cases: Array<{ id: string }> };
    expect(body.cases.map((c) => c.id)).toEqual(['c1']);
    // Лёгкая проекция — без text/metrics.
    const select = mockDb.selects.find((s) => s.table === 'he_cases');
    expect(select?.columns).toBe('id, source, filename, industry, client_type, result, created_at');
  });
});

describe('DELETE cases — удаление кейса', () => {
  beforeEach(() => {
    mockDb = createMockSupabase({
      tables: {
        he_cases: [
          { id: 'c1', project_id: PROJECT_ID, source: 'upload', created_at: '2026-01-01' },
          { id: 'c2', project_id: 'other', source: 'site', created_at: '2026-01-02' },
        ],
      },
    });
  });

  it('deletes by ?id= query param', async () => {
    const res = await DELETE(makeReq('DELETE', undefined, '?id=c1'), params);
    expect(res.status).toBe(200);
    expect(mockDb.getRows('he_cases').map((r) => r.id)).toEqual(['c2']);
  });

  it('deletes by body {id} (any source — owner project)', async () => {
    const res = await DELETE(makeReq('DELETE', { id: 'c1' }), params);
    expect(res.status).toBe(200);
    expect(mockDb.getRows('he_cases')).toHaveLength(1);
  });

  it('returns 404 for a case from another project', async () => {
    const res = await DELETE(makeReq('DELETE', undefined, '?id=c2'), params);
    expect(res.status).toBe(404);
    expect(mockDb.getRows('he_cases')).toHaveLength(2);
  });

  it('returns 400 when id is missing', async () => {
    const res = await DELETE(makeReq('DELETE'), params);
    expect(res.status).toBe(400);
  });
});
