/**
 * Подключения CRM для передачи лидов: наша AMO (Polza) и amoCRM клиентов.
 *
 * Наша AMO — встроенная, адресуется строкой `'polza'` и берёт адрес с токеном
 * из env сервера, как весь остальной портал. Клиентские лежат в
 * `crm_connections`, токен — зашифрованным (ключ `CRM_CRED_KEY`).
 *
 * Без `server-only`: модуль нужен и API-роутам, и воркеру tg-outreach.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptJsonAes256Gcm, encryptJsonAes256Gcm } from '@/lib/cryptoGcm';
import { createAmoClient, normalizeAmoBaseUrl, type AmoClient } from './amoClient';

export const POLZA_CONNECTION = 'polza';
export const POLZA_CONNECTION_NAME = 'Наша AMO (Polza)';

/** Поле «Источник» сделки нашей AMO и значение для TG-аутрича. */
export const POLZA_SOURCE_FIELD_ID = 1314379;
export const POLZA_SOURCE_TG_OUTREACH = 'Telegram Outreach';
export const POLZA_SOURCE_EMAIL_OUTREACH = 'Email Outreach';

export interface CrmConnectionPublic {
  id: string;
  name: string;
  base_url: string;
  status: 'ok' | 'error';
  last_verified_at: string | null;
  last_error: string | null;
  builtin: boolean;
}

/** Колонки, которые можно отдавать на экран, — без зашифрованного токена. */
export const CRM_CONNECTION_PUBLIC_COLUMNS = 'id, name, base_url, status, last_verified_at, last_error';

function cipherKey(): string {
  const key = (process.env.CRM_CRED_KEY ?? '').trim();
  if (!key) {
    throw new Error('CRM_CRED_KEY не задан на сервере — токены клиентских AMO не зашифровать. Сгенерировать: `openssl rand -hex 32`.');
  }
  return key;
}

export function sealCrmToken(token: string): string {
  return encryptJsonAes256Gcm({ token }, cipherKey());
}

export function unsealCrmToken(sealed: string): string {
  const decoded = decryptJsonAes256Gcm<{ token?: string }>(sealed, cipherKey());
  return String(decoded?.token ?? '');
}

/** Адрес нашей AMO из env: `AMO_BASE_URL` бывает и с протоколом, и без. */
export function polzaAmoBaseUrl(): string | null {
  const raw = (process.env.AMO_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  return raw.startsWith('http') ? raw : `https://${raw}`;
}

function polzaAmoToken(): string | null {
  return (process.env.AMO_ACCESS_TOKEN || process.env.AMOCRM_TOKEN || '').trim() || null;
}

export function polzaConnectionPublic(): CrmConnectionPublic {
  const baseUrl = polzaAmoBaseUrl();
  const configured = Boolean(baseUrl && polzaAmoToken());
  return {
    id: POLZA_CONNECTION,
    name: POLZA_CONNECTION_NAME,
    base_url: baseUrl ?? '',
    status: configured ? 'ok' : 'error',
    last_verified_at: null,
    last_error: configured ? null : 'На сервере не задан AMO_BASE_URL или AMO_ACCESS_TOKEN',
    builtin: true,
  };
}

export interface ResolvedCrm {
  client: AmoClient;
  isPolza: boolean;
}

/**
 * Клиент AMO по ссылке из настроек кампании. Бросает с понятной причиной,
 * если подключения нет или оно не настроено, — её увидит сотрудник.
 */
export async function resolveCrmConnection(db: SupabaseClient, connection: string): Promise<ResolvedCrm> {
  if (connection === POLZA_CONNECTION) {
    const baseUrl = polzaAmoBaseUrl();
    const token = polzaAmoToken();
    if (!baseUrl || !token) throw new Error('Наша AMO не настроена на сервере (AMO_BASE_URL / AMO_ACCESS_TOKEN)');
    return { client: createAmoClient({ baseUrl, token }), isPolza: true };
  }
  const { data, error } = await db
    .from('crm_connections')
    .select('base_url, secret_encrypted')
    .eq('id', connection)
    .maybeSingle();
  if (error) throw new Error(`не прочитать подключение CRM: ${error.message}`);
  if (!data) throw new Error('подключение CRM удалено — выберите другое в настройках кампании');
  const row = data as { base_url: string; secret_encrypted: string };
  const baseUrl = normalizeAmoBaseUrl(row.base_url);
  if (!baseUrl) throw new Error(`неверный адрес amoCRM: ${row.base_url}`);
  return { client: createAmoClient({ baseUrl, token: unsealCrmToken(row.secret_encrypted) }), isPolza: false };
}
