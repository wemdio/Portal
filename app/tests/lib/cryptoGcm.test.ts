/** @jest-environment node */

import { decryptJsonAes256Gcm, encryptJsonAes256Gcm } from '@/lib/cryptoGcm';

describe('cryptoGcm', () => {
  it('encrypts and decrypts json (roundtrip)', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const input = { username: 'u', password: 'p', host: '1.2.3.4' };
    const sealed = encryptJsonAes256Gcm(input, key);
    expect(typeof sealed).toBe('string');
    expect(sealed.startsWith('v1.')).toBe(true);
    const decoded = decryptJsonAes256Gcm<typeof input>(sealed, key);
    expect(decoded).toEqual(input);
  });

  it('fails with wrong key', () => {
    const keyA = Buffer.alloc(32, 1).toString('base64');
    const keyB = Buffer.alloc(32, 2).toString('base64');
    const sealed = encryptJsonAes256Gcm({ a: 1 }, keyA);
    expect(() => decryptJsonAes256Gcm(sealed, keyB)).toThrow();
  });

  it('fails when key is missing', () => {
    expect(() => encryptJsonAes256Gcm({ a: 1 }, '')).toThrow('Missing encryption key');
  });
});

