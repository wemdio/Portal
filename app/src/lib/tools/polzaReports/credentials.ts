import 'server-only';

import { encryptJsonAes256Gcm, decryptJsonAes256Gcm } from '@/lib/cryptoGcm';
import type { ColdyCredentials } from './types';

const DEFAULT_COLDY_URL = 'https://app.coldy.ai';

function getCipherKey(): string {
  const key = (process.env.POLZA_CRED_KEY ?? '').trim();
  if (!key) {
    throw new Error(
      'POLZA_CRED_KEY is not configured — cannot seal/unseal Coldy credentials. ' +
        'Generate one with `openssl rand -base64 32` and add it to the portal env.',
    );
  }
  return key;
}

/** AES-256-GCM seal — returns the value to store in polza_coldy_credentials.sealed_credentials. */
export function sealColdyCredentials(creds: ColdyCredentials): string {
  const normalized: ColdyCredentials = {
    email: creds.email.trim(),
    password: creds.password,
    url: (creds.url || DEFAULT_COLDY_URL).trim().replace(/\/+$/, ''),
  };
  return encryptJsonAes256Gcm(normalized, getCipherKey());
}

/** Reverse of sealColdyCredentials. Throws on tampered / wrong-key payloads. */
export function unsealColdyCredentials(sealed: string): ColdyCredentials {
  const decoded = decryptJsonAes256Gcm<ColdyCredentials>(sealed, getCipherKey());
  return {
    email: String(decoded?.email ?? '').trim(),
    password: String(decoded?.password ?? ''),
    url: String(decoded?.url ?? DEFAULT_COLDY_URL).trim().replace(/\/+$/, '') || DEFAULT_COLDY_URL,
  };
}

/** Mask the email for UI display: `kuladmed@example.com` → `k****d@example.com`. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  if (local.length <= 2) return `${local[0] ?? ''}***@${domain}`;
  return `${local[0]}${'*'.repeat(Math.max(3, local.length - 2))}${local[local.length - 1]}@${domain}`;
}

export const COLDY_DEFAULT_URL = DEFAULT_COLDY_URL;
