/** @jest-environment node */

import { placeResultToRow, newsResultToRow, streamSse } from '@/../lib/parsers/googleParsersWorker';

describe('placeResultToRow', () => {
  test('maps parser PlaceResult to google_maps_places row shape', () => {
    const row = placeResultToRow('job-1', {
      query: 'cafes Berlin', city: '', category: 'cafe',
      name: 'Cafe X', address: '1 Str, Berlin', phone: '+49 123',
      website: 'https://cafex.de', emails: ['hi@cafex.de'], socials: [],
      linkedInUrl: 'https://linkedin.com/company/cafex',
      rating: '4.5', reviewsCount: '128',
      googleMapsUrl: 'https://maps.google.com/?cid=1', placeId: 'cid:1',
      googleId: 'gid:1', latitude: '52.5', longitude: '13.4',
      dedupeKey: 'cid:1', sourceUrl: 'cafes Berlin', status: 'ok',
    });
    expect(row.job_id).toBe('job-1');
    expect(row.name).toBe('Cafe X');
    expect(row.emails).toEqual(['hi@cafex.de']);
    expect(row.reviews_count).toBe(128);
    expect(row.latitude).toBe(52.5);
    expect(row.dedupe_key).toBe('cid:1');
  });

  test('empty reviews_count → null (not zero)', () => {
    const row = placeResultToRow('job-1', {
      query: '', city: '', category: '', name: '', address: '', phone: '',
      website: '', emails: [], socials: [], linkedInUrl: '',
      rating: '', reviewsCount: '', googleMapsUrl: '', placeId: '',
      googleId: '', latitude: '', longitude: '',
      dedupeKey: 'abc', sourceUrl: '', status: 'partial',
    });
    expect(row.reviews_count).toBeNull();
    expect(row.latitude).toBeNull();
  });
});

describe('newsResultToRow', () => {
  test('maps NewsResult to google_news_results row', () => {
    const row = newsResultToRow('job-2', {
      query: 'AI news', position: 3, title: 'Big AI update',
      body: 'Body text', posted: '2h ago', source: 'TechNews',
      link: 'https://techn.com/x',
    });
    expect(row.job_id).toBe('job-2');
    expect(row.position).toBe(3);
    expect(row.link).toBe('https://techn.com/x');
  });
});

describe('streamSse', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('ignores heartbeat comments and handles CRLF frames', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': heartbeat\n\n'));
        controller.enqueue(encoder.encode('event: progress\r\ndata: {"currentTargetIndex":1}\r\n\r\n'));
        controller.close();
      },
    });
    global.fetch = jest.fn().mockResolvedValue(new Response(body, { status: 200 }));
    const progress = jest.fn();

    await streamSse('http://parser/run/maps', {}, { progress });

    expect(progress).toHaveBeenCalledWith({ currentTargetIndex: 1 });
  });

  test('fails early on a non-success service response', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response('bad gateway', { status: 502 }));

    await expect(streamSse('http://parser/run/maps', {}, {}))
      .rejects.toThrow('parser service returned HTTP 502');
  });
});


// Search parser shares the worker lifecycle contract with the other parsers.
// Provider calls stay mocked: these checks cannot incur API charges.
import type { SupabaseClient } from '@supabase/supabase-js';
import { withSearchExecution, searchExecution, saveSearchProgress, saveSearchResults, type SearchLease } from '@/lib/parsers/searchExecution';
import { runSearchProbe, searchProbeRows } from '@/lib/parsers/searchProbeWorker';
import { accountSearchSpend } from '@/lib/parsers/searchSpend';
import { ProviderBudgetWaitError } from '@/lib/providerUsage';
import { serperSearchDetailed } from '@/lib/parsers/serperSearch';
jest.mock('@/lib/parsers/serperSearch', () => ({ serperSearchDetailed: jest.fn(), serperSearchMultiPage: jest.fn() }));

const rpcDb = (rpc: jest.Mock) => ({ rpc }) as unknown as SupabaseClient;
const lease: SearchLease = { job_id: 'search-job', token: 'token', probe: null };
const probe = { job_id: 'search-job', base_id: 'base', query: 'platform operators', locale: 'en' as const,
  page: 1, attempted_at: null, results: null };

