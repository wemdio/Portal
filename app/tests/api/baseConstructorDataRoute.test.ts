/** @jest-environment node */

import { NextRequest } from 'next/server';

const JOB_ID = 'job-data';
const OWNER = 'owner-1';
const mockGetUser = jest.fn();
const mockJobSelect = jest.fn();
const mockRpc = jest.fn();
const ROWS = [['Компания'], ['Alpha'], ['Beta']];

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (_meta: unknown, run: () => Promise<Response>) => run(),
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    auth: { getUser: (...args: unknown[]) => mockGetUser(...args) },
    from: (table: string) => {
      if (table !== 'base_constructor_jobs') throw new Error(`unexpected table ${table}`);
      return { select: (...args: unknown[]) => mockJobSelect(...args) };
    },
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

function selectBuilder(result: { data: unknown; error: unknown }) {
  const builder = {
    eq: () => builder,
    single: async () => result,
  };
  return builder;
}

function request(preview = false): NextRequest {
  return new NextRequest(
    `http://localhost/api/tools/base-constructor/${JOB_ID}/data${preview ? '?preview=21' : ''}`,
    { headers: { authorization: 'Bearer token' } },
  );
}

const params = { params: Promise.resolve({ id: JOB_ID }) };
let GET: (req: NextRequest, ctx: typeof params) => Promise<Response>;

beforeAll(async () => {
  ({ GET } = await import('@/app/api/tools/base-constructor/[id]/data/route'));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: OWNER } } });
  mockRpc.mockResolvedValue({ data: [['Компания'], ['Alpha']], error: null });
});

it.each(['pending', 'processing', 'failed', 'cancelled'])(
  'returns sanitized %s preview for recovery without exposing checkpoint metadata',
  async (status) => {
    mockJobSelect.mockImplementation(() => selectBuilder({
      data: { user_id: OWNER, status },
      error: null,
    }));
    mockRpc.mockResolvedValue({
      data: [['Компания', '__portal_enrich_attempted_v1'], ['Alpha', '1']],
      error: null,
    });

    const response = await GET(request(true), params);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: [['Компания'], ['Alpha']] });
    expect(mockJobSelect).toHaveBeenCalledTimes(1);
    expect(mockJobSelect).not.toHaveBeenCalledWith('data');
    expect(mockRpc).toHaveBeenCalled();
  },
);

it('returns sanitized processing full-data result for recovery', async () => {
  mockJobSelect.mockImplementation(() => selectBuilder({
    data: {
      user_id: OWNER,
      status: 'processing',
      data: [['Компания', '__portal_enrich_attempted_v1'], ['Alpha', '1']],
    },
    error: null,
  }));

  const response = await GET(request(false), params);

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ data: [['Компания'], ['Alpha']] });
  expect(mockJobSelect).toHaveBeenCalledTimes(1);
  expect(mockJobSelect).toHaveBeenCalledWith('user_id, data');
});

it('keeps completed preview available', async () => {
  mockJobSelect.mockImplementation(() => selectBuilder({
    data: { user_id: OWNER, status: 'completed' },
    error: null,
  }));

  const response = await GET(request(true), params);

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ data: [['Компания'], ['Alpha']] });
  expect(mockRpc).toHaveBeenCalledWith('base_constructor_job_data_slice', {
    p_id: JOB_ID,
    p_limit: 21,
  });
});

it('keeps completed full-data response available after the metadata guard', async () => {
  mockJobSelect.mockImplementation(() => selectBuilder({
    data: { user_id: OWNER, status: 'completed', data: ROWS },
    error: null,
  }));

  const response = await GET(request(false), params);

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ data: ROWS });
  expect(mockJobSelect).toHaveBeenCalledWith('user_id, data');
});
