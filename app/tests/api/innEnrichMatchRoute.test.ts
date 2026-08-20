/**
 * @jest-environment node
 *
 * Contract for POST /api/tools/inn-enrich/match — the server half of the
 * /tools/inn-enrich tool. The browser parses the uploaded spreadsheet and
 * sends unique INNs here in chunks; the route fans them out to the
 * inn_enrich_fetch RPC (≤ RPC_BATCH_SIZE per call) and returns the rows.
 *
 * Locked behaviours:
 *  1. Auth precedes any body work: no bearer token → 401 and the RPC is
 *     never invoked (same stance as the other /api/tools/* routes).
 *  2. Body validation: non-JSON, missing/empty `inns`, or more than
 *     MAX_INNS_PER_REQUEST unique valid INNs → 400, RPC never invoked.
 *  3. Values are normalized + deduped server-side (never trust the client):
 *     junk is dropped and counted, duplicates collapse before batching.
 *  4. Batching: N unique INNs → ceil(N / RPC_BATCH_SIZE) RPC calls with
 *     `p_inn_list` arrays; rows from all batches concatenate in order.
 *  5. An RPC failure aborts the whole request with 500 — partial enrichment
 *     would silently mislead the stats sheet.
 */

import type { NextRequest } from 'next/server';
import { MAX_INNS_PER_REQUEST, RPC_BATCH_SIZE } from '@/lib/innEnrich/inn';

const mockGetUser = jest.fn();
const mockRpc = jest.fn();

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    auth: { getUser: (...args: unknown[]) => mockGetUser(...args) },
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

function makeReq(opts: { auth?: string | null; body?: unknown; rawBody?: string } = {}): NextRequest {
  const { auth = 'Bearer tok', body, rawBody } = opts;
  const bag: Record<string, string> = {};
  if (auth) bag['authorization'] = auth;
  return {
    method: 'POST',
    headers: { get: (name: string): string | null => bag[name.toLowerCase()] ?? null },
    json: async () => {
      if (rawBody !== undefined) return JSON.parse(rawBody);
      return body;
    },
  } as unknown as NextRequest;
}

function rpcRows(inns: string[]): Array<Record<string, unknown>> {
  return inns.map((inn) => ({ inn, name: `Компания ${inn}` }));
}

let POST: (req: NextRequest) => Promise<Response>;

beforeAll(async () => {
  ({ POST } = await import('@/app/api/tools/inn-enrich/match/route'));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
  mockRpc.mockImplementation((_fn: string, args: { p_inn_list: string[] }) =>
    Promise.resolve({ data: rpcRows(args.p_inn_list), error: null }),
  );
});

/* ── auth ──────────────────────────────────────────────────────────────── */

describe('auth precedes any body work', () => {
  it('401 without a bearer token — RPC never invoked', async () => {
    const res = await POST(makeReq({ auth: null, body: { inns: ['7707083893'] } }));
    expect(res.status).toBe(401);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('401 when the token does not resolve to a user', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const res = await POST(makeReq({ body: { inns: ['7707083893'] } }));
    expect(res.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

/* ── validation ────────────────────────────────────────────────────────── */

describe('body validation', () => {
  it('400 on malformed JSON', async () => {
    const res = await POST(makeReq({ rawBody: '{nope' }));
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('400 when inns is not an array', async () => {
    const res = await POST(makeReq({ body: { inns: '7707083893' } }));
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('400 when nothing valid remains after normalization', async () => {
    const res = await POST(makeReq({ body: { inns: ['мусор', '123', ''] } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it(`400 when unique valid INNs exceed MAX_INNS_PER_REQUEST (${MAX_INNS_PER_REQUEST})`, async () => {
    const inns = Array.from({ length: MAX_INNS_PER_REQUEST + 1 }, (_, i) =>
      String(7700000000 + i).padStart(10, '0'),
    );
    const res = await POST(makeReq({ body: { inns } }));
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

/* ── normalization + dedupe before batching ────────────────────────────── */

describe('normalization and dedupe', () => {
  it('strips junk, dedupes, and reports counts', async () => {
    const res = await POST(
      makeReq({ body: { inns: [' 7707 083 893 ', '7707083893', 'junk', '771234567890'] } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requestedUnique).toBe(2);
    expect(body.invalidCount).toBe(1);
    // One RPC call (2 INNs < batch size) with the deduped, normalized list.
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('inn_enrich_fetch', {
      p_inn_list: ['7707083893', '771234567890'],
    });
  });
});

/* ── batching ──────────────────────────────────────────────────────────── */

describe('RPC batching', () => {
  it('splits into RPC_BATCH_SIZE chunks and concatenates rows in order', async () => {
    const total = RPC_BATCH_SIZE * 2 + 200; // 1200 → 500 + 500 + 200
    const inns = Array.from({ length: total }, (_, i) =>
      String(7700000000 + i).padStart(10, '0'),
    );
    const res = await POST(makeReq({ body: { inns } }));
    expect(res.status).toBe(200);

    expect(mockRpc).toHaveBeenCalledTimes(3);
    const batchSizes = mockRpc.mock.calls.map(
      (c) => (c[1] as { p_inn_list: string[] }).p_inn_list.length,
    );
    expect(batchSizes).toEqual([RPC_BATCH_SIZE, RPC_BATCH_SIZE, 200]);

    const body = await res.json();
    expect(body.rows).toHaveLength(total);
    expect(body.rows[0].inn).toBe(inns[0]);
    expect(body.rows[total - 1].inn).toBe(inns[total - 1]);
    expect(body.requestedUnique).toBe(total);
    expect(body.invalidCount).toBe(0);
  });

  it('500 with the RPC message when any batch fails', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: rpcRows(['x']), error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'statement timeout' } });
    const inns = Array.from({ length: RPC_BATCH_SIZE + 1 }, (_, i) =>
      String(7700000000 + i).padStart(10, '0'),
    );
    const res = await POST(makeReq({ body: { inns } }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('statement timeout');
  });
});