describe('shared search admission and bounded automatic discovery', () => {
  afterEach(() => { jest.useRealTimers(); jest.clearAllMocks(); });
  test('busy admission does no work; progress/results require the winning token', async () => {
    const rpc = jest.fn().mockResolvedValueOnce({ data: null }).mockResolvedValueOnce({ data: lease })
      .mockResolvedValueOnce({ data: true }).mockResolvedValueOnce({ data: 1 });
    const work = jest.fn();
    expect(await withSearchExecution(rpcDb(rpc), undefined, work)).toBe(false);
    expect(work).not.toHaveBeenCalled();
    expect(await withSearchExecution(rpcDb(rpc), 'search-job', async () => {
      await saveSearchProgress(rpcDb(rpc), 'search-job', { total_results: 1 });
      expect(await saveSearchResults(rpcDb(rpc), 'search-job', [{ site: 'https://example.org' }])).toBe(1);
      expect(() => searchExecution('some-other-job')).toThrow('ownership');
    })).toBe(true);
    expect(rpc).toHaveBeenCalledWith('search_save_progress', expect.objectContaining({ p_token: 'token' }));
    expect(rpc).toHaveBeenCalledWith('search_save_results', expect.objectContaining({ p_token: 'token' }));
    expect(() => searchExecution('search-job')).toThrow('ownership');
  });
  test('lost heartbeat stops subsequent writes, including a hung heartbeat', async () => {
    jest.useFakeTimers();
    const rpc = jest.fn().mockResolvedValueOnce({ data: lease }).mockImplementationOnce(() => new Promise(() => {}));
    let release!: () => void;
    const pending = withSearchExecution(rpcDb(rpc), undefined, async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      await expect(saveSearchProgress(rpcDb(rpc), 'search-job', { status: 'completed' })).rejects.toThrow('heartbeat unavailable');
    });
    await jest.advanceTimersByTimeAsync(40_001);
    release(); await pending;
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  test('budget denial happens before HTTP and saves a deferred job; ambiguity never refunds', async () => {
    process.env.SERPER_API_KEY = 'test-only';
    const rpc = jest.fn(async (name: string) => ({ data: name === 'search_claim_job' ? { ...lease, probe }
      : name === 've_reserve_search_spend' ? 'budget' : true }));
    await withSearchExecution(rpcDb(rpc), undefined, (owned) => runSearchProbe(rpcDb(rpc), owned));
    expect(serperSearchDetailed).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('ve_delay_search_probe', expect.objectContaining({ p_token: 'token' }));
    await accountSearchSpend(rpcDb(rpc), 'base', { attemptId: 'a', provider: 'requesty', phase: 'finished', status: 'ambiguous' });
    expect(rpc).toHaveBeenCalledWith('ve_settle_search_spend', { p_attempt_id: 'a', p_actual_usd: null });
    await expect(accountSearchSpend(rpcDb(rpc), 'base', { attemptId: 'a', provider: 'requesty', phase: 'started' }))
      .rejects.toBeInstanceOf(ProviderBudgetWaitError);
    delete process.env.SERPER_API_KEY;
  });
  test('cache and previously attempted requests never call the paid provider again', async () => {
    for (const saved of [{ ...probe, results: [] }, { ...probe, attempted_at: '2026-10-07T00:00:00Z' }]) {
      const rpc = jest.fn(async (name: string) => ({ data: name === 'search_claim_job' ? { ...lease, probe: saved } : true }));
      await withSearchExecution(rpcDb(rpc), undefined, (owned) => runSearchProbe(rpcDb(rpc), owned));
    }
    expect(serperSearchDetailed).not.toHaveBeenCalled();
  });
  test('a probe buys one page; results are candidates, without email enrichment or broad expansion', async () => {
    process.env.SERPER_API_KEY = 'test-only';
    jest.mocked(serperSearchDetailed).mockResolvedValue({ debug: { request_url: '', status: 200, organic_count: 1 },
      results: [{ query: 'q', title: 'Platform', link: 'https://platform.example/about', snippet: 'Subscription platform', position: 1 }] });
    const rpc = jest.fn(async (name: string) => ({ data: name === 'search_claim_job' ? { ...lease, probe }
      : name === 've_reserve_search_spend' ? 'reserved' : true }));
    await withSearchExecution(rpcDb(rpc), undefined, (owned) => runSearchProbe(rpcDb(rpc), owned));
    expect(serperSearchDetailed).toHaveBeenCalledTimes(1);
    expect(serperSearchDetailed).toHaveBeenCalledWith('platform operators', { num: 10, page: 1, gl: 'us', hl: 'en' });
    expect(rpc).toHaveBeenCalledWith('ve_finish_search_probe', expect.objectContaining({ p_results: [expect.objectContaining({ website: 'https://platform.example', email: '' })] }));
    delete process.env.SERPER_API_KEY;
  });
  test('candidate URLs are bounded and deduplicated; adult business sites are not globally excluded', () => {
    const item = (link: string) => ({ title: 'Unverified company', snippet: 'untrusted source text', link });
    expect(searchProbeRows([item('https://platform.example/a'), item('http://www.platform.example/b'),
      item('http://127.0.0.1'), item('http://[::1]/'), item('https://user:secret@x.example'),
      item('https://google.com/search?q=company'), item('https://adult-platform.example')]))
      .toEqual([expect.objectContaining({ website: 'https://platform.example', email: '' }),
        expect.objectContaining({ website: 'https://adult-platform.example', email: '' })]);
    expect(searchProbeRows(Array.from({ length: 100 }, (_, i) => item(`https://company${i}.example`)))).toHaveLength(10);
  });
});


import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import { serperSearchMultiPage } from '@/lib/parsers/serperSearch';
import { fetchWebsiteEmails } from '@/lib/enrich/websiteParser';
let mockSearchDb: ReturnType<typeof createMockSupabase>;
jest.mock('@/lib/supabaseAdmin', () => ({ get supabaseAdmin() { return mockSearchDb; } }));
jest.mock('@/lib/loggerServer', () => ({ logInfo: jest.fn(), logWarn: jest.fn(), logError: jest.fn() }));
jest.mock('@/lib/tracer', () => ({ startTrace: jest.fn(async () => null) }));
jest.mock('@/lib/enrich/websiteParser', () => ({ fetchWebsiteEmails: jest.fn() }));
jest.mock('@/lib/parsers/searchQueryGenerator', () => ({ generateSearchQueries: jest.fn() }));
jest.mock('@/lib/parsers/searchScraper', () => ({
  googleSearchDetailed: jest.fn(), bingSearchDetailed: jest.fn(), duckDuckGoSearchDetailed: jest.fn(), mojeekSearchDetailed: jest.fn(),
  isBingBlockedError: () => false, isDuckDuckGoBlockedError: () => false, isGoogleBlockedError: () => false, isMojeekBlockedError: () => false,
}));
jest.mock('@/lib/parsers/sourceCompanyExtractor', () => ({ extractCompanySitesFromSource: jest.fn() }));

test('manual parser retains chosen depth and enrichment; a failed result checkpoint cannot complete the job', async () => {
  const originalKey = process.env.SERPER_API_KEY;
  process.env.SERPER_API_KEY = 'offline-only';
  const { runSearchParserJob } = await import('@/lib/parsers/searchParserWorker');
  try {
    for (const failInsert of [false, true]) {
      mockSearchDb = createMockSupabase({ tables: { search_parser_jobs: [{ id: lease.job_id, user_id: 'user',
        status: 'pending', config: { queries: ['specialist query'], search_depth: 7 } }] }, rpcHandlers: {
        search_claim_job: async (_, db) => {
          if (db.getRows('search_parser_jobs')[0].status !== 'pending') return { data: null };
          await db.from('search_parser_jobs').update({ status: 'running' }).eq('id', lease.job_id);
          return { data: lease };
        },
        search_save_progress: async (p, db) => {
          await db.from('search_parser_jobs').update(p.p_patch as Record<string, unknown>).eq('id', lease.job_id);
          return { data: true };
        },
        search_save_results: async (p, db) => {
          if (failInsert) return { data: null, error: { message: 'DB response lost' } };
          await db.from('search_results').insert(p.p_rows as Array<Record<string, unknown>>);
          return { data: 1 };
        },
      } });
      jest.mocked(serperSearchMultiPage).mockResolvedValue({ results: [{ query: 'specialist query',
        title: 'Test Manufacturer', link: 'https://manufacturer.example.org', snippet: 'Manufacturing', position: 1 }],
        lastPage: 7, debug: { request_url: 'offline', status: 200, organic_count: 1 } });
      jest.mocked(fetchWebsiteEmails).mockResolvedValue({ emails: ['hello@manufacturer.example.org'], brand_name: 'Test Manufacturer' } as Awaited<ReturnType<typeof fetchWebsiteEmails>>);
      if (failInsert) {
        await expect(runSearchParserJob(lease.job_id)).rejects.toThrow('persistence failed');
        expect(mockSearchDb.getRows('search_parser_jobs')[0]).toMatchObject({ status: 'running', processed_queries: 0 });
      } else {
        expect(await runSearchParserJob(lease.job_id)).toBe(true);
        expect(mockSearchDb.getRows('search_parser_jobs')[0]).toMatchObject({ status: 'completed', total_results: 1 });
        expect(mockSearchDb.getRows('search_results')[0]).toMatchObject({ email: 'hello@manufacturer.example.org' });
        expect(await runSearchParserJob(lease.job_id)).toBe(false);
      }
      expect(serperSearchMultiPage).toHaveBeenCalledWith('specialist query', expect.objectContaining({ pages: 7 }));
    }
  } finally {
    if (originalKey === undefined) delete process.env.SERPER_API_KEY; else process.env.SERPER_API_KEY = originalKey;
  }
});
