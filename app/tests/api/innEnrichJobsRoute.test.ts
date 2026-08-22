/**
 * @jest-environment node
 *
 * POST/GET /api/tools/inn-enrich/jobs — создание прогона (файл в storage)
 * и история. Auth precedes any body work; 409 если уже есть pending/running.
 */

import type { NextRequest } from 'next/server';

const mockJobsFrom = jest.fn();
const mockJobsGetUser = jest.fn();
const mockStorageUpload = jest.fn();
const mockStorageRemove = jest.fn();

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    auth: { getUser: (...args: unknown[]) => mockJobsGetUser(...args) },
    from: (...args: unknown[]) => mockJobsFrom(...args),
    storage: {
      from: () => ({
        upload: (...args: unknown[]) => mockStorageUpload(...args),
        remove: (...args: unknown[]) => mockStorageRemove(...args),
      }),
    },
  },
}));

function thenable(resolved: { data: unknown; error: unknown }) {
  const b: Record<string, unknown> = {};
  const self = () => b;
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'insert', 'update']) b[m] = self;
  b.maybeSingle = async () => resolved;
  b.single = async () => resolved;
  b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve(resolved).then(onF, onR);
  return b;
}

function makeReq(opts: { auth?: string | null; form?: FormData } = {}): NextRequest {
  const { auth = 'Bearer tok', form } = opts;
  const bag: Record<string, string> = {};
  if (auth) bag['authorization'] = auth;
  return {
    method: form ? 'POST' : 'GET',
    headers: { get: (name: string): string | null => bag[name.toLowerCase()] ?? null },
    formData: async () => {
      if (!form) throw new Error('no form');
      return form;
    },
  } as unknown as NextRequest;
}

let GET: (req: NextRequest) => Promise<Response>;
let POST: (req: NextRequest) => Promise<Response>;

beforeAll(async () => {
  ({ GET, POST } = await import('@/app/api/tools/inn-enrich/jobs/route'));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockJobsGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
  mockStorageUpload.mockResolvedValue({ error: null });
  mockStorageRemove.mockResolvedValue({ error: null });
});

describe('auth', () => {
  it('401 GET without token — no db', async () => {
    const res = await GET(makeReq({ auth: null }));
    expect(res.status).toBe(401);
    expect(mockJobsGetUser).not.toHaveBeenCalled();
    expect(mockJobsFrom).not.toHaveBeenCalled();
  });

  it('401 POST without token — no upload', async () => {
    const res = await POST(makeReq({ auth: null, form: new FormData() }));
    expect(res.status).toBe(401);
    expect(mockStorageUpload).not.toHaveBeenCalled();
  });
});

describe('GET history', () => {
  it('returns jobs for the caller', async () => {
    mockJobsFrom.mockReturnValue(
      thenable({
        data: [{ id: 'j1', status: 'completed', file_name: 'a.xlsx' }],
        error: null,
      }),
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].id).toBe('j1');
  });
});

describe('POST create', () => {
  it('400 without a file', async () => {
    mockJobsFrom.mockReturnValue(thenable({ data: null, error: null }));
    const res = await POST(makeReq({ form: new FormData() }));
    expect(res.status).toBe(400);
    expect(mockStorageUpload).not.toHaveBeenCalled();
  });

  it('409 when a job is already running', async () => {
    mockJobsFrom.mockReturnValue(
      thenable({ data: { id: 'busy', status: 'running', file_name: 'old.xlsx' }, error: null }),
    );
    const form = new FormData();
    form.append('file', new File(['a,b'], 'a.csv', { type: 'text/csv' }));
    form.append('columnIndex', '0');
    const res = await POST(makeReq({ form }));
    expect(res.status).toBe(409);
    expect(mockStorageUpload).not.toHaveBeenCalled();
  });

  it('uploads source and inserts pending job', async () => {
    const created = { id: 'job-1', status: 'pending', file_name: 'inns.csv' };
    let calls = 0;
    mockJobsFrom.mockImplementation(() => {
      calls += 1;
      if (calls === 1) return thenable({ data: null, error: null }); // active check
      return thenable({ data: created, error: null }); // insert
    });
    const form = new FormData();
    form.append('file', new File(['ИНН\n7707083893'], 'inns.csv', { type: 'text/csv' }));
    form.append('columnIndex', '0');
    form.append('hasHeader', 'true');
    const res = await POST(makeReq({ form }));
    expect(res.status).toBe(201);
    expect(mockStorageUpload).toHaveBeenCalled();
    const path = mockStorageUpload.mock.calls[0][0] as string;
    expect(path).toMatch(/\/source\.csv$/);
    const body = await res.json();
    expect(body.job.status).toBe('pending');
  });
});
