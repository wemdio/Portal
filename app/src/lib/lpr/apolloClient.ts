import type { ApolloPersonRaw, LprSeniority } from '@/types/lpr';
import { LPR_CONFIG } from './config';

const APOLLO_BASE_URL = 'https://api.apollo.io/api/v1';

export class ApolloApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'ApolloApiError';
  }
}

function getApiKey(): string {
  const key = LPR_CONFIG.APOLLO_API_KEY;
  if (!key) throw new ApolloApiError('APOLLO_API_KEY is not configured', 503);
  return key;
}

interface ApolloSearchParams {
  domains?: string[];
  seniorities?: LprSeniority[];
  titles?: string[];
  per_page?: number;
  page?: number;
}

interface ApolloPersonResponse {
  id: string;
  first_name: string;
  last_name_obfuscated: string;
  title: string | null;
  last_refreshed_at: string | null;
  has_email: boolean;
  has_direct_phone: string | null;
  organization?: {
    name: string | null;
    [key: string]: unknown;
  };
}

interface ApolloSearchResponse {
  total_entries: number;
  people: ApolloPersonResponse[];
}

export async function searchPeople(params: ApolloSearchParams): Promise<{
  total: number;
  people: ApolloPersonRaw[];
}> {
  const apiKey = getApiKey();

  const url = new URL(`${APOLLO_BASE_URL}/mixed_people/api_search`);

  if (params.domains?.length) {
    for (const d of params.domains) {
      url.searchParams.append('q_organization_domains_list[]', d);
    }
  }
  if (params.seniorities?.length) {
    for (const s of params.seniorities) {
      url.searchParams.append('person_seniorities[]', s);
    }
  }
  if (params.titles?.length) {
    for (const t of params.titles) {
      url.searchParams.append('person_titles[]', t);
    }
  }

  url.searchParams.set('per_page', String(params.per_page ?? 25));
  url.searchParams.set('page', String(params.page ?? 1));

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApolloApiError(`Apollo API ${res.status}: ${text.slice(0, 300)}`, res.status, text);
  }

  const data = (await res.json()) as ApolloSearchResponse;

  const people: ApolloPersonRaw[] = (data.people ?? []).map((p) => ({
    apollo_id: p.id,
    first_name: p.first_name ?? '',
    last_name_obfuscated: p.last_name_obfuscated ?? '',
    title: p.title ?? null,
    organization_name: p.organization?.name ?? null,
    last_refreshed_at: p.last_refreshed_at ?? null,
    has_email: p.has_email ?? false,
    has_direct_phone: p.has_direct_phone ?? null,
  }));

  return { total: data.total_entries ?? 0, people };
}

export function hasApolloKey(): boolean {
  return LPR_CONFIG.APOLLO_API_KEY.length > 0;
}
