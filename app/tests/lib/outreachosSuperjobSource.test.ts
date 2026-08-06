/** @jest-environment node */

import { fetchSuperjobEmployers } from '@/lib/outreachos/superjobSource';

const mockFetch = jest.fn();
(global as unknown as { fetch: typeof fetch }).fetch = mockFetch;

function vacanciesPage(objects: Array<{ id_client?: number; profession?: string }>, more: boolean) {
  return { ok: true, status: 200, json: async () => ({ objects, more }) } as Response;
}

function clientPage(c: { id: number; title?: string; url?: string; description?: string; town?: { title: string } }) {
  return { ok: true, status: 200, json: async () => c } as Response;
}

const OPTS = {
  apiKey: 'test-key',
  windowHours: 24,
  catalogues: [33],
  vacancyBudget: 8000,
  log: () => {},
};

beforeEach(() => jest.resetAllMocks());

describe('fetchSuperjobEmployers', () => {
  it('пагинация по 40 (кап SJ), стоп на неполной странице', async () => {
    const full = Array.from({ length: 40 }, (_, i) => ({ id_client: i + 1, profession: 'Dev' }));
    mockFetch
      .mockResolvedValueOnce(vacanciesPage(full, true)) // page 0
      .mockResolvedValueOnce(vacanciesPage([{ id_client: 999, profession: 'QA' }], false)); // page 1
    for (const id of [...Array(40).keys()].map(i => i + 1).concat(999)) {
      mockFetch.mockResolvedValueOnce(clientPage({ id, title: `C${id}`, url: `https://c${id}.ru` }));
    }
    const out = await fetchSuperjobEmployers(OPTS);
    const vacancyCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes('/vacancies/'));
    expect(vacancyCalls).toHaveLength(2);
    expect(out).toHaveLength(41);
  });

  it('дедуп по id_client, форма HhEmployer с префиксом sj_ и сайтом из url', async () => {
    mockFetch
      .mockResolvedValueOnce(vacanciesPage([
        { id_client: 1, profession: 'Разработчик' },
        { id_client: 1, profession: 'Тестировщик' },
        { id_client: 2, profession: 'Аналитик' },
      ], false))
      .mockResolvedValueOnce(clientPage({ id: 1, title: 'Ос Компания', url: ' https://os-company.ru ', description: '<b>Производим</b> станки', town: { title: 'Тула' } }))
      .mockResolvedValueOnce(clientPage({ id: 2, title: 'Вторая', url: '' }));
    const out = await fetchSuperjobEmployers(OPTS);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('sj_1');
    expect(out[0].name).toBe('Ос Компания');
    expect(out[0].siteUrl).toBe('https://os-company.ru');
    expect(out[0].description).toBe('Производим станки');
    expect(out[0].vacancyTitle).toBe('Разработчик');
    expect(out[0].industries).toEqual(['superjob:33']);
    expect(out[1].siteUrl).toBeNull();
  });

  it('ошибка одной карточки не валит остальные', async () => {
    mockFetch
      .mockResolvedValueOnce(vacanciesPage([{ id_client: 1 }, { id_client: 2 }], false))
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(clientPage({ id: 2, title: 'Живая', url: 'https://x.ru' }));
    const out = await fetchSuperjobEmployers(OPTS);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Живая');
  });

  it('403 от API (ключ/лимит) — ошибка после ретраев (caller ловит и идёт только с HH)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) } as Response);
    await expect(fetchSuperjobEmployers(OPTS)).rejects.toThrow('403');
  });

  it('несколько каталогов опрашиваются по очереди', async () => {
    mockFetch
      .mockResolvedValueOnce(vacanciesPage([{ id_client: 1 }], false))
      .mockResolvedValueOnce(vacanciesPage([{ id_client: 2 }], false))
      .mockResolvedValueOnce(clientPage({ id: 1, title: 'A', url: 'https://a.ru' }))
      .mockResolvedValueOnce(clientPage({ id: 2, title: 'B', url: 'https://b.ru' }));
    const out = await fetchSuperjobEmployers({ ...OPTS, catalogues: [33, 327] });
    const vacancyCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes('/vacancies/'));
    expect(vacancyCalls).toHaveLength(2);
    expect(String(vacancyCalls[0][0])).toContain('catalogues=33');
    expect(String(vacancyCalls[1][0])).toContain('catalogues=327');
    expect(out).toHaveLength(2);
  });
});
