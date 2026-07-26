/** @jest-environment node */

import { createBoardToken, verifyBoardToken, boardUrl } from '@/lib/leadBoard/boardToken';

const SECRET = 'test-secret-123';
const PID = '11111111-2222-3333-4444-555555555555';

describe('boardToken', () => {
  it('sign → verify возвращает projectId', () => {
    const token = createBoardToken(PID, SECRET);
    expect(token.startsWith('lb_')).toBe(true);
    expect(verifyBoardToken(token, SECRET)).toBe(PID);
  });

  it('два токена одного проекта различны (nonce) и оба валидны', () => {
    const a = createBoardToken(PID, SECRET);
    const b = createBoardToken(PID, SECRET);
    expect(a).not.toBe(b);
    expect(verifyBoardToken(a, SECRET)).toBe(PID);
    expect(verifyBoardToken(b, SECRET)).toBe(PID);
  });

  it('подмена подписи → null', () => {
    const token = createBoardToken(PID, SECRET);
    const [payload] = token.slice(3).split('.');
    expect(verifyBoardToken(`lb_${payload}.forgedsignature`, SECRET)).toBeNull();
  });

  it('подмена projectId в payload → null (подпись не сойдётся)', () => {
    const token = createBoardToken(PID, SECRET);
    const sig = token.slice(3).split('.')[1];
    const forgedPayload = Buffer.from(
      JSON.stringify({ pid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', nonce: 'x' }),
    ).toString('base64url');
    expect(verifyBoardToken(`lb_${forgedPayload}.${sig}`, SECRET)).toBeNull();
  });

  it('чужой секрет → null', () => {
    const token = createBoardToken(PID, SECRET);
    expect(verifyBoardToken(token, 'other-secret')).toBeNull();
  });

  it('мусор/пусто/без префикса/без точки → null', () => {
    expect(verifyBoardToken('', SECRET)).toBeNull();
    expect(verifyBoardToken('garbage', SECRET)).toBeNull();
    expect(verifyBoardToken('lb_', SECRET)).toBeNull();
    expect(verifyBoardToken('lb_nodot', SECRET)).toBeNull();
    expect(verifyBoardToken('lb_payload.', SECRET)).toBeNull();
    // валидная подпись, но битый JSON в payload
    const badPayload = Buffer.from('not json').toString('base64url');
    const { createHmac } = jest.requireActual('crypto') as typeof import('crypto');
    const sig = createHmac('sha256', SECRET).update(badPayload).digest('base64url');
    expect(verifyBoardToken(`lb_${badPayload}.${sig}`, SECRET)).toBeNull();
  });

  it('boardUrl собирает ссылку из PORTAL_PUBLIC_URL без двойного слэша', () => {
    process.env.PORTAL_PUBLIC_URL = 'https://app.outreachos.pro/';
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(boardUrl('lb_abc.sig')).toBe('https://app.outreachos.pro/leads-board/lb_abc.sig');
    delete process.env.PORTAL_PUBLIC_URL;
  });
});
