import 'server-only';

export interface EngTinyfishAccount { key: string; accountId: string }

const MAX_ACCOUNTS = 20;
const MAX_CONFIG_BYTES = 64 * 1024;

function account(value: unknown): EngTinyfishAccount | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { key, accountId } = value as Record<string, unknown>;
  if (typeof key !== 'string' || typeof accountId !== 'string') return null;
  const normalized = { key: key.trim(), accountId: accountId.trim() };
  return /^[\x21-\x7e]{1,512}$/.test(normalized.key)
    && /^[a-zA-Z0-9._-]{1,80}$/.test(normalized.accountId) ? normalized : null;
}

/** IDs represent real quota accounts, not API keys. Never log this result. */
export function parseEngTinyfishAccounts(env: Record<string, string | undefined>): EngTinyfishAccount[] | null {
  if (env.ENG_TINYFISH_ENABLED !== '1') return null;
  const primary = account({ key: env.TINYFISH_API_KEY, accountId: env.ENG_TINYFISH_ACCOUNT_ID });
  if (!primary) return null;
  const enabled = env.ENG_TINYFISH_POOL_ENABLED;
  if (enabled !== undefined && enabled !== '' && enabled !== '0' && enabled !== '1') return null;
  if (enabled !== '1') return [primary];

  const raw = env.ENG_TINYFISH_EXTRA_ACCOUNTS_JSON;
  if (!raw || Buffer.byteLength(raw) > MAX_CONFIG_BYTES) return null;
  try {
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values) || values.length < 1 || values.length >= MAX_ACCOUNTS) return null;
    const accounts = [primary];
    const ids = new Set([primary.accountId]);
    const keys = new Set([primary.key]);
    for (const value of values) {
      const next = account(value);
      if (!next || ids.has(next.accountId) || keys.has(next.key)) return null;
      ids.add(next.accountId); keys.add(next.key); accounts.push(next);
    }
    return accounts;
  } catch { return null; }
}

/** RU rescue has its own quota account; it never falls back to the ENG pool. */
export function parseRuTinyfishAccounts(env: Record<string, string | undefined>): EngTinyfishAccount[] | null {
  if (env.RU_TINYFISH_ENABLED !== '1') return null;
  const primary = account({ key: env.RU_TINYFISH_API_KEY, accountId: env.RU_TINYFISH_ACCOUNT_ID });
  if (!primary) return null;
  // Catch accidental reuse of the configured ENG identity or exact key. The
  // provider does not expose identity metadata; real account mapping is manual.
  const eng = account({ key: env.TINYFISH_API_KEY, accountId: env.ENG_TINYFISH_ACCOUNT_ID });
  if (eng && (eng.accountId === primary.accountId || eng.key === primary.key)) return null;
  const extras = env.ENG_TINYFISH_EXTRA_ACCOUNTS_JSON;
  if (extras) {
    if (Buffer.byteLength(extras) > MAX_CONFIG_BYTES) return null;
    try {
      const values: unknown = JSON.parse(extras);
      if (!Array.isArray(values)) return null;
      for (const value of values) {
        const other = account(value);
        if (!other || other.accountId === primary.accountId || other.key === primary.key) return null;
      }
    } catch { return null; }
  }
  return [primary];
}
