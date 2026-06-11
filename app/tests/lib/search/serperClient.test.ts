/** @jest-environment node */
jest.mock('server-only', () => ({}));

import { serperSearch, hasSerperKey } from '@/lib/search/serperClient';

const ORIG_FETCH = global.fetch;
const ORIG_KEY = process.env.SERPER_API_KEY;

function withMockFetch(impl: (...a: unknown[]) => Promise<unknown>) {
  (global.fetch as unknown) = jest.fn().mockImplementation(impl);
}
function res(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => { process.env.SERPER_API_KEY = 'k'; });
afterEach(() => {
  global.fetch = ORIG_FETCH;
  if (ORIG_KEY === undefined) delete process.env.SERPER_API_KEY; else process.env.SERPER_API_KEY = ORIG_KEY;
  jest.clearAllMocks();
});

it('returns [] and does not call fetch without key', async () => {
  delete process.env.SERPER_API_KEY;
  const calls: unknown[] = [];
  withMockFetch(async (...a) => { calls.push(a); return res({ organic: [{ link: 'x' }] }); });
  expect(await serperSearch('q')).toEqual([]);
  expect(calls).toHaveLength(0);
  expect(hasSerperKey()).toBe(false);
});

it('returns only organic items that have a link', async () => {
  withMockFetch(async () => res({ organic: [{ link: 'https://t.me/x', title: 'X' }, { title: 'no link' }] }));
  expect(await serperSearch('q')).toEqual([{ link: 'https://t.me/x', title: 'X' }]);
});

it('returns [] on non-2xx', async () => {
  withMockFetch(async () => res({}, 429));
  expect(await serperSearch('q')).toEqual([]);
});

it('returns [] when fetch throws', async () => {
  withMockFetch(async () => { throw new Error('net'); });
  expect(await serperSearch('q')).toEqual([]);
});
