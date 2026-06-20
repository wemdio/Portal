/** @jest-environment node */

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: jest.fn() },
}));

jest.mock('@/lib/parsers/atsHttp', () => ({
  fetchJsonWithFallback: jest.fn(),
  fetchTextWithFallback: jest.fn(),
}));

jest.mock('@/lib/parsers/companyDomainResolver', () => ({
  domainToSiteUrl: jest.fn(() => null),
  resolveCompanyDomainByName: jest.fn(() => null),
}));

type Row = Record<string, unknown>;
type Filter =
  | { kind: 'eq'; col: string; value: unknown }
  | { kind: 'in'; col: string; value: unknown[] }
  | { kind: 'gte'; col: string; value: unknown };

type MockDbState = Record<string, Row[]>;
type QueryResult = { data: Row | Row[] | null; error: null };
type MockOperation = { table: string; type: string; data?: unknown; filters?: Filter[] };
type MockBuilder = {
  select: (_cols?: string) => MockBuilder;
  update: (data: Row) => MockBuilder;
  insert: (data: Row | Row[]) => MockBuilder;
  upsert: (data: Row | Row[]) => MockBuilder;
  delete: () => MockBuilder;
  eq: (col: string, value: unknown) => MockBuilder;
  in: (col: string, value: unknown[]) => MockBuilder;
  gte: (col: string, value: unknown) => MockBuilder;
  order: (col: string, opts?: { ascending?: boolean }) => MockBuilder;
  limit: (count: number) => MockBuilder;
  range: (start: number, end: number) => MockBuilder;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;
  single: () => Promise<{ data: Row | null; error: null }>;
  then: (resolve: (value: QueryResult) => void, reject: (reason?: unknown) => void) => void;
};

function makeCompanyCsv(count: number): string {
  const rows = ['name,slug,url'];
  for (let i = 0; i < count; i += 1) {
    rows.push(`Company ${i},company-${i},https://boards.example/company-${i}`);
  }
  return rows.join('\n');
}

function makeGreenhouseJob(slug: string, id: number) {
  return {
    jobs: [
      {
        id: `${slug}-job-${id}`,
        title: 'B2B Sales Manager',
        company_name: slug,
        location: { name: 'United States' },
        absolute_url: `https://${slug}.example/jobs/${id}`,
        updated_at: '2026-06-15T00:00:00.000Z',
      },
    ],
  };
}

function rowMatches(row: Row, filters: Filter[]): boolean {
  return filters.every((filter) => {
    if (filter.kind === 'eq') return row[filter.col] === filter.value;
    if (filter.kind === 'in') return filter.value.includes(row[filter.col]);
    if (filter.kind === 'gte') return String(row[filter.col] ?? '') >= String(filter.value ?? '');
    return true;
  });
}

