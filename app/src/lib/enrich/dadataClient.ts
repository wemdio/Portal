function getDadataApiKey() { return process.env.DADATA_API_KEY ?? ''; }
const DADATA_FIND_URL = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party';
const DADATA_SUGGEST_URL = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/party';

export interface DadataFounder {
  inn?: string;
  ogrn?: string;
  name?: string;
  fio?: { surname?: string; name?: string; patronymic?: string };
  hid?: string;
  type?: 'LEGAL' | 'PHYSICAL';
  share?: { type?: string; value?: number; numerator?: number; denominator?: number };
}

export interface DadataManager {
  inn?: string;
  ogrn?: string;
  name?: string;
  fio?: { surname?: string; name?: string; patronymic?: string };
  post?: string;
  hid?: string;
  type?: 'EMPLOYEE' | 'FOREIGNER' | 'LEGAL';
}

export interface DadataSuggestion {
  value: string;
  data: {
    inn?: string;
    kpp?: string;
    ogrn?: string;
    type?: string;
    name?: { full_with_opf?: string; short_with_opf?: string };
    management?: { name?: string; post?: string };
    founders?: DadataFounder[];
    managers?: DadataManager[];
    state?: { status?: string };
    address?: { value?: string; unrestricted_value?: string; data?: { city?: string; region?: string } };
    phones?: Array<{ value?: string }>;
    emails?: Array<{ value?: string }>;
    [key: string]: unknown;
  };
}

export function hasDadataKey(): boolean {
  return getDadataApiKey().length > 0;
}

/**
 * options.signal — прерывание вызывающего (остановка воркера, потеря аренды).
 * У самого запроса таймаута нет вовсе, а undici не ставит его по умолчанию:
 * без сигнала зависший DaData держал бы задачу столько, сколько живёт сокет.
 * Параметр необязательный — вызовы без него ведут себя ровно как раньше.
 */
export async function findByInn(
  inn: string,
  options?: { signal?: AbortSignal },
): Promise<DadataSuggestion | null> {
  return callDadata(DADATA_FIND_URL, { query: inn, branch_type: 'MAIN' }, options);
}

export async function suggestByName(
  name: string,
  city?: string,
): Promise<DadataSuggestion | null> {
  const locations = city
    ? [{ city }]
    : undefined;
  return callDadata(DADATA_SUGGEST_URL, { query: name, count: 1, ...(locations ? { locations } : {}) });
}

async function callDadata(
  url: string,
  body: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<DadataSuggestion | null> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Token ${getDadataApiKey()}`,
    },
    body: JSON.stringify({ count: 1, ...body }),
    signal: options?.signal,
  });
  if (!res.ok) throw new Error(`DaData HTTP ${res.status}`);
  const json = (await res.json()) as { suggestions?: DadataSuggestion[] };
  return json.suggestions?.[0] ?? null;
}
