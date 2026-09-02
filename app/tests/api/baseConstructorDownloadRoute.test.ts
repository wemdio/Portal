/**
 * @jest-environment node
 *
 * Locks the GET /api/tools/base-constructor/[id]/download contract (Fix B,
 * commit 751fba065 — precomputed .csv.gz artifact).
 *
 * Three behaviours the incident fix depends on:
 *  1. Fast path — a job with export_path set streams either legacy
 *     `${id}.csv.gz` or a strictly validated `${id}/${runToken}.csv.gz` path.
 *     Arbitrary client-writable paths cannot become a cross-tenant read. Gzip
 *     clients get Content-Encoding:gzip without pulling the ~50MB `data` jsonb.
 *  2. Legacy fallback — a completed job without an artifact streams the CSV built
 *     from `data` (byte-identical to rowsToCsvFile) AND lazily backfills the
 *     artifact (uploadExportArtifact + update export_path), guarded so only a
 *     'completed' row is written.
 *  3. Recovery export — in-flight/failed/cancelled jobs may still download the
 *     processed prefix, but private checkpoint metadata is stripped first and
 *     the partial result is never cached as a completed artifact.
 *
 * Plus: auth (401 no token / 403 wrong owner / 404 missing) precedes any body
 * work, and the meta SELECT never asks for `data`.
 *
 * Mocking follows the route-test pattern (fnsRevenueRoute.test.ts): mock
 * @/lib/supabaseAdmin — auth.getUser, from().select()/update(), and
 * storage.from().download()/upload(). rowsToCsv + csvExportArtifact run for
 * real so the byte-identity and backfill assertions are meaningful.
 */

