/**
 * @jest-environment node
 *
 * Guard for «Проверка сайтов» (stepSiteCheck): when the «сайт» column doesn't
 * actually hold sites (e.g. emails or company names got mapped there), the step
 * used to fetch each value as a URL, find them all dead, and DELETE every row —
 * silently emptying the client's base (real case: reelscut, 94 rows → 0).
 * The guard now throws a clear error instead, leaving the input untouched.
 */
import { looksLikeSite, stepSiteCheck, isNonScrapeableHost } from '@/lib/tools/processingSteps';

const noop = async () => {};

describe('isNonScrapeableHost (never scrape hh.ru / job boards)', () => {
  it('blocks hh.ru and job boards (incl. subdomains, protocol, www, paths)', () => {
    for (const u of [
      'hh.ru', 'https://hh.ru/vacancy/123', 'spb.hh.ru', 'https://www.hh.ru/employer/9',
      'headhunter.ru', 'superjob.ru', 'rabota.ru', 'https://zarplata.ru/x', 'trudvsem.ru',
    ]) {
      expect(isNonScrapeableHost(u)).toBe(true);
    }
  });

  it('does NOT block real company sites or look-alike domains', () => {
    for (const u of [
      'company.com', 'https://betaonline.ru', 'evil-hh.ru', 'myhh.ru',
      'mycompany.com/hh.ru', '', 'not a url',
    ]) {
      expect(isNonScrapeableHost(u)).toBe(false);
    }
  });
});

describe('looksLikeSite', () => {
  it('recognizes real domains / urls (incl. .рф, paths, protocol, case)', () => {
    for (const s of [
      'company.com', 'https://company.com/path', 'www.studio.ru', 'a.io',
      'под.домен.firm.com', 'студия.рф', 'HTTP://X.RU', 'shop.example.co.uk',
    ]) {
      expect(looksLikeSite(s)).toBe(true);
    }
  });

  it('rejects emails, names, empty and junk', () => {
    for (const s of [
      'ivan@company.ru', 'sales@x.com', 'ООО Ромашка', 'Видеостудия',
      '', '   ', '123', 'no-dot-here',
    ]) {
      expect(looksLikeSite(s)).toBe(false);
    }
  });
});

describe('stepSiteCheck guard', () => {
  it('throws (does NOT empty the base) when «сайт» holds emails', async () => {
    const data = [
      ['компания', 'сайт'],
      ['A', 'a@x.ru'], ['B', 'b@x.ru'], ['C', 'c@x.ru'],
      ['D', 'd@x.ru'], ['E', 'e@x.ru'], ['F', 'f@x.ru'],
    ];
    await expect(stepSiteCheck(data, noop)).rejects.toThrow(/не похожа на сайты/);
  });

  it('throws when «сайт» holds plain company names', async () => {
    const data = [
      ['компания', 'сайт'],
      ['1', 'Студия Один'], ['2', 'Студия Два'], ['3', 'Студия Три'],
      ['4', 'Студия Четыре'], ['5', 'Студия Пять'],
    ];
    await expect(stepSiteCheck(data, noop)).rejects.toThrow(/Проверка сайтов/);
  });

  it('returns data unchanged when there is no «сайт» column', async () => {
    const data = [['компания', 'email'], ['A', 'a@x.ru']];
    const out = await stepSiteCheck(data, noop);
    expect(out).toEqual(data);
  });

  it('does NOT fire on a real site column — keeps reachable rows (legit base intact)', async () => {
    const fetchMock = jest
      .spyOn(global as unknown as { fetch: typeof fetch }, 'fetch')
      .mockResolvedValue({ status: 200 } as Response);
    try {
      const data = [
        ['компания', 'сайт'],
        ['A', 'a.ru'], ['B', 'b.com'], ['C', 'https://c.io'],
        ['D', 'www.d.рф'], ['E', 'e.org'], ['F', 'f.net'],
      ];
      const out = await stepSiteCheck(data, noop);
      expect(out.length).toBe(data.length); // header + all 6 kept (200 OK)
      expect(out[0]).toEqual(['компания', 'сайт']);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
