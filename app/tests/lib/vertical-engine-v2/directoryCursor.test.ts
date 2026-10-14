/** @jest-environment node */

/**
 * Закладка выдачи реестра. Без неё каждый добор начинал листать свой срез с
 * первой страницы, перелистывал уже собранное и однажды упирался в потолок
 * сканирования, после чего сегмент становился недостижимым навсегда.
 */
jest.mock('@/lib/companiesSearch/rpcSearch', () => ({ searchRows: jest.fn(), searchCount: jest.fn() }));

import { fetchDirectoryRows, mapDirectoryRow } from '@/lib/verticalEngineV2/stages/baseCollect';
import { searchRows } from '@/lib/companiesSearch/rpcSearch';
import type { VeStageContext } from '@/lib/verticalEngineV2/stages/shared';
import { createClient } from '@supabase/supabase-js';
import type { CompaniesSearchFilters } from '@/app/api/client/companies-search/route';
import { searchVeNicheDirectoryRows } from '@/lib/verticalEngineV2/nicheDirectory';
import { VE_PAYMENT_DIRECTORY_REVISION, vePaymentCompanyInns, vePaymentCompanyHint } from '@/lib/verticalEngineV2/paymentCompanyDirectory';

const ctx = {} as VeStageContext;
const empty = { inns: new Set<string>(), emails: new Set<string>(), receipts: new Set<string>(), websiteInns: new Map<string, Set<string>>() };
/** Полная страница выдачи: 1000 строк, как отдаёт RPC. */
const page = (from: number, size = 1000) => Array.from({ length: size }, (_, i) => ({
  name: `Компания ${from + i}`, inn: String(7700000000 + from + i), website: `https://c${from + i}.test/`, email: `mail@c${from + i}.test`,
}));