import type { NextRequest } from 'next/server';
import { gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { rowsToCsvFile } from '@/lib/tools/rowsToCsv';
import { buildCsvGzip, EXPORT_BUCKET } from '@/lib/tools/csvExportArtifact';
import {
  EMAIL_VALIDATION_CHECKPOINT_STATE_COL,
  ENRICH_CHECKPOINT_ATTEMPTED_COL,
} from '@/lib/tools/baseConstructorCheckpoint';

const JOB_ID = 'job-abc';
const OWNER = 'owner-1';

const ROWS: unknown[][] = [
  ['компания', 'Сайт', 'email'],
  ['ООО "Ромашка"', 'r.ru', 'a@r.ru, b@r.ru'],
  ['line\nbreak', '', ''],
];
const CHECKPOINT_ROWS: unknown[][] = [
  [
    'компания',
    'Сайт',
    ENRICH_CHECKPOINT_ATTEMPTED_COL,
    EMAIL_VALIDATION_CHECKPOINT_STATE_COL,
  ],
  ['Alpha', 'alpha.example', '1', '{"a@alpha.example":{"attempts":1}}'],
  ['Beta', 'beta.example', '', ''],
];
const CLEAN_CHECKPOINT_ROWS: unknown[][] = [
  ['компания', 'Сайт'],
  ['Alpha', 'alpha.example'],
  ['Beta', 'beta.example'],
];

/* ── supabaseAdmin mock ──────────────────────────────────────────────────── */

const mockGetUser = jest.fn();
const mockJobSelect = jest.fn(); // (cols) => select builder
const mockJobUpdate = jest.fn(); // (patch) => update builder (spy)
const mockUpdateEq = jest.fn(); // (col, val) => update builder (spy)
const mockStorageDownload = jest.fn(); // (bucket, path) => { data, error }
const mockStorageUpload = jest.fn(); // (bucket, path, body, opts) => { error }

jest.mock('@/lib/supabaseAdmin', () => {
  // `.update(...).eq('id',id).eq('status','completed')` is awaited directly.
  const updateBuilder = {
    eq: (...args: unknown[]) => {
      mockUpdateEq(...args);
      return updateBuilder;
    },
    then: (onF: (v: { error: null }) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve({ error: null as null }).then(onF, onR),
  };
  const jobsTable = {
    select: (...args: unknown[]) => mockJobSelect(...args),
    update: (...args: unknown[]) => {
      mockJobUpdate(...args);
      return updateBuilder;
    },
  };
  // Permissive stub for any other table (e.g. tracer's trace_spans) — dead in
  // practice (the plain req has no nextUrl, so startToolTrace disables the span
  // in its own try/catch before ever hitting the DB), kept defensive.
  const noop: Record<string, unknown> = {};
  for (const m of ['insert', 'update', 'select', 'eq']) noop[m] = () => noop;
  noop.single = async () => ({ data: null, error: null });
  noop.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve({ data: null, error: null }).then(onF, onR);

  return {
    supabaseAdmin: {
      auth: { getUser: (...args: unknown[]) => mockGetUser(...args) },
      from: (table: string) => (table === 'base_constructor_jobs' ? jobsTable : noop),
      storage: {
        from: (bucket: string) => ({
          download: (...args: unknown[]) => mockStorageDownload(bucket, ...args),
          upload: (...args: unknown[]) => mockStorageUpload(bucket, ...args),
        }),
      },
    },
  };
});

/* ── helpers ─────────────────────────────────────────────────────────────── */

type Resolved = { data: unknown; error: unknown };

/** Chainable select builder: `.eq(...).single()` resolves to the given value. */
function selectBuilder(resolved: Resolved) {
  const b = {
    eq: () => b,
    single: async () => resolved,
  };
  return b;
}

/** Minimal stand-in for a supabase-storage Blob returning gzip bytes. */
function gzBlob(gz: Buffer) {
  return {
    stream: () => Readable.toWeb(Readable.from([gz])),
    arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength),
  };
}

/** Header bag with a `.get` — avoids undici stripping the forbidden
 *  `accept-encoding` request header from a real Request. */
function makeReq(opts: { auth?: string | null; acceptGzip?: boolean } = {}): NextRequest {
  const { auth = 'Bearer tok', acceptGzip = true } = opts;
  const bag: Record<string, string> = {};
  if (auth) bag['authorization'] = auth;
  if (acceptGzip) bag['accept-encoding'] = 'gzip, deflate, br';
  return {
    method: 'GET',
    headers: { get: (name: string): string | null => bag[name.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

function arrange(opts: {
  authUser?: { id: string } | null;
  meta?: unknown;
  metaErr?: unknown;
  rows?: unknown[][];
}) {
  const { authUser = { id: OWNER }, meta = null, metaErr = null, rows = [] } = opts;
  mockGetUser.mockResolvedValue({ data: { user: authUser } });
  mockJobSelect.mockImplementation((cols: string) =>
    cols === 'data'
      ? selectBuilder({ data: { data: rows }, error: null })
      : selectBuilder({ data: meta, error: metaErr }),
  );
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function waitFor(cond: () => boolean, tries = 50) {
  for (let i = 0; i < tries && !cond(); i++) await tick();
}
async function bodyBytes(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}
const params = { params: Promise.resolve({ id: JOB_ID }) };

let GET: (req: NextRequest, ctx: typeof params) => Promise<Response>;

beforeAll(async () => {
  ({ GET } = await import('@/app/api/tools/base-constructor/[id]/download/route'));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: null } });
  mockStorageDownload.mockResolvedValue({ data: null, error: { message: 'default: no object' } });
  mockStorageUpload.mockResolvedValue({ error: null });
  mockJobSelect.mockImplementation(() => selectBuilder({ data: null, error: null }));
});

/* ── auth precedes any body work ─────────────────────────────────────────── */

describe('auth precedes any body work', () => {
  it('401 without a bearer token — no auth lookup, no db, no storage', async () => {
    const res = await GET(makeReq({ auth: null }), params);
    expect(res.status).toBe(401);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockJobSelect).not.toHaveBeenCalled();
    expect(mockStorageDownload).not.toHaveBeenCalled();
    expect(mockStorageUpload).not.toHaveBeenCalled();
  });

  it('403 when the caller does not own the job — before any storage/data work', async () => {
    arrange({
      authUser: { id: 'intruder' },
      meta: { user_id: OWNER, status: 'completed', export_path: `${JOB_ID}.csv.gz` },
    });
    const res = await GET(makeReq(), params);
    expect(res.status).toBe(403);
    // Only the meta lookup ran; no artifact download, no data-blob pull, no upload.
    expect(mockJobSelect).toHaveBeenCalledTimes(1);
    expect(mockJobSelect).toHaveBeenCalledWith('user_id, status, export_path');
    expect(mockStorageDownload).not.toHaveBeenCalled();
    expect(mockStorageUpload).not.toHaveBeenCalled();
  });

  it('404 when the job is missing — before any storage/data work', async () => {
    arrange({ authUser: { id: OWNER }, meta: null, metaErr: { message: 'no rows' } });
    const res = await GET(makeReq(), params);
    expect(res.status).toBe(404);
    expect(mockStorageDownload).not.toHaveBeenCalled();
    expect(mockStorageUpload).not.toHaveBeenCalled();
    // The meta SELECT never asks for `data` (the ~50MB blob).
    expect(mockJobSelect).toHaveBeenCalledWith('user_id, status, export_path');
    expect(mockJobSelect).not.toHaveBeenCalledWith('data');
  });
});

/* ── fast path: stored artifact ──────────────────────────────────────────── */

describe('fast path: stored artifact', () => {
  it('uses a validated token-scoped artifact path produced by the active worker', async () => {
    const runToken = '11111111-1111-4111-8111-111111111111';
    const tokenPath = `${JOB_ID}/${runToken}.csv.gz`;
    const gz = await buildCsvGzip(ROWS);
    mockStorageDownload.mockResolvedValue({ data: gzBlob(gz), error: null });
    arrange({
      authUser: { id: OWNER },
      meta: { user_id: OWNER, status: 'completed', export_path: tokenPath },
    });

    const res = await GET(makeReq({ acceptGzip: true }), params);

    expect(res.status).toBe(200);
    expect(mockStorageDownload).toHaveBeenCalledWith(EXPORT_BUCKET, tokenPath);
    expect(mockJobSelect).toHaveBeenCalledTimes(1);
  });

  it('streams the DERIVED ${id}.csv.gz with content-encoding gzip and never pulls data', async () => {
    const gz = await buildCsvGzip(ROWS);
    mockStorageDownload.mockResolvedValue({ data: gzBlob(gz), error: null });
    // export_path is a truthy FLAG only; its value is attacker-controllable and
    // must be ignored in favour of the derived path.
    arrange({
      authUser: { id: OWNER },
      meta: { user_id: OWNER, status: 'completed', export_path: 'victim-tenant/secret.csv.gz' },
    });

    const res = await GET(makeReq({ acceptGzip: true }), params);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('vary')).toBe('Accept-Encoding');
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="constructor_\d{4}-\d{2}-\d{2}\.csv"$/,
    );

    // Path is DERIVED from the id, NOT taken from export_path.
    expect(mockStorageDownload).toHaveBeenCalledWith(EXPORT_BUCKET, `${JOB_ID}.csv.gz`);
    expect(mockStorageDownload).not.toHaveBeenCalledWith(EXPORT_BUCKET, 'victim-tenant/secret.csv.gz');
    // Meta-only select, exactly once — the ~50MB `data` blob is never touched.
    expect(mockJobSelect).toHaveBeenCalledTimes(1);
    expect(mockJobSelect).toHaveBeenCalledWith('user_id, status, export_path');
    // Fast path does not backfill.
    expect(mockStorageUpload).not.toHaveBeenCalled();

    // The artifact bytes are streamed through unmodified, and decompress to the
    // exact CSV the legacy path would have produced.
    const body = await bodyBytes(res);
    expect(body.equals(gz)).toBe(true);
    expect(gunzipSync(body).equals(Buffer.from(rowsToCsvFile(ROWS), 'utf8'))).toBe(true);
  });

  it('server-side gunzips for a non-gzip client (no content-encoding), still from the derived path', async () => {
    const gz = await buildCsvGzip(ROWS);
    mockStorageDownload.mockResolvedValue({ data: gzBlob(gz), error: null });
    arrange({
      authUser: { id: OWNER },
      meta: { user_id: OWNER, status: 'completed', export_path: 'flag' },
    });

    const res = await GET(makeReq({ acceptGzip: false }), params);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(mockStorageDownload).toHaveBeenCalledWith(EXPORT_BUCKET, `${JOB_ID}.csv.gz`);
    expect(mockJobSelect).toHaveBeenCalledTimes(1); // still no data-blob pull

    const body = await bodyBytes(res);
    expect(body.equals(Buffer.from(rowsToCsvFile(ROWS), 'utf8'))).toBe(true);
  });

  it('a broken artifact download self-heals to the legacy build (+ backfill)', async () => {
    mockStorageDownload.mockResolvedValue({ data: null, error: { message: 'object missing' } });
    arrange({
      authUser: { id: OWNER },
      meta: { user_id: OWNER, status: 'completed', export_path: `${JOB_ID}.csv.gz` },
      rows: ROWS,
    });

    const res = await GET(makeReq(), params);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBeNull(); // fell through to plain legacy stream
    expect(mockStorageDownload).toHaveBeenCalledWith(EXPORT_BUCKET, `${JOB_ID}.csv.gz`);
    expect(mockJobSelect).toHaveBeenCalledWith('data'); // legacy pulled the blob

    const body = await bodyBytes(res);
    expect(body.equals(Buffer.from(rowsToCsvFile(ROWS), 'utf8'))).toBe(true);

    // Completed → the missing object is re-uploaded so the next download is fast.
    await waitFor(() => mockJobUpdate.mock.calls.length > 0);
    expect(mockStorageUpload).toHaveBeenCalledWith(
      EXPORT_BUCKET,
      `${JOB_ID}.csv.gz`,
      expect.any(Buffer),
      { contentType: 'application/gzip', upsert: true },
    );
  });
});

