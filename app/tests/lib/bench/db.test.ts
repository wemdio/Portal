/** @jest-environment node */

const createAuthedSupabaseClient = jest.fn((token: string) => ({ marker: 'authed', token }));

jest.mock('@/lib/supabaseRouteClient', () => ({
  createAuthedSupabaseClient: (token: string) => createAuthedSupabaseClient(token),
}));

import { createBenchDb } from '@/lib/bench/db';

const ROBOT_ID = '00000000-0000-4000-8000-0000000000aa';

describe('bench db', () => {
  const previous = process.env.SUPABASE_JWT_SECRET;
  beforeAll(() => {
    process.env.SUPABASE_JWT_SECRET = 'test-secret';
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = previous;
  });
  beforeEach(() => createAuthedSupabaseClient.mockClear());

  it('строит клиент по токену робота, а не сервисным ключом', () => {
    createBenchDb(ROBOT_ID);
    const [token] = createAuthedSupabaseClient.mock.calls[0];
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    expect(payload.sub).toBe(ROBOT_ID);
  });

  it('разным роботам выдаёт разные токены', () => {
    createBenchDb(ROBOT_ID);
    createBenchDb('00000000-0000-4000-8000-0000000000bb');
    const [first] = createAuthedSupabaseClient.mock.calls[0];
    const [second] = createAuthedSupabaseClient.mock.calls[1];
    expect(first).not.toBe(second);
  });
});
