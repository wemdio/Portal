import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

const DADATA_API_KEY = process.env.DADATA_API_KEY ?? '';
const DADATA_FIND_URL = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party';
const DADATA_SUGGEST_URL = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/party';

type EnrichRow = { rowIndex: number; query: string };

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

interface DadataAddress {
  value?: string;
  unrestricted_value?: string;
  data?: {
    city?: string;
    region?: string;
    postal_code?: string;
    [key: string]: unknown;
  };
}

interface DadataSuggestion {
  value: string;
  data: {
    inn?: string;
    kpp?: string;
    ogrn?: string;
    okato?: string;
    oktmo?: string;
    okpo?: string;
    okved?: string;
    type?: string;
    branch_count?: number;
    name?: { full_with_opf?: string; short_with_opf?: string; full?: string; short?: string };
    opf?: { short?: string; full?: string };
    management?: { name?: string; post?: string };
    state?: { status?: string; registration_date?: number; liquidation_date?: number };
    address?: DadataAddress;
    okveds?: Array<{ main?: boolean; code?: string; name?: string }>;
    employee_count?: number;
    finance?: {
      tax_system?: string;
      income?: number;
      expense?: number;
      revenue?: number;
      debt?: number;
      penalty?: number;
      year?: number;
    };
    capital?: { value?: number; type?: string };
    phones?: Array<{ value?: string }>;
    emails?: Array<{ value?: string }>;
  };
}

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Действующая',
  LIQUIDATING: 'Ликвидируется',
  LIQUIDATED: 'Ликвидирована',
  BANKRUPT: 'Банкротство',
  REORGANIZING: 'Реорганизация',
};

const TYPE_LABELS: Record<string, string> = {
  LEGAL: 'Юридическое лицо',
  INDIVIDUAL: 'ИП',
};

function extractFields(s: DadataSuggestion): Record<string, string | number | null> {
  const d = s.data;
  return {
    full_name: d.name?.full_with_opf ?? s.value ?? '',
    short_name: d.name?.short_with_opf ?? '',
    inn: d.inn ?? '',
    kpp: d.kpp ?? '',
    ogrn: d.ogrn ?? '',
    address: d.address?.unrestricted_value ?? d.address?.value ?? '',
    city: d.address?.data?.city ?? '',
    region: d.address?.data?.region ?? '',
    postal_code: d.address?.data?.postal_code ?? '',
    manager_name: d.management?.name ?? '',
    manager_post: d.management?.post ?? '',
    status: STATUS_LABELS[d.state?.status ?? ''] ?? d.state?.status ?? '',
    okved: d.okved ?? '',
    okved_name: d.okveds?.find((o) => o.main)?.name ?? '',
    opf: d.opf?.short ?? '',
    org_type: TYPE_LABELS[d.type ?? ''] ?? d.type ?? '',
    registration_date: d.state?.registration_date
      ? new Date(d.state.registration_date).toLocaleDateString('ru-RU')
      : '',
    branch_count: d.branch_count ?? 0,
    tax_system: d.finance?.tax_system ?? '',
    employee_count: d.employee_count ?? null,
    revenue: d.finance?.revenue ?? null,
    income: d.finance?.income ?? null,
    expense: d.finance?.expense ?? null,
    capital_value: d.capital?.value ?? null,
    finance_year: d.finance?.year ?? null,
    phones: d.phones?.map((p) => p.value).filter(Boolean).join(', ') ?? '',
    emails: d.emails?.map((e) => e.value).filter(Boolean).join(', ') ?? '',
  };
}

async function callDadata(url: string, query: string): Promise<DadataSuggestion | null> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Token ${DADATA_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      count: 1,
      ...(url === DADATA_FIND_URL ? { branch_type: 'MAIN' } : {}),
    }),
  });

  if (!res.ok) throw new Error(`DaData HTTP ${res.status}`);

  const json = (await res.json()) as { suggestions?: DadataSuggestion[] };
  return json.suggestions?.[0] ?? null;
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  if (!DADATA_API_KEY) return jsonError('DaData API key not configured', 500);

  let body: { rows?: EnrichRow[]; mode?: 'inn' | 'name' };
  try {
    body = (await req.json()) as { rows?: EnrichRow[]; mode?: 'inn' | 'name' };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const rows = body.rows ?? [];
  const mode = body.mode ?? 'inn';

  if (!Array.isArray(rows) || rows.length === 0) {
    return jsonError('No rows provided', 400);
  }
  if (rows.length > 50) {
    return jsonError('Too many rows per batch (max 50)', 400);
  }

  const dadataUrl = mode === 'inn' ? DADATA_FIND_URL : DADATA_SUGGEST_URL;

  const results: Array<{
    rowIndex: number;
    found: boolean;
    data: Record<string, string | number | null> | null;
    error?: string;
  }> = [];

  for (const row of rows) {
    const query = String(row.query ?? '').trim();
    if (!query) {
      results.push({ rowIndex: row.rowIndex, found: false, data: null, error: 'Пустой запрос' });
      continue;
    }

    try {
      const suggestion = await callDadata(dadataUrl, query);

      if (!suggestion) {
        results.push({ rowIndex: row.rowIndex, found: false, data: null });
        continue;
      }

      if (mode === 'name' && suggestion.data.inn) {
        try {
          const detailed = await callDadata(DADATA_FIND_URL, suggestion.data.inn);
          if (detailed) {
            results.push({ rowIndex: row.rowIndex, found: true, data: extractFields(detailed) });
            continue;
          }
        } catch {
          // fall through to use suggest data
        }
      }

      results.push({ rowIndex: row.rowIndex, found: true, data: extractFields(suggestion) });
    } catch (err) {
      results.push({
        rowIndex: row.rowIndex,
        found: false,
        data: null,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  return NextResponse.json({ results });
}
