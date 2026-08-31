/** @jest-environment node */

import { createHmac } from 'node:crypto';
import { mintRobotToken, ROBOT_TOKEN_TTL_SECONDS } from '@/lib/bench/robotToken';

const ROBOT_ID = '00000000-0000-4000-8000-0000000000aa';

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

describe('robot token', () => {
  const previous = process.env.SUPABASE_JWT_SECRET;
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = 'test-secret';
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = previous;
  });

  it('кладёт робота в sub и роль authenticated', () => {
    const payload = decodePayload(mintRobotToken(ROBOT_ID, 1_000_000));
    expect(payload.sub).toBe(ROBOT_ID);
    expect(payload.role).toBe('authenticated');
    expect(payload.aud).toBe('authenticated');
  });

  it('живёт недолго', () => {
    const payload = decodePayload(mintRobotToken(ROBOT_ID, 1_000_000));
    expect(payload.exp).toBe(1_000_000 + ROBOT_TOKEN_TTL_SECONDS);
    expect(ROBOT_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(900);
  });

  it('подпись сходится с секретом', () => {
    const token = mintRobotToken(ROBOT_ID, 1_000_000);
    const [header, payload, signature] = token.split('.');
    const expected = createHmac('sha256', 'test-secret')
      .update(`${header}.${payload}`)
      .digest('base64url');
    expect(signature).toBe(expected);
  });

  it('чужой секрет даёт другую подпись', () => {
    const token = mintRobotToken(ROBOT_ID, 1_000_000);
    const [header, payload, signature] = token.split('.');
    const forged = createHmac('sha256', 'wrong-secret')
      .update(`${header}.${payload}`)
      .digest('base64url');
    expect(signature).not.toBe(forged);
  });

  it('без секрета не выпускает токен вовсе', () => {
    delete process.env.SUPABASE_JWT_SECRET;
    expect(() => mintRobotToken(ROBOT_ID, 1_000_000)).toThrow(/SUPABASE_JWT_SECRET/);
  });
});
