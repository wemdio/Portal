/** @jest-environment node */
jest.mock('server-only', () => ({}));

import { findCompanySocials } from '@/lib/enrich/extractors/socialCompanyFinder';

const ORIG_FETCH = global.fetch;
const ORIG_KEY = process.env.SERPER_API_KEY;

// Роутим мок по URL: запросы к serper.dev → организик; всё прочее → HEAD-проверка.
function route(handlers: { serper: () => unknown; head: (url: string) => unknown }) {
  (global.fetch as unknown) = jest.fn().mockImplementation((url: unknown) => {
    const u = String(url);
    if (u.includes('serper.dev')) return Promise.resolve(handlers.serper());
    return Promise.resolve(handlers.head(u));
  });
}
function serperRes(organic: unknown) {
  return { ok: true, status: 200, json: async () => ({ organic }) };
}

beforeEach(() => { process.env.SERPER_API_KEY = 'k'; });
afterEach(() => {
  global.fetch = ORIG_FETCH;
  if (ORIG_KEY === undefined) delete process.env.SERPER_API_KEY; else process.env.SERPER_API_KEY = ORIG_KEY;
  jest.clearAllMocks();
});

it('returns [] without a serper key', async () => {
  delete process.env.SERPER_API_KEY;
  expect(await findCompanySocials('Acme', 'acme.ru')).toEqual([]);
});

it('finds a company telegram channel matching the domain', async () => {
  route({
    serper: () => serperRes([{ link: 'https://t.me/acme_official', title: 'Acme', snippet: 'acme.ru — наш канал' }]),
    head: () => ({ ok: true }),
  });
  expect(await findCompanySocials('Acme', 'acme.ru')).toEqual(['https://t.me/acme_official']);
});

it('rejects an unrelated channel (no name/domain match)', async () => {
  route({
    serper: () => serperRes([{ link: 'https://t.me/random_news', title: 'Случайный', snippet: 'ни при чём' }]),
    head: () => ({ ok: true }),
  });
  expect(await findCompanySocials('Acme', 'acme.ru')).toEqual([]);
});

it('drops a matched but unreachable channel', async () => {
  route({
    serper: () => serperRes([{ link: 'https://t.me/acme_dead', title: 'Acme', snippet: 'acme.ru' }]),
    head: () => ({ ok: false }),
  });
  expect(await findCompanySocials('Acme', 'acme.ru')).toEqual([]);
});

it('drops bots even if returned by search', async () => {
  route({
    serper: () => serperRes([{ link: 'https://t.me/acme_bot', title: 'Acme', snippet: 'acme.ru' }]),
    head: () => ({ ok: true }),
  });
  expect(await findCompanySocials('Acme', 'acme.ru')).toEqual([]);
});