function makeDb(initialState: MockDbState) {
  const state: MockDbState = Object.fromEntries(
    Object.entries(initialState).map(([table, rows]) => [table, rows.map((row) => ({ ...row }))]),
  );
  const operations: MockOperation[] = [];
  let idSeq = 1;

  const from = jest.fn((table: string) => {
    const filters: Filter[] = [];
    let op: 'select' | 'update' | 'insert' | 'upsert' | 'delete' = 'select';
    let payload: Row | Row[] | null = null;
    let rangeStart: number | null = null;
    let rangeEnd: number | null = null;
    let limitCount: number | null = null;
    let orderSpec: { col: string; ascending: boolean } | null = null;

    const execute = (): QueryResult => {
      state[table] ??= [];

      if (op === 'insert') {
        if (payload == null) throw new Error('insert payload missing');
        const rows = Array.isArray(payload) ? payload : [payload];
        const inserted = rows.map((row) => ({ id: row.id ?? `mock-${idSeq++}`, ...row }));
        state[table].push(...inserted);
        operations.push({ table, type: 'insert', data: inserted.map((row) => ({ ...row })), filters: [...filters] });
        return { data: Array.isArray(payload) ? inserted : inserted[0], error: null };
      }

      if (op === 'update') {
        if (payload == null || Array.isArray(payload)) throw new Error('update payload missing');
        const updated: Row[] = [];
        for (const row of state[table]) {
          if (!rowMatches(row, filters)) continue;
          Object.assign(row, payload);
          updated.push({ ...row });
        }
        operations.push({ table, type: 'update', data: { ...payload }, filters: [...filters] });
        return { data: updated, error: null };
      }

      if (op === 'upsert') {
        if (payload == null) throw new Error('upsert payload missing');
        const rows = Array.isArray(payload) ? payload : [payload];
        for (const row of rows) {
          const existing = state[table].find((candidate) => {
            if (table === 'eng_hiring_cache') {
              return candidate.source === row.source && candidate.source_job_id === row.source_job_id;
            }
            if (table === 'eng_hiring_vacancies') {
              return candidate.job_id === row.job_id && candidate.source === row.source && candidate.source_job_id === row.source_job_id;
            }
            return candidate.id && candidate.id === row.id;
          });
          if (existing) Object.assign(existing, row);
          else state[table].push({ id: row.id ?? `mock-${idSeq++}`, ...row });
        }
        operations.push({ table, type: 'upsert', data: rows.map((row) => ({ ...row })), filters: [...filters] });
        return { data: rows, error: null };
      }

      if (op === 'delete') {
        const before = state[table].length;
        state[table] = state[table].filter((row) => !rowMatches(row, filters));
        operations.push({ table, type: 'delete', data: { deleted: before - state[table].length }, filters: [...filters] });
        return { data: null, error: null };
      }

      let rows = state[table].filter((row) => rowMatches(row, filters)).map((row) => ({ ...row }));
      if (orderSpec) {
        rows.sort((a, b) => {
          const av = a[orderSpec!.col] ?? '';
          const bv = b[orderSpec!.col] ?? '';
          const cmp = av > bv ? 1 : av < bv ? -1 : 0;
          return orderSpec!.ascending ? cmp : -cmp;
        });
      }
      if (rangeStart != null && rangeEnd != null) rows = rows.slice(rangeStart, rangeEnd + 1);
      if (limitCount != null) rows = rows.slice(0, limitCount);
      operations.push({ table, type: 'select', filters: [...filters] });
      return { data: rows, error: null };
    };

    const builder: MockBuilder = {
      select: () => {
        if (op === 'select') op = 'select';
        return builder;
      },
      update: (data: Row) => {
        op = 'update';
        payload = data;
        return builder;
      },
      insert: (data: Row | Row[]) => {
        op = 'insert';
        payload = data;
        return builder;
      },
      upsert: (data: Row | Row[]) => {
        op = 'upsert';
        payload = data;
        return builder;
      },
      delete: () => {
        op = 'delete';
        return builder;
      },
      eq: (col: string, value: unknown) => {
        filters.push({ kind: 'eq', col, value });
        return builder;
      },
      in: (col: string, value: unknown[]) => {
        filters.push({ kind: 'in', col, value });
        return builder;
      },
      gte: (col: string, value: unknown) => {
        filters.push({ kind: 'gte', col, value });
        return builder;
      },
      order: (col: string, opts: { ascending?: boolean } = {}) => {
        orderSpec = { col, ascending: opts.ascending !== false };
        return builder;
      },
      limit: (count: number) => {
        limitCount = count;
        return builder;
      },
      range: (start: number, end: number) => {
        rangeStart = start;
        rangeEnd = end;
        return builder;
      },
      maybeSingle: async () => {
        const result = execute();
        return { data: Array.isArray(result.data) ? (result.data[0] ?? null) : (result.data ?? null), error: null };
      },
      single: async () => {
        const result = execute();
        return { data: Array.isArray(result.data) ? (result.data[0] ?? null) : (result.data ?? null), error: null };
      },
      then: (resolve: (value: QueryResult) => void, reject: (reason?: unknown) => void) => {
        Promise.resolve(execute()).then(resolve, reject);
      },
    };

    return builder;
  });

  return { from, operations, state };
}

