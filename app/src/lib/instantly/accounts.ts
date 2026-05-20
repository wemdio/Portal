import 'server-only';

import { InstantlyApiError } from './errors';

const DEFAULT_ACCOUNT_ID = 'main';
const DEFAULT_ACCOUNT_LABEL = 'Основной Instantly';

interface InstantlyAccountConfig {
  id: string;
  label: string;
  apiKey: string;
  isDefault: boolean;
}

export interface PublicInstantlyAccount {
  id: string;
  label: string;
  isDefault: boolean;
}

export interface InstantlyRequestOptions {
  accountId?: string | null;
}

type RawAccount = {
  id?: unknown;
  label?: unknown;
  name?: unknown;
  apiKey?: unknown;
  api_key?: unknown;
};

function normalizeAccountId(id: string): string {
  return id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
}

function mainApiKey(): string {
  return (process.env.INSTANTLY_API_KEY || process.env.INSTANTLY_PORTAL_API_KEY || '').trim();
}

function parseAdditionalAccounts(): InstantlyAccountConfig[] {
  const raw = (process.env.INSTANTLY_ACCOUNTS_JSON || '').trim();
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InstantlyApiError('INSTANTLY_ACCOUNTS_JSON is not valid JSON', 503);
  }

  if (!Array.isArray(parsed)) {
    throw new InstantlyApiError('INSTANTLY_ACCOUNTS_JSON must be an array', 503);
  }

  const accounts: InstantlyAccountConfig[] = [];
  for (const item of parsed as RawAccount[]) {
    if (!item || typeof item !== 'object') continue;
    const idRaw = typeof item.id === 'string' ? item.id : '';
    const id = normalizeAccountId(idRaw);
    const apiKey = typeof item.apiKey === 'string'
      ? item.apiKey.trim()
      : typeof item.api_key === 'string'
        ? item.api_key.trim()
        : '';
    if (!id || !apiKey || id === DEFAULT_ACCOUNT_ID) continue;

    const labelRaw = typeof item.label === 'string'
      ? item.label
      : typeof item.name === 'string'
        ? item.name
        : id;
    accounts.push({
      id,
      label: labelRaw.trim() || id,
      apiKey,
      isDefault: false,
    });
  }

  return accounts;
}

function allAccounts(): InstantlyAccountConfig[] {
  const accounts: InstantlyAccountConfig[] = [];
  const key = mainApiKey();
  if (key) {
    accounts.push({
      id: DEFAULT_ACCOUNT_ID,
      label: process.env.INSTANTLY_MAIN_ACCOUNT_LABEL?.trim() || DEFAULT_ACCOUNT_LABEL,
      apiKey: key,
      isDefault: true,
    });
  }

  const seen = new Set(accounts.map((a) => a.id));
  for (const account of parseAdditionalAccounts()) {
    if (seen.has(account.id)) continue;
    accounts.push(account);
    seen.add(account.id);
  }
  return accounts;
}

export function listInstantlyAccounts(): PublicInstantlyAccount[] {
  return allAccounts().map(({ id, label, isDefault }) => ({ id, label, isDefault }));
}

export function resolveInstantlyAccountId(accountId?: string | null): string {
  const normalized = normalizeAccountId(accountId || DEFAULT_ACCOUNT_ID);
  return normalized || DEFAULT_ACCOUNT_ID;
}

export function getInstantlyAccountApiKey(accountId?: string | null): string {
  const resolved = resolveInstantlyAccountId(accountId);
  const account = allAccounts().find((a) => a.id === resolved);
  if (!account?.apiKey) {
    throw new InstantlyApiError(`Instantly account "${resolved}" is not configured`, 503);
  }
  return account.apiKey;
}
