import { createDecipheriv, createCipheriv, randomBytes } from 'crypto';

function decodeKey(key: string): Buffer {
  const trimmed = (key ?? '').trim();
  if (!trimmed) throw new Error('Missing encryption key');
  const isHex = /^[0-9a-fA-F]{64}$/.test(trimmed);
  const buf = isHex ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64');
  if (buf.length !== 32) throw new Error('Invalid encryption key length');
  return buf;
}

export function encryptJsonAes256Gcm(value: unknown, key: string): string {
  const keyBuf = decodeKey(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuf, iv);
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

export function decryptJsonAes256Gcm<T>(sealed: string, key: string): T {
  const keyBuf = decodeKey(key);
  const parts = (sealed ?? '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Invalid sealed payload');
  const iv = Buffer.from(parts[1]!, 'base64');
  const tag = Buffer.from(parts[2]!, 'base64');
  const data = Buffer.from(parts[3]!, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8')) as T;
}

