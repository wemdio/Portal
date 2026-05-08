/**
 * @jest-environment node
 *
 * Unit-тесты для эвристического детектора отраслей в кейсах.
 *
 * Pragma `@jest-environment node` обязательна — глобально в jest.config.js
 * стоит jsdom, а в jsdom-окружении cheerio резолвит свой browser-build (ESM),
 * который Jest не транспилирует, и тест падает с
 * `SyntaxError: Unexpected token 'export'` ещё до запуска assertion'ов.
 * Cheerio изначально предназначен для server-side HTML парсинга, тестировать
 * его в node-окружении правильнее и безопаснее.
 *
 * Цель — закрепить два контракта:
 *   1) Минимальный порог: одно случайное упоминание не делает отрасль (FP-защита).
 *   2) Сортировка по частоте: при наличии нескольких отраслей наверху самая частая.
 * Плюс sanity-check на пустой/мусорный input.
 */

import { extractCaseIndustries } from '@/lib/enrich/extractors/caseIndustriesExtractor';

describe('extractCaseIndustries', () => {
  it('returns empty for empty / too short html', () => {
    expect(extractCaseIndustries('')).toEqual([]);
    expect(extractCaseIndustries('<html></html>')).toEqual([]);
    expect(extractCaseIndustries('<html><body>abc</body></html>')).toEqual([]);
  });

  it('detects retail when "ритейл" / "магазин" appear multiple times', () => {
    const html = `
      <html><body>
        <h1>Кейсы</h1>
        <article>Внедрили автоматизацию для крупного ритейла. Сеть магазинов по всей РФ.</article>
        <article>Интернет-магазин одежды — рост конверсии в 3 раза.</article>
        <article>Маркетплейс электроники: интеграция с Wildberries.</article>
      </body></html>
    `;
    const result = extractCaseIndustries(html);
    expect(result).toContain('Ритейл и e-commerce');
  });

  it('does NOT pick a niche on a single mention', () => {
    const html = `
      <html><body>
        <article>Сделали проект для производственной компании.</article>
        <article>Ритейл, магазины, маркетплейс — наш конёк.</article>
      </body></html>
    `;
    const result = extractCaseIndustries(html);
    expect(result).toContain('Ритейл и e-commerce');
    // «производственн» встречается ровно раз — порог не пройден.
    expect(result).not.toContain('Промышленность');
  });

  it('sorts industries by frequency, most-mentioned first', () => {
    const html = `
      <html><body>
        <article>Банк, банк, финтех, страхование, лизинг.</article>
        <article>Магазин, ритейл.</article>
      </body></html>
    `;
    const result = extractCaseIndustries(html);
    expect(result[0]).toBe('Финансы и банки');
    expect(result).toContain('Ритейл и e-commerce');
    // Финансы должны идти раньше ритейла из-за большего числа упоминаний.
    expect(result.indexOf('Финансы и банки')).toBeLessThan(result.indexOf('Ритейл и e-commerce'));
  });

  it('caps result at 5 industries', () => {
    const html = `
      <html><body>
        <p>ритейл магазин ритейл</p>
        <p>банк финтех мфо</p>
        <p>производство завод</p>
        <p>медицина клиника</p>
        <p>образование школа</p>
        <p>логистика перевозки</p>
        <p>ресторан отель</p>
      </body></html>
    `;
    const result = extractCaseIndustries(html);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('strips nav/footer/script noise before counting', () => {
    // «строительство» в адресе в футере не должно тащить отрасль на отчёт.
    const html = `
      <html>
        <head>
          <script>const x = "строительство строительство строительство";</script>
        </head>
        <body>
          <nav>строительство по всему городу — соседний ЖК</nav>
          <footer>Адрес: улица Строительства 5, ЖК "Строительство нашего дома"</footer>
          <main>
            <article>Кейс с банком: миграция систем.</article>
          </main>
        </body>
      </html>
    `;
    const result = extractCaseIndustries(html);
    expect(result).not.toContain('Строительство и недвижимость');
  });
});
