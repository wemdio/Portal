import {
  discoverSubpages,
  pickKind,
  resolveSameOriginUrl,
} from '@/lib/clientBrief/autofill/discoverSubpages';

describe('resolveSameOriginUrl', () => {
  const base = 'https://acme.com/';

  it('возвращает абсолютный URL для относительной ссылки', () => {
    expect(resolveSameOriginUrl('/cases', base)).toBe('https://acme.com/cases');
    expect(resolveSameOriginUrl('cases/123', base)).toBe('https://acme.com/cases/123');
  });

  it('режет фрагмент', () => {
    expect(resolveSameOriginUrl('/cases#top', base)).toBe('https://acme.com/cases');
  });

  it('пропускает same-origin абсолютные ссылки', () => {
    expect(resolveSameOriginUrl('https://acme.com/cases', base)).toBe('https://acme.com/cases');
  });

  it('пропускает www-варианты как тот же origin', () => {
    expect(resolveSameOriginUrl('https://www.acme.com/cases', base)).toBe('https://www.acme.com/cases');
  });

  it('отбрасывает чужой домен', () => {
    expect(resolveSameOriginUrl('https://other.com/cases', base)).toBeNull();
  });

  it('отбрасывает mailto/tel/javascript/якоря', () => {
    expect(resolveSameOriginUrl('mailto:a@b.com', base)).toBeNull();
    expect(resolveSameOriginUrl('tel:+7900', base)).toBeNull();
    expect(resolveSameOriginUrl('javascript:void(0)', base)).toBeNull();
    expect(resolveSameOriginUrl('#section', base)).toBeNull();
  });

  it('отбрасывает не-http протоколы', () => {
    expect(resolveSameOriginUrl('ftp://acme.com/x', base)).toBeNull();
  });

  it('возвращает null для невалидного base', () => {
    expect(resolveSameOriginUrl('/cases', 'not-a-url')).toBeNull();
  });
});

