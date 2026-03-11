function getDadataApiKey() { return process.env.DADATA_API_KEY ?? ''; }
const DADATA_FIND_URL = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party';
const DADATA_SUGGEST_URL = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/party';

export interface DadataSuggestion {
  value: string;
  data: {
    inn?: string;
    kpp?: string;
    ogrn?: string;
    type?: string;
    name?: { full_with_opf?: string; short_with_opf?: string };
    management?: { name?: string; post?: string };
    state?: { status?: string };
    address?: { value?: string; unrestricted_value?: string; data?: { city?: string; region?: string } };
    [key: string]: unknown;
  };
}

export function hasDadataKey(): boolean {
  return getDadataApiKey().length > 0;
}

export async function findByInn(inn: string): Promise<DadataSuggestion | null> {
  return callDadata(DADATA_FIND_URL, { query: inn, branch_type: 'MAIN' });
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
): Promise<DadataSuggestion | null> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Token ${getDadataApiKey()}`,
    },
    body: JSON.stringify({ count: 1, ...body }),
  });
  if (!res.ok) throw new Error(`DaData HTTP ${res.status}`);
  const json = (await res.json()) as { suggestions?: DadataSuggestion[] };
  return json.suggestions?.[0] ?? null;
}
