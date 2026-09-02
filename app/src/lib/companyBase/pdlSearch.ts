export type PdlCompanyCatalogRow = {
  id: string;
  name: string;
  website: string | null;
  industry: string | null;
  size: string | null;
  country: string | null;
  region?: string | null;
  locality: string | null;
  description?: string | null;
};

export type PdlCompanyFilters = {
  industries?: readonly string[];
  sizes?: readonly string[];
  countries?: readonly string[];
  name?: string | null;
};

export type PdlCompanyPageRequest = PdlCompanyFilters & {
  afterId?: string | null;
  limit: number;
};

export type PdlRpcClient = {
  rpc: (
    name: string,
    params: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error?: { message: string } | null }>;
};

type ReadOptions = {
  retryDelaysMs?: readonly number[];
};

type IterateOptions = ReadOptions & {
  pageSize?: number;
  maxRows?: number;
};

const MAX_PAGE_SIZE = 100_000;
const DEFAULT_PAGE_SIZE = 5_000;
const DEFAULT_RETRY_DELAYS_MS = '3000,20000,60000';
const FRIENDLY_RETRYABLE_ERROR = 'База компаний временно не ответила. Повторите попытку через минуту.';
const FRIENDLY_READ_ERROR = 'Не удалось получить данные базы компаний. Повторите попытку.';

function normalizeList(values: readonly string[] | undefined): string[] | null {
  if (!values?.length) return null;
  const normalized = values
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const unique = Array.from(new Set(normalized));
  return unique.length ? unique : null;
}

function normalizeName(value: string | null | undefined): string | null {
  const normalized = (value ?? '').trim().replace(/[%_]/g, '');
  return normalized || null;
}

function normalizeLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(value)));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

function isRetryableReadError(message: string): boolean {
  return /<!doctype|<html|gateway|timeout|timed out|fetch failed|network|connection|terminated|\b50[234]\b/i.test(message);
}

function retryDelaysFromEnv(): number[] {
  return (process.env.COMPANY_BASE_PDL_RETRY_DELAYS_MS || DEFAULT_RETRY_DELAYS_MS)
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class PdlCompanyReadError extends Error {
  readonly rawMessage: string;
  readonly retryable: boolean;

  constructor(rawMessage: string) {
    const retryable = isRetryableReadError(rawMessage);
    super(retryable ? FRIENDLY_RETRYABLE_ERROR : FRIENDLY_READ_ERROR);
    this.name = 'PdlCompanyReadError';
    this.rawMessage = rawMessage;
    this.retryable = retryable;
  }
}

export function pdlFiltersFromSearchParams(searchParams: URLSearchParams): PdlCompanyFilters {
  const list = (key: string) => searchParams
    .getAll(key)
    .flatMap((value) => value.split(','));

  return {
    industries: list('industry'),
    sizes: list('size'),
    countries: list('country'),
    name: searchParams.get('name'),
  };
}

export async function readPdlCompanyPage(
  client: PdlRpcClient,
  request: PdlCompanyPageRequest,
  options: ReadOptions = {},
): Promise<PdlCompanyCatalogRow[]> {
  const params = {
    p_industries: normalizeList(request.industries),
    p_sizes: normalizeList(request.sizes),
    p_countries: normalizeList(request.countries),
    p_name: normalizeName(request.name),
    p_after_id: request.afterId?.trim() || null,
    p_limit: normalizeLimit(request.limit),
  };
  const retryDelays = options.retryDelaysMs ?? retryDelaysFromEnv();

  for (let attempt = 0; ; attempt += 1) {
    let rawError: string | null = null;
    try {
      const result = await client.rpc('search_pdl_companies', params);
      if (!result.error) {
        if (!Array.isArray(result.data)) {
          throw new Error('search_pdl_companies returned a non-array response');
        }
        return result.data as PdlCompanyCatalogRow[];
      }
      rawError = result.error.message;
    } catch (error) {
      rawError = errorMessage(error);
    }

    const readError = new PdlCompanyReadError(rawError);
    const delay = retryDelays[attempt];
    if (!readError.retryable || delay === undefined) throw readError;
    if (delay > 0) await sleep(delay);
  }
}

export async function* iteratePdlCompanyPages(
  client: PdlRpcClient,
  filters: PdlCompanyFilters,
  options: IterateOptions = {},
): AsyncGenerator<PdlCompanyCatalogRow[]> {
  const pageSize = normalizeLimit(options.pageSize ?? DEFAULT_PAGE_SIZE);
  const requestedMax = options.maxRows ?? Infinity;
  const maxRows = Number.isFinite(requestedMax)
    ? Math.max(0, Math.floor(requestedMax))
    : Infinity;
  let emitted = 0;
  let afterId: string | null = null;

  while (emitted < maxRows) {
    const requestLimit = Math.min(pageSize, maxRows - emitted);
    const page = await readPdlCompanyPage(
      client,
      { ...filters, afterId, limit: requestLimit },
      options,
    );
    const rows = page.slice(0, requestLimit);
    if (!rows.length) return;

    emitted += rows.length;
    yield rows;

    if (rows.length < requestLimit) return;
    const nextId = String(rows[rows.length - 1]?.id ?? '').trim();
    if (!nextId || nextId === afterId) return;
    afterId = nextId;
  }
}
