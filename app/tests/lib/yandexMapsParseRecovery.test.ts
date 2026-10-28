/** @jest-environment node */
import { createMockSupabase } from '../helpers/mockSupabase';

let mockDb = createMockSupabase();
jest.mock('@/lib/supabaseAdmin', () => ({ get supabaseAdmin() { return mockDb; } }));
jest.mock('@/lib/loggerServer', () => ({ logError: jest.fn(), logInfo: jest.fn(), logWarn: jest.fn() }));
jest.mock('@/lib/tracer', () => ({ startTrace: jest.fn(async () => null) }));
jest.mock('@/lib/parsers/yandexMapsCatalog', () => ({ upsertYandexMapsCatalogOrganizations: jest.fn() }));
jest.mock('@/lib/parsers/yandexMapsServiceClient', () => ({
  yandexMapsHealth: jest.fn(async () => true),
  yandexMapsProxyCheck: jest.fn(async () => null),
  yandexMapsParseOrgs: jest.fn(),
  YandexMapsBlockedError: class extends Error {},
}));

import { runYandexMapsParseOrganizations } from '@/lib/parsers/yandexMapsWorker';
import { yandexMapsParseOrgs, YandexMapsBlockedError } from '@/lib/parsers/yandexMapsServiceClient';

const parse = yandexMapsParseOrgs as jest.Mock;
const card = (id: number) => `https://yandex.ru/maps/org/company/${id}/`;
const job = { id: 'job', user_id: 'owner', status: 'running', started_at: '2026-10-29T01:00:00Z', config: { strict_max_results: true, max_results: 2 }, proxy_enabled: false };
const saved = { job_id: 'job', card_url: card(1), name: 'Already saved' };
const originalEnv = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.YANDEXMAPS_PROXY_URLS;
  delete process.env.PROXY_URLS;
  process.env.YANDEXMAPS_PARSE_CHUNK_SIZE = '5';
  process.env.YANDEXMAPS_PARSE_CHUNK_CONCURRENCY = '8';
  mockDb = createMockSupabase({ tables: {
    yandex_maps_jobs: [{ ...job }],
    yandex_maps_links: [1, 2, 3].map((id) => ({ job_id: 'job', link: card(id) })),
    yandex_maps_organizations: [{ ...saved }],
  } });
  parse.mockImplementation(async ({ links }: { links: string[] }) => ({
    organizations: links.map((card_url) => ({ card_url, name: 'New' })),
  }));
});
afterEach(() => {
  jest.useRealTimers();
  process.env = { ...originalEnv };
});

it('resumes only missing cards, preserving saved rows and strict result limit', async () => {
  await runYandexMapsParseOrganizations('job');
  expect(parse).toHaveBeenCalledTimes(1);
  expect(parse.mock.calls[0][0].links).toEqual([card(2)]);
  expect(mockDb.getRows('yandex_maps_organizations')).toEqual([saved, expect.objectContaining({ card_url: card(2) })]);
  expect(mockDb.getRows('yandex_maps_jobs')[0]).toMatchObject({ status: 'completed', processed_organizations: 2 });
});

it('does not retry or overwrite a failed/reclaimed job after a late response', async () => {
  for (const next of [{ status: 'failed', error_message: 'watchdog' }, { status: 'running', started_at: '2026-10-29T02:00:00Z' }]) {
    await mockDb.from('yandex_maps_jobs').update(job).eq('id', 'job');
    parse.mockImplementationOnce(async () => {
      await mockDb.from('yandex_maps_jobs').update(next).eq('id', 'job');
      return { organizations: [{ card_url: card(2), name: 'Late' }] };
    });
    await runYandexMapsParseOrganizations('job');
    expect(mockDb.getRows('yandex_maps_jobs')[0]).toMatchObject(next);
    expect(mockDb.getRows('yandex_maps_organizations')).toEqual([saved]);
  }
  expect(parse).toHaveBeenCalledTimes(2);
});

it('aborts an in-flight request on watchdog failure without waiting for HTTP timeout', async () => {
  jest.useFakeTimers();
  let began!: () => void;
  const started = new Promise<void>((resolve) => { began = resolve; });
  parse.mockImplementationOnce((_req, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    began();
  }));
  const running = runYandexMapsParseOrganizations('job');
  await started;
  await mockDb.from('yandex_maps_jobs').update({ status: 'failed', error_message: 'watchdog' }).eq('id', 'job');
  await jest.advanceTimersByTimeAsync(30_000);
  await running;
  expect(parse).toHaveBeenCalledTimes(1);
  expect(mockDb.getRows('yandex_maps_jobs')[0]).toMatchObject({ status: 'failed', error_message: 'watchdog' });
});

it('keeps saved data and marks incomplete work failed after bounded network retries', async () => {
  parse.mockRejectedValue(new Error('request timeout'));
  await runYandexMapsParseOrganizations('job');
  expect(parse).toHaveBeenCalledTimes(2);
  expect(mockDb.getRows('yandex_maps_organizations')).toEqual([saved]);
  expect(mockDb.getRows('yandex_maps_jobs')[0]).toMatchObject({ status: 'failed', processed_organizations: 1 });
});

it('does not mark a short job completed when its final batch is blocked', async () => {
  parse.mockRejectedValue(new YandexMapsBlockedError('captcha'));
  await runYandexMapsParseOrganizations('job');
  expect(parse).toHaveBeenCalledTimes(2);
  expect(mockDb.getRows('yandex_maps_organizations')).toEqual([saved]);
  expect(mockDb.getRows('yandex_maps_jobs')[0]).toMatchObject({ status: 'failed', processed_organizations: 1 });
});

it('does not retry a persistence error and drains cancelled sibling requests before finalizing', async () => {
  // Proxy pools are cached per process; use a fresh worker for this scenario.
  jest.resetModules();
  const { runYandexMapsParseOrganizations: runParallel } = await import('@/lib/parsers/yandexMapsWorker');
  const parallelParse = (await import('@/lib/parsers/yandexMapsServiceClient')).yandexMapsParseOrgs as jest.Mock;
  process.env.YANDEXMAPS_PROXY_URLS = 'http://proxy-one.test:8080,http://proxy-two.test:8080';
  mockDb = createMockSupabase({
    tables: {
      yandex_maps_jobs: [{ ...job, config: { strict_max_results: true, max_results: 7 } }],
      yandex_maps_links: Array.from({ length: 7 }, (_, i) => ({ job_id: 'job', link: card(i + 1) })),
      yandex_maps_organizations: [{ ...saved }],
    },
    errorUpserts: { yandex_maps_organizations: { code: '57014', message: 'save timeout' } },
  });
  let aborted!: () => void;
  const didAbort = new Promise<void>((resolve) => { aborted = resolve; });
  let release!: () => void;
  parallelParse.mockImplementation(({ links }: { links: string[] }, signal: AbortSignal) => {
    if (links[0] === card(2)) return Promise.resolve({ organizations: [{ card_url: card(2), name: 'New' }] });
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        release = () => reject(signal.reason);
        aborted();
      }, { once: true });
    });
  });
  let finished = false;
  const running = runParallel('job').then(() => { finished = true; });
  await didAbort;
  expect(finished).toBe(false);
  release();
  await running;
  expect(parallelParse).toHaveBeenCalledTimes(2);
  expect(mockDb.getRows('yandex_maps_organizations')).toEqual([saved]);
  expect(mockDb.getRows('yandex_maps_jobs')[0]).toMatchObject({ status: 'failed', processed_organizations: 1 });
});
