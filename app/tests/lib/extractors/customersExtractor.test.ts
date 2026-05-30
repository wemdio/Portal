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

  it('filters out alts longer than 80 characters (likely captions, not company names)', () => {
    const longAlt = 'Эта компания очень крупный клиент работающий с нами с 2010 года и так далее — отзывы оставляют только положительные';
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

  it('drops metrics, form labels, roles, industries and article titles, keeping only real clients', () => {
    const html = `
      <section class="clients">
        <span>Сбербанк</span>
        <span>456 обращений в месяц</span>
        <span>Среднегодовая выручка:</span>
        <span>генеральный директор ООО «Перегородки в офис»</span>
        <span>Медицина</span>
        <span>Что такое AI маркетинг?</span>
        <span>реклама в яндекс директ</span>
        <span>Менеджер маркетплейсов</span>
        <span>Татьяна</span>
        <span>Газпром нефть</span>
      </section>
    `;

    const result = extractCustomers(html);

    expect(result).toEqual(expect.arrayContaining(['Сбербанк', 'Газпром нефть']));
    expect(result).not.toContain('456 обращений в месяц');
    expect(result).not.toContain('Среднегодовая выручка:');
    expect(result).not.toContain('Медицина');
    expect(result).not.toContain('Что такое AI маркетинг?');
    expect(result).not.toContain('реклама в яндекс директ');
    expect(result).not.toContain('Менеджер маркетплейсов');
    expect(result).not.toContain('Татьяна');
    expect(result.some((s) => s.includes('директор'))).toBe(false);
  });

  it('drops cities, countries and product-feature phrases, keeping only real clients', () => {
    const html = `
      <section class="clients">
        <span>Сбербанк</span>
        <span>Москва</span>
        <span>Нью-Йорк</span>
        <span>Соединенные Штаты Америки</span>
        <span>Вся команда в одном месте</span>
        <span>График активности и скорость ответа</span>
        <span>Крылатская ул.</span>
        <span>Тинькофф</span>
      </section>
    `;

    const result = extractCustomers(html);

    expect(result).toEqual(expect.arrayContaining(['Сбербанк', 'Тинькофф']));
    expect(result).not.toContain('Москва');
    expect(result).not.toContain('Нью-Йорк');
    expect(result).not.toContain('Соединенные Штаты Америки');
    expect(result).not.toContain('Вся команда в одном месте');
    expect(result).not.toContain('Крылатская ул.');
  });

  it('recovers the real brand from a leading CMS hash prefix', () => {
    const html = `
      <section class="clients">
        <img alt="ddec1ab1 verticali" src="/1.png" />
        <img alt="cfbaa2cdac8ff alfa money" src="/2.png" />
      </section>
    `;

    const result = extractCustomers(html);

    expect(result).toEqual(expect.arrayContaining(['verticali', 'alfa money']));
  });
});