describe('discoverSubpages', () => {
  const base = 'https://acme.ru/';

  it('находит /cases по URL-паттерну', () => {
    const html = `
      <html><body>
        <a href="/about">О нас</a>
        <a href="/cases">Кейсы</a>
        <a href="/contacts">Контакты</a>
      </body></html>
    `;
    const result = discoverSubpages({ baseUrl: base, homepageHtml: html });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('cases');
    expect(result[0].url).toBe('https://acme.ru/cases');
    expect(result[0].source).toBe('nav');
  });

  it('находит кейсы только по тексту ссылки если URL-паттерн не сработал', () => {
    const html = `
      <html><body>
        <a href="/p/showcase">Наши кейсы</a>
      </body></html>
    `;
    const result = discoverSubpages({ baseUrl: base, homepageHtml: html });
    expect(result.some((c) => c.kind === 'cases')).toBe(true);
  });

  it('классифицирует разные типы: cases / reviews / press / awards / faq', () => {
    const html = `
      <html><body>
        <a href="/cases">Кейсы</a>
        <a href="/reviews">Отзывы клиентов</a>
        <a href="/press">СМИ о нас</a>
        <a href="/awards">Наши награды</a>
        <a href="/faq">FAQ</a>
        <a href="/contacts">Контакты</a>
      </body></html>
    `;
    const result = discoverSubpages({ baseUrl: base, homepageHtml: html });
    const kinds = new Set(result.map((c) => c.kind));
    expect(kinds.has('cases')).toBe(true);
    expect(kinds.has('reviews')).toBe(true);
    expect(kinds.has('press')).toBe(true);
    expect(kinds.has('awards')).toBe(true);
    expect(kinds.has('faq')).toBe(true);
  });

  it('сортирует кандидатов внутри kind по score (desc)', () => {
    const html = `
      <html><body>
        <a href="/some-page">Где-то про проекты</a>
        <a href="/cases">Наши кейсы</a>
      </body></html>
    `;
    const result = discoverSubpages({ baseUrl: base, homepageHtml: html });
    const cases = pickKind(result, 'cases');
    expect(cases.length).toBeGreaterThanOrEqual(1);
    expect(cases[0].url).toBe('https://acme.ru/cases');
  });

  it('применяет maxUrlsPerKind', () => {
    const html = `
      <html><body>
        <a href="/cases">Кейсы</a>
        <a href="/cases/1">Кейс 1</a>
        <a href="/cases/2">Кейс 2</a>
        <a href="/cases/3">Кейс 3</a>
        <a href="/cases/4">Кейс 4</a>
      </body></html>
    `;
    const result = discoverSubpages(
      { baseUrl: base, homepageHtml: html },
      { maxUrlsPerKind: 2 },
    );
    const cases = pickKind(result, 'cases');
    expect(cases.length).toBeLessThanOrEqual(2);
  });

  it('применяет maxTotalUrls и сохраняет хотя бы по одному на kind', () => {
    const html = `
      <html><body>
        <a href="/cases/1">Кейс 1</a>
        <a href="/cases/2">Кейс 2</a>
        <a href="/cases/3">Кейс 3</a>
        <a href="/reviews">Отзывы</a>
        <a href="/press">СМИ о нас</a>
        <a href="/awards">Награды</a>
        <a href="/faq">FAQ</a>
      </body></html>
    `;
    const result = discoverSubpages(
      { baseUrl: base, homepageHtml: html },
      { maxTotalUrls: 5, maxUrlsPerKind: 3 },
    );
    expect(result.length).toBeLessThanOrEqual(5);
    // Каждый из 5 типов должен быть представлен хотя бы одним URL
    expect(pickKind(result, 'cases').length).toBeGreaterThan(0);
    expect(pickKind(result, 'reviews').length).toBeGreaterThan(0);
    expect(pickKind(result, 'press').length).toBeGreaterThan(0);
    expect(pickKind(result, 'awards').length).toBeGreaterThan(0);
    expect(pickKind(result, 'faq').length).toBeGreaterThan(0);
  });

  it('дедупит дубликаты ссылок', () => {
    const html = `
      <html><body>
        <a href="/cases">Кейсы (хедер)</a>
        <a href="/cases">Кейсы (футер)</a>
        <a href="/cases#anchor">Кейсы с якорем</a>
      </body></html>
    `;
    const result = discoverSubpages({ baseUrl: base, homepageHtml: html });
    expect(pickKind(result, 'cases').length).toBe(1);
  });

  it('игнорирует ссылки на чужие домены', () => {
    const html = `
      <html><body>
        <a href="https://other.com/cases">Чужие кейсы</a>
        <a href="https://vk.com/group">Соцсеть</a>
      </body></html>
    `;
    const result = discoverSubpages({ baseUrl: base, homepageHtml: html });
    expect(result).toHaveLength(0);
  });

  it('подхватывает URL из sitemap.xml', () => {
    const html = '<html><body><a href="/about">О нас</a></body></html>';
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset>
        <url><loc>https://acme.ru/cases/big-project</loc></url>
        <url><loc>https://acme.ru/contacts</loc></url>
      </urlset>`;
    const result = discoverSubpages({
      baseUrl: base,
      homepageHtml: html,
      sitemapXml: sitemap,
    });
    const cases = pickKind(result, 'cases');
    expect(cases.length).toBeGreaterThan(0);
    expect(cases[0].source).toBe('sitemap');
  });

  it('предпочитает nav-якорь sitemap для того же URL (попадает только один раз)', () => {
    const html = '<html><body><a href="/cases">Кейсы</a></body></html>';
    const sitemap = '<urlset><url><loc>https://acme.ru/cases</loc></url></urlset>';
    const result = discoverSubpages({
      baseUrl: base,
      homepageHtml: html,
      sitemapXml: sitemap,
    });
    const cases = pickKind(result, 'cases');
    expect(cases.length).toBe(1);
    expect(cases[0].source).toBe('nav');
  });

  it('возвращает пустой массив на пустом html', () => {
    const result = discoverSubpages({ baseUrl: base, homepageHtml: '' });
    expect(result).toEqual([]);
  });

  it('извлекает alt из <img>-иконки внутри <a>', () => {
    const html = `
      <html><body>
        <a href="/p/works"><img src="/i.svg" alt="Наши кейсы"></a>
      </body></html>
    `;
    const result = discoverSubpages({ baseUrl: base, homepageHtml: html });
    expect(pickKind(result, 'cases').length).toBe(1);
  });
});