describe('закладка выдачи реестра', () => {
  beforeEach(() => jest.mocked(searchRows).mockReset());

  it('продолжает с сохранённого смещения, а не с первой страницы', async () => {
    jest.mocked(searchRows).mockImplementation(async (_f, limit, offset) => ({ rows: page(offset ?? 0, limit) }));
    const result = await fetchDirectoryRows(ctx, {}, 10, empty, 5_000);
    expect(jest.mocked(searchRows).mock.calls[0][2]).toBe(5_000);
    // Первая же страница даёт нужное: сканируем ровно 10 строк и на них встаём.
    expect(result.rows).toHaveLength(10);
    expect(result.nextOffset).toBe(5_010);
  });

  it('не перешагивает строки, которые не разобрал', async () => {
    // Страница на 1000 строк, а нужно всего 10: закладка обязана встать на
    // 10-й строке, иначе следующий заход потеряет 990 компаний.
    jest.mocked(searchRows).mockResolvedValue({ rows: page(0) });
    const first = await fetchDirectoryRows(ctx, {}, 10, empty);
    expect(first.nextOffset).toBe(10);

    const second = await fetchDirectoryRows(ctx, {}, 10, empty, first.nextOffset);
    expect(jest.mocked(searchRows).mock.calls[1][2]).toBe(10);
    expect(second.rows).toHaveLength(10);
  });

  it('пропущенные дубли двигают закладку наравне с взятыми', async () => {
    // Иначе уже собранные компании перечитывались бы вечно.
    jest.mocked(searchRows).mockResolvedValue({ rows: page(0, 5) });
    const excluded = { ...empty, emails: new Set(['mail@c0.test', 'mail@c1.test']) };
    const result = await fetchDirectoryRows(ctx, {}, 2, excluded);
    expect(result.excludedDuringFetch).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(result.nextOffset).toBe(4);
  });

  it('короткая страница означает исчерпание сегмента, а не потолок', async () => {
    jest.mocked(searchRows).mockResolvedValue({ rows: page(0, 3) });
    const result = await fetchDirectoryRows(ctx, {}, 50, empty);
    expect(result).toMatchObject({ exhausted: true, hitCeiling: false, nextOffset: 3 });
  });

  it('ошибка выдачи не двигает закладку', async () => {
    jest.mocked(searchRows).mockResolvedValue({ rows: [], error: 'rpc timeout' });
    const result = await fetchDirectoryRows(ctx, {}, 10, empty, 700);
    expect(result).toMatchObject({ error: 'rpc timeout', nextOffset: 700, exhausted: false, hitCeiling: false });

    const fetchNiche = jest.fn(async () => new Response(JSON.stringify({ message: 'registry unavailable' }),
      { status: 500, headers: { 'content-type': 'application/json' } }));
    const db = createClient('https://niche.test', 'local-test-key', { auth: { persistSession: false }, global: { fetch: fetchNiche } });
    for (const filters of [{}, { okvedCodes: ['64'] }]) {
      // Failure of either the registry or its dictionary must not return a
      // partial result, nor fall back to the ordinary unfiltered reader.
      await expect(searchVeNicheDirectoryRows(db, filters, ['финтех'], 100, 700))
        .resolves.toEqual({ rows: [], error: 'registry unavailable' });
    }
    expect(fetchNiche).toHaveBeenCalledTimes(2);
    fetchNiche.mockResolvedValueOnce(new Response(JSON.stringify([
      { id: 1, name: 'Финтех', okved_code: '64', okved_code_exact: null },
    ]), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(searchVeNicheDirectoryRows(db, {}, ['финтех'], 100, 700))
      .resolves.toEqual({ rows: [], error: 'registry unavailable' });
    // Do not publish nameless partial output when the activity lookup fails.
    expect(fetchNiche).toHaveBeenCalledTimes(4);
    await expect(searchVeNicheDirectoryRows(db, {}, ['финтех'], 100, 700, AbortSignal.abort()))
      .resolves.toMatchObject({ rows: [], error: expect.any(String) });
    expect(fetchNiche).toHaveBeenCalledTimes(4);
    expect(searchRows).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    const cancelledDb = createClient('https://niche.test', 'local-test-key', { auth: { persistSession: false }, global: {
      fetch: async (_input, init) => {
        controller.abort();
        init?.signal?.throwIfAborted();
        throw new Error('Cancellation was not propagated');
      },
    } });
    await expect(searchVeNicheDirectoryRows(cancelledDb, {}, ['финтех'], 100, 700, controller.signal))
      .resolves.toMatchObject({ rows: [], error: expect.stringContaining('AbortError') });
  });

  it('отдаёт разобранный префикс и закладку по нему, когда выдача оборвалась посреди лейна', async () => {
    // Прод 21.09, база 3cd77243: шлюз реестра отвалился после 10 590
    // просмотренных строк. Строки префикса разобраны нормально — отдавать их
    // вместе со смещением честно, а выбрасывать значит платить за них снова.
    jest.mocked(searchRows).mockImplementation(async (_f, limit, offset) => ((offset ?? 0) >= 2_000
      ? { rows: [], error: 'The upstream server is timing out' }
      : { rows: page(offset ?? 0, limit) }));
    const result = await fetchDirectoryRows(ctx, {}, 10_000, empty);
    expect(result.error).toBe('The upstream server is timing out');
    expect(result.rows).toHaveLength(2_000);
    expect(result).toMatchObject({ nextOffset: 2_000, exhausted: false, hitCeiling: false });
  });
});

describe('строка реестра', () => {
  it('отдаёт название вида деятельности и отрасль, а не только код', async () => {
    // Классификатор и первичная проверка читают category как текст. Код
    // «28.30» не говорит им ничего, из-за чего компании из реестра массово
    // оставались без вердикта.
    const row = mapDirectoryRow({
      name: 'ООО "Ромашка"', inn: '7700000001', website: 'https://romashka.ru', email: 'info@romashka.ru',
      okved_code: '28.30', okved_name: 'Производство машин и оборудования для сельского и лесного хозяйства',
      activity_type: 'Сельхозтехника', address: 'Тула', employees_count: 120, revenue: 500000000, phones: '+7 999 000-00-00, +7 999 111-11-11',
    });
    expect(row.category.split('\n')).toEqual([
      'Производство машин и оборудования для сельского и лесного хозяйства',
      'Сельхозтехника',
      '28.30',
    ]);
    // Остальное разбирается как раньше: телефон — первый из списка.
    expect(row).toMatchObject({ company: 'ООО "Ромашка"', inn: '7700000001', phone: '+7 999 000-00-00', source_detail: 'реестр' });

    const requests: URL[] = [];
    const fetchNiche: typeof fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      requests.push(url);
      const data = url.pathname.endsWith('/companies_directory')
        ? [{ id: 1, name: 'Финтех пример', okved_code: '62', okved_code_exact: '64.19',
          activity_type: 'Платежи', email: 'mail@payments.test', website: 'payments.test' },
        { id: 2, name: 'Платёжный пример', okved_code: '64.1', okved_code_exact: null }]
        : url.searchParams.get('select') === 'code,parent_code'
          ? [{ code: '64', parent_code: 'K' }, { code: '64.1', parent_code: '64' }, { code: '64.19', parent_code: '64.1' },
            { code: '64.9', parent_code: 'missing' }]
          : [{ code: '64.19', name: 'Денежное посредничество' }, { code: '64.1', name: 'Посредничество' }];
      return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const db = createClient('https://niche.test', 'local-test-key', { auth: { persistSession: false }, global: { fetch: fetchNiche } });
    const filters: CompaniesSearchFilters = { okvedCodes: ['64'], regionCodes: ['77'], includeIp: false,
      hasEmail: true, hasWebsite: true, revenueFrom: 100, revenueTo: 200, employeesFrom: 2, employeesTo: 20 };
    const found = await searchVeNicheDirectoryRows(db, filters, ['финтех', 'pay'], 100, 200);
    expect(found.error).toBeUndefined();
    expect(found.rows[0]).toMatchObject({ okved_code: '64.19', okved_code_mapped: '62', okved_name: 'Денежное посредничество' });
    expect(found.rows[1]).toMatchObject({ okved_code: '64.1', okved_code_mapped: '64.1', okved_name: 'Посредничество' });
    expect(mapDirectoryRow(found.rows[0])).toMatchObject({ company: 'Финтех пример', email: 'mail@payments.test',
      website: 'payments.test', category: 'Денежное посредничество\nПлатежи\n64.19' });
    const request = requests.find((url) => url.pathname.endsWith('/companies_directory'))!;
    // Query the intersection of name AND activity. Two .or calls would let
    // PostgREST replace one predicate and silently buy an unrelated slice.
    expect(request.searchParams.getAll('or')).toEqual(['(and(or(name.ilike.*финтех*,name.ilike.*pay*),'
      + 'or(okved_code_exact.like.64*,and(okved_code_exact.is.null,okved_code.in.(64,64.1,64.19)))))']);
    expect(request.searchParams.get('region_code')).toBe('in.(77)');
    expect(request.searchParams.get('name')).toBe('not.ilike.ИП %');
    expect(request.searchParams.get('email')).toBe('not.is.null');
    expect(request.searchParams.get('website')).toBe('not.is.null');
    expect(request.searchParams.getAll('revenue')).toEqual(['gte.100', 'lte.200']);
    expect(request.searchParams.getAll('employees_count')).toEqual(['gte.2', 'lte.20']);
    expect([request.searchParams.get('offset'), request.searchParams.get('limit'), request.searchParams.get('order')])
      .toEqual(['200', '100', 'id.asc']);

    // Provider identities reach the same bounded reader even when the legal
    // name is neutral or its exact OKVED lies outside finance/IT. The catalog
    // is a source hint, not permission to bypass the specialist's filters.
    const providerRequests: URL[] = [];
    const providerDb = createClient('https://niche.test', 'local-test-key', { auth: { persistSession: false }, global: {
      fetch: async (input) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        providerRequests.push(url);
        const data = url.pathname.endsWith('/companies_directory') ? [
          { id: 4, inn: '7723887394', name: 'ООО ПЭЙМАСТЕР', website: 'unrelated.test', email: 'wrong@unrelated.test', okved_code: '82.99', okved_code_exact: '82.99' },
          { id: 5, inn: '2536154341', name: 'ООО АРСЕНАЛ МЕДИА', website: null, okved_code: '62.02', okved_code_exact: '62.02' },
          { id: 6, inn: '7700000111', name: 'Неизвестная компания', website: 'untouched.test', okved_code: '64', okved_code_exact: '64' },
        ] : url.searchParams.get('select') === 'code,parent_code' ? [{ code: '64', parent_code: 'K' }] : [];
        return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    } });
    const providerResult = await searchVeNicheDirectoryRows(providerDb,
      { ...filters, identityCatalog: VE_PAYMENT_DIRECTORY_REVISION }, ['пэй', 'пей'], 100, 200);
    expect(providerResult.error).toBeUndefined();
    expect(providerResult.rows[0]).toMatchObject({ inn: '7723887394', website: 'unrelated.test', okved_code: '82.99' });
    expect(mapDirectoryRow(providerResult.rows[0])).toMatchObject({ inn: '7723887394', website: vePaymentCompanyHint('7723887394')!.website, email: '' });
    expect(mapDirectoryRow(providerResult.rows[0]).source_detail).toContain('wrong@unrelated.test');
    expect(mapDirectoryRow(providerResult.rows[1])).toMatchObject({ inn: '2536154341', website: vePaymentCompanyHint('2536154341')!.website });
    expect(providerResult.rows[2].website).toBe('untouched.test');
    const providerRequest = providerRequests.find((url) => url.pathname.endsWith('/companies_directory'))!;
    const identities = `inn.in.(${vePaymentCompanyInns().join(',')})`;
    expect(providerRequest.searchParams.getAll('or')).toEqual([
      `(and(or(${identities},and(or(name.ilike.*пэй*,name.ilike.*пей*),or(okved_code_exact.like.64*,and(okved_code_exact.is.null,okved_code.in.(64))))),or(website.not.is.null,${identities})))`,
    ]);
    expect(providerRequest.searchParams.get('website')).toBeNull();
    for (const key of ['region_code', 'name', 'email', 'revenue', 'employees_count', 'order', 'limit', 'offset']) {
      expect(providerRequest.searchParams.getAll(key)).toEqual(request.searchParams.getAll(key));
    }
    const beforeInvalid = requests.length;
    for (const terms of [[], ['*'], ['fin,or(name.not.is.null)'], ['a b'], ['xx'], ['x'.repeat(41)], Array(13).fill('pay')]) {
      await expect(searchVeNicheDirectoryRows(db, filters, terms, 100)).resolves.toMatchObject({ rows: [], error: expect.any(String) });
    }
    for (const bad of [{ ...filters, hasPhone: true }, { ...filters, okvedCodes: ['64,62'] },
      { ...filters, employeesFrom: 1.5 }, { ...filters, identityCatalog: 'arbitrary-provider-list' as typeof VE_PAYMENT_DIRECTORY_REVISION }]) {
      await expect(searchVeNicheDirectoryRows(db, bad, ['pay'], 100)).resolves.toMatchObject({ rows: [], error: expect.any(String) });
    }
    await expect(searchVeNicheDirectoryRows(db, filters, ['pay'], 1001)).resolves.toMatchObject({ rows: [], error: expect.any(String) });
    await expect(searchVeNicheDirectoryRows(db, filters, ['pay'], 100, 200001)).resolves.toMatchObject({ rows: [], error: expect.any(String) });
    expect(requests).toHaveLength(beforeInvalid);
  });

  it('обходится одним кодом, если справочник ничего не дал', () => {
    const row = mapDirectoryRow({ name: 'ООО "Пустышка"', okved_code: '62.01' });
    expect(row.category).toBe('62.01');
  });
});
