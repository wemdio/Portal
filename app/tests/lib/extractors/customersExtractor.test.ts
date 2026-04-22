/** @jest-environment node */

import { extractCustomers } from '@/lib/enrich/extractors/customersExtractor';

describe('extractCustomers', () => {
  it('extracts company names from img alt in clients/customers/logos containers', () => {
    const html = `
      <section class="clients">
        <img alt="Сбербанк" src="/sber.png" />
        <img alt="Газпром" src="/gz.png" />
      </section>
      <div class="customer-logos">
        <img alt="Тинькофф" src="/t.png" />
      </div>
      <ul class="our-logos">
        <li><img alt="Альфа-Банк" src="/a.png" /></li>
      </ul>
    `;

    const result = extractCustomers(html);

    expect(result).toEqual(expect.arrayContaining(['Сбербанк', 'Газпром', 'Тинькофф', 'Альфа-Банк']));
    expect(result).toHaveLength(4);
  });

  it('extracts client names from case-card / client-card headings', () => {
    const html = `
      <div class="cases">
        <article class="case-card">
          <h3>Кейс: Лукойл</h3>
        </article>
        <article class="case-card">
          <h2>МТС</h2>
        </article>
        <article class="client-card">
          <h3>Магнит</h3>
        </article>
      </div>
    `;

    const result = extractCustomers(html);

    expect(result).toEqual(expect.arrayContaining(['Лукойл', 'МТС', 'Магнит']));
  });

  it('filters out generic/junk alt values', () => {
    const html = `
      <section class="clients">
        <img alt="logo" src="/1.png" />
        <img alt="image" src="/2.png" />
        <img alt="client logo" src="/3.png" />
        <img alt="" src="/4.png" />
        <img alt="logo01" src="/5.png" />
        <img alt="Сбербанк" src="/6.png" />
      </section>
    `;

    const result = extractCustomers(html);

    expect(result).toEqual(['Сбербанк']);
  });

  it('filters out alts longer than 60 characters (likely captions, not company names)', () => {
    const longAlt = 'Эта компания очень крупный клиент работающий с нами с 2010 года и так далее';
    const html = `
      <section class="clients">
        <img alt="${longAlt}" src="/long.png" />
        <img alt="Яндекс" src="/y.png" />
      </section>
    `;

    const result = extractCustomers(html);

    expect(result).toEqual(['Яндекс']);
  });

  it('deduplicates company names case-insensitively', () => {
    const html = `
      <section class="clients">
        <img alt="Сбербанк" src="/1.png" />
        <img alt="СБЕРБАНК" src="/2.png" />
        <img alt="сбербанк" src="/3.png" />
        <img alt="Газпром" src="/4.png" />
      </section>
    `;

    const result = extractCustomers(html);

    expect(result).toHaveLength(2);
    expect(result.map((s) => s.toLowerCase()).sort()).toEqual(['газпром', 'сбербанк']);
  });

  it('caps result at 30 unique names even when more are present', () => {
    const items = Array.from({ length: 50 }, (_, i) => `<img alt="Company${i}" src="/${i}.png" />`).join('');
    const html = `<section class="clients">${items}</section>`;

    const result = extractCustomers(html);

    expect(result).toHaveLength(30);
  });

  it('returns empty array when no client/customer markers are present', () => {
    const html = `
      <header><img alt="Site Logo" src="/logo.png" /></header>
      <main><p>Hello world</p></main>
    `;

    const result = extractCustomers(html);

    expect(result).toEqual([]);
  });
});