async function loadRunner() {
  jest.resetModules();
  process.env.ENG_HIRING_SCAN_DELAY_MS ??= '0';
  process.env.ENG_HIRING_DETAIL_LIMIT ??= '0';
  process.env.ENG_HIRING_ENRICH_LIMIT ??= '0';
  process.env.ENG_HIRING_SCAN_CONCURRENCY ??= '1';
  const admin = await import('@/lib/supabaseAdmin');
  const atsHttp = await import('@/lib/parsers/atsHttp');
  const runner = await import('@/lib/parsers/engHiringRunner');
  return {
    runEngHiringParserJob: runner.runEngHiringParserJob,
    supabaseAdmin: admin.supabaseAdmin as unknown as { from: jest.Mock },
    fetchTextWithFallback: atsHttp.fetchTextWithFallback as jest.Mock,
    fetchJsonWithFallback: atsHttp.fetchJsonWithFallback as jest.Mock,
  };
}

describe('runEngHiringParserJob cache-run resume', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ENG_HIRING_SCAN_CONCURRENCY;
    delete process.env.ENG_HIRING_SCAN_DELAY_MS;
    delete process.env.ENG_HIRING_DETAIL_LIMIT;
    delete process.env.ENG_HIRING_ENRICH_LIMIT;
    delete process.env.ENG_HIRING_TOKEN_BASES;
  });

  it('resumes an unfinished source cache run from next_company_index', async () => {
    const { runEngHiringParserJob, supabaseAdmin, fetchTextWithFallback, fetchJsonWithFallback } = await loadRunner();
    const db = makeDb({
      parser_jobs: [{
        id: 'job-1',
        status: 'running',
        config: {
          text: 'b2b manager',
          sources: ['greenhouse'],
          countries: ['us'],
          companies_limit: 5,
          refresh_cache: true,
          enrich: false,
          max_results: 20,
        },
      }],
      eng_hiring_cache_runs: [{
        id: 'run-existing',
        source: 'greenhouse',
        companies_limit: 5,
        status: 'running',
        next_company_index: 2,
        total_companies: 5,
        scanned_companies: 2,
        cached_vacancies: 2,
        started_at: '2026-06-16T00:00:00.000Z',
      }],
      eng_hiring_cache: [],
      eng_hiring_vacancies: [],
    });
    supabaseAdmin.from.mockImplementation(db.from);
    fetchTextWithFallback.mockResolvedValue(makeCompanyCsv(5));
    fetchJsonWithFallback.mockImplementation(async (url: string) => {
      const slug = url.match(/boards\/([^/]+)\/jobs/)?.[1] ?? 'unknown';
      return makeGreenhouseJob(slug, 1);
    });

    await runEngHiringParserJob('job-1');

    const fetchedUrls = fetchJsonWithFallback.mock.calls.map(([url]) => String(url));
    expect(fetchedUrls.some((url) => url.includes('/company-0/'))).toBe(false);
    expect(fetchedUrls.some((url) => url.includes('/company-1/'))).toBe(false);
    expect(fetchedUrls.some((url) => url.includes('/company-2/'))).toBe(true);
    expect(fetchedUrls.some((url) => url.includes('/company-4/'))).toBe(true);
    expect(db.operations.filter((op) => op.table === 'eng_hiring_cache_runs' && op.type === 'insert')).toHaveLength(0);
    expect(db.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'eng_hiring_cache_runs',
        type: 'update',
        data: expect.objectContaining({
          status: 'completed',
          next_company_index: 5,
          scanned_companies: 5,
        }),
      }),
    ]));
  });

  it('keeps an interrupted source cache run resumable when deploy pauses the job', async () => {
    const { runEngHiringParserJob, supabaseAdmin, fetchTextWithFallback, fetchJsonWithFallback } = await loadRunner();
    const jobRow = {
      id: 'job-1',
      status: 'running',
      config: {
        text: 'b2b manager',
        sources: ['greenhouse'],
        countries: ['us'],
        companies_limit: 26,
        refresh_cache: true,
        enrich: false,
        max_results: 20,
      },
    };
    const db = makeDb({
      parser_jobs: [jobRow],
      eng_hiring_cache_runs: [],
      eng_hiring_cache: [],
      eng_hiring_vacancies: [],
    });
    supabaseAdmin.from.mockImplementation(db.from);
    fetchTextWithFallback.mockResolvedValue(makeCompanyCsv(26));
    fetchJsonWithFallback.mockImplementation(async (url: string) => {
      if (fetchJsonWithFallback.mock.calls.length >= 25) {
        db.state.parser_jobs.find((row) => row.id === 'job-1')!.status = 'pending';
      }
      const slug = url.match(/boards\/([^/]+)\/jobs/)?.[1] ?? 'unknown';
      return makeGreenhouseJob(slug, 1);
    });

    await runEngHiringParserJob('job-1');

    const runUpdates = db.operations.filter((op) => op.table === 'eng_hiring_cache_runs' && op.type === 'update');
    expect(runUpdates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    ]));
    expect(runUpdates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        data: expect.objectContaining({
          next_company_index: 25,
          scanned_companies: 25,
        }),
      }),
    ]));
    expect(db.state.eng_hiring_cache).toHaveLength(25);
    expect(db.state.parser_jobs.find((row) => row.id === 'job-1')?.status).toBe('pending');
  });

  it('refreshes ATS boards with bounded parallelism instead of one-by-one requests', async () => {
    process.env.ENG_HIRING_SCAN_CONCURRENCY = '3';
    const { runEngHiringParserJob, supabaseAdmin, fetchTextWithFallback, fetchJsonWithFallback } = await loadRunner();
    const db = makeDb({
      parser_jobs: [{
        id: 'job-1',
        status: 'running',
        config: {
          text: 'b2b manager',
          sources: ['greenhouse'],
          countries: ['us'],
          companies_limit: 6,
          refresh_cache: true,
          enrich: false,
          max_results: 20,
        },
      }],
      eng_hiring_cache_runs: [],
      eng_hiring_cache: [],
      eng_hiring_vacancies: [],
    });
    supabaseAdmin.from.mockImplementation(db.from);
    fetchTextWithFallback.mockResolvedValue(makeCompanyCsv(6));

    let active = 0;
    let maxActive = 0;
    fetchJsonWithFallback.mockImplementation(async (url: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      const slug = url.match(/boards\/([^/]+)\/jobs/)?.[1] ?? 'unknown';
      return makeGreenhouseJob(slug, 1);
    });

    await runEngHiringParserJob('job-1');

    expect(maxActive).toBeGreaterThanOrEqual(3);
    expect(fetchJsonWithFallback).toHaveBeenCalledTimes(6);
  });

  it('merges company token lists from multiple bases and scans each board once', async () => {
    process.env.ENG_HIRING_TOKEN_BASES = 'https://primary.example/tokens, https://extra.example/tokens';
    const { runEngHiringParserJob, supabaseAdmin, fetchTextWithFallback, fetchJsonWithFallback } = await loadRunner();
    const db = makeDb({
      parser_jobs: [{
        id: 'job-1',
        status: 'running',
        config: {
          text: 'b2b manager',
          sources: ['greenhouse'],
          countries: ['us'],
          companies_limit: 50,
          refresh_cache: true,
          enrich: false,
          max_results: 20,
        },
      }],
      eng_hiring_cache_runs: [],
      eng_hiring_cache: [],
      eng_hiring_vacancies: [],
    });
    supabaseAdmin.from.mockImplementation(db.from);
    fetchTextWithFallback.mockImplementation(async (url: string) => {
      if (url.includes('primary.example')) {
        return ['name,slug,url', 'Acme,acme,https://x/acme', 'Beta,beta,https://x/beta'].join('\n');
      }
      if (url.includes('extra.example')) {
        return ['name,slug,url', 'Beta dup,beta,https://x/beta-dup', 'Gamma,gamma,https://x/gamma'].join('\n');
      }
      return '';
    });
    fetchJsonWithFallback.mockImplementation(async (url: string) => {
      const slug = String(url).match(/boards\/([^/]+)\/jobs/)?.[1] ?? 'unknown';
      return makeGreenhouseJob(slug, 1);
    });

    await runEngHiringParserJob('job-1');

    const scannedSlugs = fetchJsonWithFallback.mock.calls
      .map(([url]) => String(url).match(/boards\/([^/]+)\/jobs/)?.[1])
      .filter((slug): slug is string => Boolean(slug));
    // both bases fetched, beta deduped, gamma from the extra base included
    expect(new Set(scannedSlugs)).toEqual(new Set(['acme', 'beta', 'gamma']));
    expect(scannedSlugs.filter((slug) => slug === 'beta')).toHaveLength(1);
  });

  it('refreshes Workday boards through the WAF-resilient POST helper and dedupes overlaps', async () => {
    const { runEngHiringParserJob, supabaseAdmin, fetchTextWithFallback, fetchJsonWithFallback } = await loadRunner();
    const db = makeDb({
      parser_jobs: [{
        id: 'job-1',
        status: 'running',
        config: {
          text: 'commercial account director',
          sources: ['workday'],
          countries: ['gb'],
          companies_limit: 1,
          refresh_cache: true,
          enrich: false,
          max_results: 20,
        },
      }],
      eng_hiring_cache_runs: [],
      eng_hiring_cache: [],
      eng_hiring_vacancies: [],
    });
    supabaseAdmin.from.mockImplementation(db.from);
    fetchTextWithFallback.mockResolvedValue([
      'name,slug,url',
      'Acme,acme/acme_external,https://acme.wd5.myworkdayjobs.com/acme_external',
    ].join('\n'));

    // Workday CXS is fetched via fetchJsonWithFallback (POST) so it survives the
    // WAF block on raw fetch — the fallback itself is unit-tested in atsHttp.test.
    const jobsBySearch: Record<string, unknown[]> = {
      '': [{
        title: 'Product Manager',
        externalPath: '/job/US-Remote/Product-Manager_R0001',
        locationsText: 'US Remote',
        postedOn: 'Posted Today',
        bulletFields: ['R0001'],
      }],
      sales: [{
        title: 'Sales Development Representative',
        externalPath: '/job/US-Texas-Remote/Sales-Development-Representative_R1000',
        locationsText: 'US Texas Remote',
        postedOn: 'Posted Today',
        bulletFields: ['R1000'],
      }],
      account: [{
        title: 'Commercial Account Director',
        externalPath: '/job/UK-London-Office/Commercial-Account-Director_R2414',
        locationsText: 'UK-London Office',
        postedOn: 'Posted Today',
        bulletFields: ['R2414'],
      }],
      'business development': [{
        title: 'Commercial Account Director',
        externalPath: '/job/UK-London-Office/Commercial-Account-Director_R2414',
        locationsText: 'UK-London Office',
        postedOn: 'Posted Today',
        bulletFields: ['R2414'],
      }],
    };
    fetchJsonWithFallback.mockImplementation(async (_url: string, options: { body?: string } = {}) => {
      const searchText = (JSON.parse(options.body ?? '{}') as { searchText?: string }).searchText ?? '';
      const jobPostings = jobsBySearch[searchText] ?? [];
      return { total: jobPostings.length, jobPostings };
    });

    await runEngHiringParserJob('job-1');

    const workdayCalls = fetchJsonWithFallback.mock.calls.filter(([url]) => String(url).includes('/wday/cxs/'));
    expect(workdayCalls.length).toBeGreaterThan(0);
    // every Workday request is a POST routed through the WAF-resilient helper
    expect(workdayCalls.every(([, options]) => (options as { method?: string })?.method === 'POST')).toBe(true);
    expect(workdayCalls[0][0]).toBe('https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/acme_external/jobs');
    const searchTexts = workdayCalls.map(([, options]) =>
      (JSON.parse((options as { body?: string }).body ?? '{}') as { searchText?: string }).searchText);
    expect(searchTexts).toEqual(expect.arrayContaining(['', 'sales', 'account', 'business development']));

    expect(db.state.eng_hiring_cache).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'workday',
        source_company_slug: 'acme/acme_external',
        vacancy_title: 'Commercial Account Director',
        country_code: 'gb',
      }),
    ]));
    expect(db.state.eng_hiring_cache.filter((row) => row.source_job_id === 'Commercial-Account-Director_R2414')).toHaveLength(1);
  });

  it('pushes country and recency filters into the cache query before text matching', async () => {
    const { runEngHiringParserJob, supabaseAdmin } = await loadRunner();
    const db = makeDb({
      parser_jobs: [{
        id: 'job-1',
        status: 'running',
        config: {
          text: 'b2b manager',
          sources: ['greenhouse'],
          countries: ['us'],
          posted_within_days: 30,
          now: '2026-06-16T00:00:00.000Z',
          refresh_cache: false,
          enrich: false,
          max_results: 20,
        },
      }],
      eng_hiring_cache: [],
      eng_hiring_vacancies: [],
    });
    supabaseAdmin.from.mockImplementation(db.from);

    await runEngHiringParserJob('job-1');

    const cacheSelect = db.operations.find((op) => op.table === 'eng_hiring_cache' && op.type === 'select');
    expect(cacheSelect?.filters).toEqual(expect.arrayContaining([
      { kind: 'in', col: 'source', value: ['greenhouse'] },
      { kind: 'in', col: 'country_code', value: ['us'] },
      { kind: 'gte', col: 'published_at', value: '2026-05-17T00:00:00.000Z' },
    ]));
  });

  it('stores source diagnostics in the completed parser job progress detail', async () => {
    const { runEngHiringParserJob, supabaseAdmin } = await loadRunner();
    const db = makeDb({
      parser_jobs: [{
        id: 'job-1',
        status: 'running',
        config: {
          text: 'b2b manager',
          sources: ['greenhouse'],
          countries: ['us'],
          posted_within_days: 30,
          now: '2026-06-16T00:00:00.000Z',
          refresh_cache: false,
          enrich: false,
          max_results: 20,
        },
      }],
      eng_hiring_cache: [{
        id: 'cache-1',
        source: 'greenhouse',
        source_company_slug: 'acme',
        source_job_id: 'job-1',
        company_name: 'Acme',
        company_site_url: 'https://acme.com',
        company_description: null,
        vacancy_title: 'Sales Development Representative',
        vacancy_description: null,
        vacancy_url: 'https://acme.com/jobs/1',
        careers_url: 'https://job-boards.greenhouse.io/acme',
        location: 'United States',
        city: null,
        country: 'United States',
        country_code: 'us',
        salary_from: null,
        salary_to: null,
        salary_currency: null,
        published_at: '2026-06-15T00:00:00.000Z',
        raw: {},
      }],
      eng_hiring_vacancies: [],
    });
    supabaseAdmin.from.mockImplementation(db.from);

    await runEngHiringParserJob('job-1');

    const completedUpdate = db.operations.find((op) =>
      op.table === 'parser_jobs' &&
      op.type === 'update' &&
      (op.data as Row).status === 'completed');
    expect(completedUpdate?.data).toEqual(expect.objectContaining({
      progress_detail: expect.objectContaining({
        source_stats: expect.objectContaining({
          greenhouse: expect.objectContaining({
            matched_rows: 1,
          }),
        }),
      }),
    }));
  });
});
