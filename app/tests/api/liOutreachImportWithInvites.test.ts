/** @jest-environment node */

/**
 * Regression: the "import CSV with invites" endpoint stores a per-lead
 * personalized invite_text, but the "LinkedIn ID" column is in practice the
 * profile URL. If we don't derive public_identifier from it, the runner can't
 * resolve the member and every invite fails "No provider_id and no
 * public_identifier" (prod 2026-06: "Surge Персонализация" imported 500 leads
 * with the URL in `name`, public_identifier empty → 0 invites sent).
 *
 * So: when the name is a LinkedIn URL and no explicit profile_url/public_id
 * column was given, extract public_identifier + set profile_url from it.
 */

const inserted = {
  leads: [] as Array<Record<string, unknown>>,
  lists: [] as Array<Record<string, unknown>>,
};

function resetState() {
  inserted.leads = [];
  inserted.lists = [];
}

function makeBuilder(table: string) {
  let mode: 'select' | 'insert' = 'select';
  let payload: unknown = null;
  const builder: Record<string, unknown> = {
    select: () => builder,
    insert: (d: unknown) => { mode = 'insert'; payload = d; return builder; },
    single: async () => {
      if (mode === 'insert' && table === 'li_lead_lists') {
        inserted.lists.push(payload as Record<string, unknown>);
        return { data: { id: 'list-1', name: (payload as Record<string, unknown>).name, has_custom_invites: true }, error: null };
      }
      return { data: null, error: { message: 'not found' } };
    },
    then: (resolve: (v: unknown) => void) => {
      if (mode === 'insert' && table === 'li_leads') {
        const rows = Array.isArray(payload) ? payload : [payload];
        inserted.leads.push(...(rows as Array<Record<string, unknown>>));
      }
      resolve({ data: null, error: null });
    },
  };
  return builder;
}

jest.mock('@/lib/liOutreach/apiHelpers', () => {
  const { NextResponse } = jest.requireActual('next/server');
  return {
    jsonError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
    authenticateRequest: jest.fn(async () => ({ user: { id: 'user-1' }, supabase: { from: (t: string) => makeBuilder(t) } })),
  };
});

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (_o: unknown, h: (t: { end: () => Promise<void>; fail: () => Promise<void> }) => Promise<unknown>) =>
    h({ end: async () => {}, fail: async () => {} }),
}));

import { POST } from '@/app/api/tools/li-outreach/leads/import-with-invites/route';

function makeReq(csv: string): Request {
  const fd = new FormData();
  fd.append('file', new File([csv], 'surge.csv', { type: 'text/csv' }));
  fd.append('list_name', 'Surge Персонализация');
  return new Request('http://x/api/tools/li-outreach/leads/import-with-invites', {
    method: 'POST',
    headers: { authorization: 'Bearer t' },
    body: fd,
  });
}

beforeEach(resetState);

describe('import-with-invites — derive public_identifier from URL in the LinkedIn ID column', () => {
  it('extracts public_identifier + profile_url when the name is a LinkedIn URL', async () => {
    const csv = [
      'LinkedIn ID,Invite',
      'http://www.linkedin.com/in/john-doe-123,Hello John! Great work at Acme.',
      'http://www.linkedin.com/in/jane-smith,Hi Jane!',
    ].join('\n');

    const res = await POST(makeReq(csv) as never);
    const body = await (res as Response).json();
    expect(body.imported).toBe(2);

    const byPid = Object.fromEntries(inserted.leads.map((l) => [l.public_identifier, l]));
    expect(Object.keys(byPid).sort()).toEqual(['jane-smith', 'john-doe-123']);

    const john = byPid['john-doe-123'];
    expect(john.profile_url).toBe('http://www.linkedin.com/in/john-doe-123');
    expect(john.public_identifier).toBe('john-doe-123');
    expect(john.invite_text).toBe('Hello John! Great work at Acme.');
    expect(john.name).toBe('http://www.linkedin.com/in/john-doe-123');
  });

  it('leaves public_identifier null when the name is not a URL (plain name)', async () => {
    const csv = [
      'LinkedIn ID,Invite',
      'John Doe,Hello John!',
    ].join('\n');

    const res = await POST(makeReq(csv) as never);
    const body = await (res as Response).json();
    expect(body.imported).toBe(1);
    expect(inserted.leads[0].public_identifier).toBeNull();
    expect(inserted.leads[0].invite_text).toBe('Hello John!');
  });

  it('prefers an explicit profile_url/public_identifier column over the name URL', async () => {
    const csv = [
      'LinkedIn ID,Invite,public_identifier',
      'http://www.linkedin.com/in/url-slug,Hi there,explicit-slug',
    ].join('\n');

    const res = await POST(makeReq(csv) as never);
    await (res as Response).json();
    expect(inserted.leads[0].public_identifier).toBe('explicit-slug');
  });
});
