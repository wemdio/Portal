import type { PdlPersonEnriched } from '@/types/lpr';
import { LPR_CONFIG } from './config';

const PDL_BASE_URL = 'https://api.peopledatalabs.com/v5';

export class PdlApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'PdlApiError';
  }
}

function getApiKey(): string {
  const key = LPR_CONFIG.PDL_API_KEY;
  if (!key) throw new PdlApiError('PDL_API_KEY is not configured', 503);
  return key;
}

interface PdlEnrichParams {
  name?: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  profile?: string;
}

interface PdlEnrichResponse {
  status: number;
  likelihood: number;
  data: {
    id: string;
    full_name: string | null;
    first_name: string | null;
    last_name: string | null;
    job_title: string | null;
    job_title_role: string | null;
    job_title_levels: string[] | null;
    job_company_name: string | null;
    job_company_website: string | null;
    linkedin_url: string | null;
    work_email: string | null;
    personal_emails: string[] | null;
    phone_numbers: string[] | null;
    location_name: string | null;
    [key: string]: unknown;
  };
}

export async function enrichPerson(params: PdlEnrichParams): Promise<PdlPersonEnriched | null> {
  const apiKey = getApiKey();

  const url = new URL(`${PDL_BASE_URL}/person/enrich`);

  if (params.name) url.searchParams.set('name', params.name);
  if (params.first_name) url.searchParams.set('first_name', params.first_name);
  if (params.last_name) url.searchParams.set('last_name', params.last_name);
  if (params.company) url.searchParams.set('company', params.company);
  if (params.profile) url.searchParams.set('profile', params.profile);

  url.searchParams.set('min_likelihood', String(LPR_CONFIG.PDL_MIN_LIKELIHOOD));
  url.searchParams.set('required', 'emails');
  url.searchParams.set('titlecase', 'true');
  url.searchParams.set('data_include', [
    'full_name', 'first_name', 'last_name',
    'job_title', 'job_title_role', 'job_title_levels',
    'job_company_name', 'job_company_website',
    'linkedin_url', 'work_email', 'personal_emails',
    'phone_numbers', 'location_name',
  ].join(','));

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'X-Api-Key': apiKey,
      'Accept': 'application/json',
    },
  });

  if (res.status === 404) return null;

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new PdlApiError(`PDL API ${res.status}: ${text.slice(0, 300)}`, res.status, text);
  }

  const json = (await res.json()) as PdlEnrichResponse;

  if (json.status !== 200 || !json.data) return null;

  return {
    pdl_id: json.data.id ?? '',
    full_name: json.data.full_name ?? '',
    first_name: json.data.first_name ?? null,
    last_name: json.data.last_name ?? null,
    job_title: json.data.job_title ?? null,
    job_title_role: json.data.job_title_role ?? null,
    job_title_levels: json.data.job_title_levels ?? null,
    job_company_name: json.data.job_company_name ?? null,
    job_company_website: json.data.job_company_website ?? null,
    linkedin_url: json.data.linkedin_url ?? null,
    work_email: json.data.work_email ?? null,
    personal_emails: json.data.personal_emails ?? [],
    phone_numbers: json.data.phone_numbers ?? [],
    location_name: json.data.location_name ?? null,
    likelihood: json.likelihood ?? 0,
  };
}

export function hasPdlKey(): boolean {
  return LPR_CONFIG.PDL_API_KEY.length > 0;
}
