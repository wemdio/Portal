/** @jest-environment node */

/**
 * Regression: the leads import must skip people THIS USER has already contacted
 * (invited/already_invited/messaged/connected/replied) so re-importing the same
 * audience doesn't silently produce 0 new outreach (LinkedIn returns
 * already_invited and no invite goes out). See prod 2026-05: a "new" list
 * ("ии-рекрутинг") turned out to be 100% the same people as an older list, so
 * every invite came back already_invited.
 *
 * Also: exact duplicates within the uploaded file are dropped.
 */

const AUTH_USER_ID = 'user-A';

// Rows the mock "DB" already has (contacted earlier by this user).
const existingContacted = [
  { user_id: AUTH_USER_ID, public_identifier: 'alice-pid', linkedin_id: null, status: 'invited' },
  { user_id: AUTH_USER_ID, public_identifier: 'carol-pid', linkedin_id: 'carol-lid', status: 'messaged' },
];

const insertedBatches: Array<Array<Record<string, unknown>>> = [];

function makeBuilder(table: string) {
  const eqs: Array<[string, unknown]> = [];
  const ins: Array<[string, unknown[]]> = [];
  let selectCols = '';
  const builder: Record<string, unknown> = {
    select: (cols: string) => { selectCols = cols; return builder; },
    eq: (c: string, v: unknown) => { eqs.push([c, v]); return builder; },
    in: (c: string, v: unknown[]) => { ins.push([c, v]); return builder; },
    insert: (rows: Array<Record<string, unknown>>) => {
      if (table === 'li_leads') insertedBatches.push(rows);
      return Promise.resolve({ error: null });
    },
    then: (resolve: (v: unknown) => void) => {
      // Only the contacted-lookup SELECT reaches here.
      let rows = existingContacted.filter((r) => r.status); // copy-ish
      for (const [c, v] of eqs) rows = rows.filter((r) => (r as Record<string, unknown>)[c] === v);
      for (const [c, vals] of ins) rows = rows.filter((r) => vals.includes((r as Record<string, unknown>)[c]));
      const projected = rows.map((r) => {
        const o: Record<string, unknown> = {};
        for (const col of selectCols.split(',').map((s) => s.trim())) o[col] = (r as Record<string, unknown>)[col];
        return o;
      });
      resolve({ data: projected, error: null });
    },
  };
  return builder;
}

const supabaseMock = { from: (t: string) => makeBuilder(t) };

jest.mock('@/lib/liOutreach/apiHelpers', () => {
  const { NextResponse } = jest.requireActual('next/server');
  return {
    jsonError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
    authenticateRequest: jest.fn(async () => ({ user: { id: AUTH_USER_ID }, supabase: supabaseMock })),
  };
});

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (_o: unknown, h: (t: { end: () => Promise<void>; fail: () => Promise<void> }) => Promise<unknown>) =>
    h({ end: async () => {}, fail: async () => {} }),
}));

import { POST } from '@/app/api/tools/li-outreach/leads/import/route';

function makeImportReq(csv: string, dedup?: string): Request {
  const fd = new FormData();
  fd.append('file', new File([csv], 'leads.csv', { type: 'text/csv' }));
  fd.append('lead_list_id', 'list-1');
  if (dedup !== undefined) fd.append('dedup', dedup);
  return new Request('http://x/api/tools/li-outreach/leads/import', {
    method: 'POST',
    headers: { authorization: 'Bearer t' },
    body: fd,
  });
}

beforeEach(() => { insertedBatches.length = 0; });

const CSV = [
  'name,public_identifier',
  'Alice,alice-pid', // already contacted (invited) -> skip
  'Bob,bob-pid', // new -> import
  'Carol,carol-pid', // already contacted (messaged) -> skip
  'Bob,bob-pid', // exact dup within file -> skip as dup
  'Dave,dave-pid', // new -> import
].join('\n');

describe('leads import — dedup against already-contacted + in-file dups', () => {
  it('skips already-contacted people and in-file duplicates, imports only the new', async () => {
    const res = await POST(makeImportReq(CSV) as never);
    const body = await (res as Response).json();

    expect(body.imported).toBe(2); // Bob + Dave
    expect(body.already_contacted_skipped).toBe(2); // Alice + Carol
    expect(body.dup_in_file_skipped).toBe(1); // second Bob

    // Only Bob + Dave actually inserted.
    const inserted = insertedBatches.flat().map((r) => r.public_identifier).sort();
    expect(inserted).toEqual(['bob-pid', 'dave-pid']);
  });

  it('dedup=false imports everyone (still drops in-file dups)', async () => {
    const res = await POST(makeImportReq(CSV, 'false') as never);
    const body = await (res as Response).json();

    expect(body.already_contacted_skipped).toBe(0);
    expect(body.imported).toBe(4); // Alice, Bob, Carol, Dave (one Bob dropped as in-file dup)
    expect(body.dup_in_file_skipped).toBe(1);
  });
});
