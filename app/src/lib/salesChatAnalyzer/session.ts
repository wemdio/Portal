import 'server-only';

import { encryptJsonAes256Gcm, decryptJsonAes256Gcm } from '@/lib/cryptoGcm';
import { getSalesChatCipherKey } from './config';

/** Шифрует строку StringSession для хранения в БД (AES-256-GCM). */
export function sealSession(sessionString: string): string {
  return encryptJsonAes256Gcm(sessionString, getSalesChatCipherKey());
}

/** Расшифровывает StringSession из БД. */
export function unsealSession(sealed: string): string {
  return decryptJsonAes256Gcm<string>(sealed, getSalesChatCipherKey());
}