/* ── legacy fallback + lazy backfill ─────────────────────────────────────── */

describe('legacy fallback + lazy backfill', () => {
  it('completed job w/o artifact: byte-identical CSV, then backfills (upload + guarded update)', async () => {
    arrange({
      authUser: { id: OWNER },
      meta: { user_id: OWNER, status: 'completed', export_path: null },
      rows: ROWS,
    });

    const res = await GET(makeReq(), params);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="constructor_\d{4}-\d{2}-\d{2}\.csv"$/,
    );

    // export_path null → the fast path is skipped, no artifact download attempted.
    expect(mockStorageDownload).not.toHaveBeenCalled();
    // Meta first, then the `data` blob.
    expect(mockJobSelect.mock.calls[0][0]).toBe('user_id, status, export_path');
    expect(mockJobSelect).toHaveBeenCalledWith('data');

    const body = await bodyBytes(res);
    expect(body.equals(Buffer.from(rowsToCsvFile(ROWS), 'utf8'))).toBe(true);

    // Fire-and-forget backfill: upload the derived artifact, then persist the
    // path via update guarded on .eq('status','completed').
    await waitFor(() => mockJobUpdate.mock.calls.length > 0);
    expect(mockStorageUpload).toHaveBeenCalledWith(
      EXPORT_BUCKET,
      `${JOB_ID}.csv.gz`,
      expect.any(Buffer),
      { contentType: 'application/gzip', upsert: true },
    );
    expect(mockJobUpdate).toHaveBeenCalledWith({
      export_path: `${JOB_ID}.csv.gz`,
      export_bytes: expect.any(Number),
    });
    expect(mockUpdateEq).toHaveBeenCalledWith('id', JOB_ID);
    expect(mockUpdateEq).toHaveBeenCalledWith('status', 'completed');
  });
});

/* ── safe recovery export for partial data ──────────────────────────────── */

describe('safe recovery export for partial data', () => {
  it.each(['pending', 'processing', 'failed', 'cancelled'])(
    '%s job: strips checkpoint metadata without caching the partial result',
    async (status) => {
      arrange({
        authUser: { id: OWNER },
        meta: { user_id: OWNER, status, export_path: 'must-not-be-read.csv.gz' },
        rows: CHECKPOINT_ROWS,
      });

      const res = await GET(makeReq(), params);
      expect(res.status).toBe(200);
      const body = await bodyBytes(res);
      expect(body.equals(Buffer.from(rowsToCsvFile(CLEAN_CHECKPOINT_ROWS), 'utf8'))).toBe(true);

      // Partial rows are recoverable, but neither a stale artifact nor a new
      // backfill may bypass the sanitized data path.
      expect(mockStorageDownload).not.toHaveBeenCalled();
      expect(mockStorageUpload).not.toHaveBeenCalled();
      expect(mockJobUpdate).not.toHaveBeenCalled();
    },
  );
});
