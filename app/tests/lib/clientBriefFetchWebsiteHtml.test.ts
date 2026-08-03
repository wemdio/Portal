import { fetchWebsiteHtml, WebsiteFetchError } from '@/lib/clientBrief/autofill/fetchWebsiteHtml';

interface MockPage {
  status?: number;
  body?: string;
  location?: string;
  throwError?: Error;
}

type FetchCall = { url: string; init?: { headers?: Record<string, string>; redirect?: string } };

/**
 * Минимальный fetch-мок в стиле clientBriefRunCasesEnricher.test.ts:
 * без jsdom Response (флакает с .text()), только то что читает fetchOnce.
 * `responder` получает URL и init и решает, что вернуть — нужен для
 * stateful-сценариев (cookie меняет поведение сервера).
 */
function makeStatefulFetchMock(
  responder: (url: string, headers?: Record<string, string>) => MockPage,
): { fetchMock: jest.Mock; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchMock = jest.fn(
    async (input: RequestInfo | URL, init?: { headers?: Record<string, string>; redirect?: string }) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      const page = responder(url, init?.headers);
      if (page.throwError) throw page.throwError;
      const status = page.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => (name.toLowerCase() === 'location' ? page.location ?? null : null) },
        text: async () => page.body ?? '',
      } as unknown as Response;
    },
  );
  return { fetchMock, calls };
}

const HTTPS_URL = 'https://geo-sm.ru/';
const HTTP_URL = 'http://geo-sm.ru/';
const REAL_HTML = '<html><head><title>ГЕО СМ</title></head><body><h1>Геодезия и кадастр</h1></body></html>';
const BEGET_CHALLENGE =
  '<html><head><script>function set_cookie(){var now = new Date();' +
  "document.cookie='beget=begetok';}set_cookie();location.reload();</script></head><body></body></html>";

describe('fetchWebsiteHtml — https→http fallback', () => {
  it('обычный https-успех: один запрос, без fallback и cookie', async () => {
    const { fetchMock, calls } = makeStatefulFetchMock(() => ({ body: REAL_HTML }));
    const result = await fetchWebsiteHtml(HTTPS_URL, { fetchImpl: fetchMock });
    expect(result).toEqual({ url: HTTPS_URL, html: REAL_HTML });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(HTTPS_URL);
    expect(calls[0].init?.headers?.Cookie).toBeUndefined();
  });

  it('https упал сетевой ошибкой → fallback на http', async () => {
    const { fetchMock, calls } = makeStatefulFetchMock((url) =>
      url.startsWith('https://')
        ? { throwError: new TypeError('fetch failed') }
        : { body: REAL_HTML },
    );
    const result = await fetchWebsiteHtml(HTTPS_URL, { fetchImpl: fetchMock });
    expect(result.html).toBe(REAL_HTML);
    expect(calls.map((c) => c.url)).toEqual([HTTPS_URL, HTTP_URL]);
  });

  it('https ответил ошибочным статусом (403) → fallback НЕ выполняется', async () => {
    const { fetchMock, calls } = makeStatefulFetchMock(() => ({ status: 403 }));
    await expect(fetchWebsiteHtml(HTTPS_URL, { fetchImpl: fetchMock })).rejects.toThrow(
      'Сайт вернул HTTP 403',
    );
    expect(calls).toHaveLength(1);
  });
});

describe('fetchWebsiteHtml — Beget антибот-заглушка', () => {
  it('полный цикл: https мёртв → http-заглушка → cookie → 301 → https с cookie → сайт', async () => {
    const { fetchMock, calls } = makeStatefulFetchMock((url, headers) => {
      const hasCookie = headers?.Cookie === 'beget=begetok';
      if (!hasCookie && url.startsWith('https://')) {
        return { throwError: new TypeError('fetch failed') }; // 443 фильтруется без cookie
      }
      if (!hasCookie) return { body: BEGET_CHALLENGE }; // 80-й порт отдаёт заглушку
      if (url.startsWith('http://')) return { status: 301, location: HTTPS_URL }; // прошли → редирект на https
      return { body: REAL_HTML };
    });

    const result = await fetchWebsiteHtml(HTTPS_URL, { fetchImpl: fetchMock });

    expect(result).toEqual({ url: HTTPS_URL, html: REAL_HTML });
    expect(calls.map((c) => c.url)).toEqual([HTTPS_URL, HTTP_URL, HTTP_URL, HTTPS_URL]);
    // cookie пошла только после заглушки и на оба хопа (http → 301 → https)
    expect(calls[0].init?.headers?.Cookie).toBeUndefined();
    expect(calls[1].init?.headers?.Cookie).toBeUndefined();
    expect(calls[2].init?.headers?.Cookie).toBe('beget=begetok');
    expect(calls[3].init?.headers?.Cookie).toBe('beget=begetok');
    expect(calls[2].init?.redirect).toBe('manual');
  });

  it('заглушка повторяется даже с cookie → понятная ошибка про антибот', async () => {
    const { fetchMock } = makeStatefulFetchMock(() => ({ body: BEGET_CHALLENGE }));
    await expect(fetchWebsiteHtml(HTTPS_URL, { fetchImpl: fetchMock })).rejects.toThrow(
      /антибот-проверкой хостера \(Beget\)/,
    );
  });

  it('страница, похожая на заглушку, но без location.reload — не трогаем', async () => {
    const innocent = "<html><script>document.cookie='ab=cd';</script><body>контент</body></html>";
    const { fetchMock, calls } = makeStatefulFetchMock(() => ({ body: innocent }));
    const result = await fetchWebsiteHtml(HTTPS_URL, { fetchImpl: fetchMock });
    expect(result.html).toBe(innocent);
    expect(calls).toHaveLength(1);
  });
});

describe('fetchWebsiteHtml — прочее', () => {
  it('невалидный URL → WebsiteFetchError 400', async () => {
    await expect(fetchWebsiteHtml('javascript:alert(1)', { fetchImpl: jest.fn() })).rejects.toThrow(
      'Невалидный URL сайта',
    );
  });

  it('networkFailure помечен у сетевых сбоев и не помечен у HTTP-статусов', async () => {
    const netFail = makeStatefulFetchMock(() => ({ throwError: new TypeError('fetch failed') }));
    const err1 = await fetchWebsiteHtml('http://dead.example/', { fetchImpl: netFail.fetchMock }).catch(
      (e) => e,
    );
    expect(err1).toBeInstanceOf(WebsiteFetchError);
    expect((err1 as WebsiteFetchError).networkFailure).toBe(true);

    const statusFail = makeStatefulFetchMock(() => ({ status: 500 }));
    const err2 = await fetchWebsiteHtml('http://dead.example/', {
      fetchImpl: statusFail.fetchMock,
    }).catch((e) => e);
    expect(err2).toBeInstanceOf(WebsiteFetchError);
    expect((err2 as WebsiteFetchError).networkFailure).toBe(false);
  });
});
