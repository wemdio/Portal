/**
 * @jest-environment node
 *
 * Regression: anti-junk list from the 44k row CSV exported 04.06
 * (промежуточные результаты.txt). At that point the «Клиенты» column
 * contained things like "arrow", "gallery grid 1 x", "card img", "visa",
 * "DSC 1 scaled" etc. — alt-text of decorative images, payment icons,
 * Tilda CMS thumbnails. None of these are client company names.
 *
 * Every string here must NOT survive extractCustomers when wrapped in a
 * client-section container — they should all be filtered by JUNK_PATTERNS.
 * Real brand names mixed in MUST still be picked up (precision improves
 * without sacrificing recall).
 */

import { extractCustomers } from '@/lib/enrich/extractors/customersExtractor';

const REAL_JUNK_FROM_PROD: ReadonlyArray<string> = [
  // Arrow / dot / chevron decorations
  'arrow', 'arrow 1', 'dot', 'bullet',
  'chevron left', 'chevron right 2', 'chevron next',
  // Tilda gallery grid alt-text — '1 2 1 x', 'gallery grid 9 x', etc.
  'gallery grid 1 x', 'gallery grid 2 x', 'gallery grid 9 x', 'gallery grid x',
  'grid x', 'grid 2 x',
  '1 2 1 x', '0 2 x', '1 9 x', '1 8 x', '1 7 x', '1 4 x',
  // Payment system icons
  'card img', 'payment visa', 'visa', 'mir', 'master', 'maestro',
  'apple pay', 'google pay', 'sberpay',
  // Tilda CMS thumbnail filenames
  'poselok na sokole thumb', 'barinhaus1 thumb', 'milenium park1 thumb',
  'sad burcevo thumb', 'sosnovybor thumb', 'semejnysad thumb',
  // Section labels mistakenly captured as «brand»
  'Соглашение компании «GREEN DELUXE»',
  // Camera filenames
  'DSC 1 scaled', 'IMG 0123', 'IMG_4567 scaled',
  // Background CSS classes
  'bg color 1', 'main bg', 'section bg',
];

describe('extractCustomers — junk filter (04.06 prod regression)', () => {
  for (const junk of REAL_JUNK_FROM_PROD) {
    it(`drops "${junk}"`, () => {
      const safeAlt = junk.replace(/"/g, '&quot;');
      const html = `<section class="clients"><img alt="${safeAlt}"/></section>`;
      expect(extractCustomers(html)).not.toContain(junk);
    });
  }

  it('still picks real brands mixed in with junk alts (no recall regression)', () => {
    const html = `
      <section class="clients">
        <img alt="arrow"/>
        <img alt="gallery grid 1 x"/>
        <img alt="Volkswagen"/>
        <img alt="card img"/>
        <img alt="Сбербанк"/>
        <img alt="visa"/>
        <img alt="Газпром"/>
        <img alt="DSC 1 scaled"/>
      </section>
    `;
    const result = extractCustomers(html);
    expect(result).toEqual(expect.arrayContaining(['Volkswagen', 'Сбербанк', 'Газпром']));
    // Junk должен быть полностью отфильтрован.
    expect(result).not.toContain('arrow');
    expect(result).not.toContain('gallery grid 1 x');
    expect(result).not.toContain('card img');
    expect(result).not.toContain('visa');
    expect(result).not.toContain('DSC 1 scaled');
  });

  it('reads brands from a new RU section heading «их выбирают»', () => {
    // Раньше эту секцию мы пропускали (regex её не знал) — а это самый
    // частый русский headline для logo wall'а. Покрытие повышаем.
    const html = `
      <h2>Их выбирают</h2>
      <div>
        <img alt="МТС"/>
        <img alt="Билайн"/>
        <img alt="Yandex"/>
      </div>
    `;
    const result = extractCustomers(html);
    expect(result).toEqual(expect.arrayContaining(['МТС', 'Билайн', 'Yandex']));
  });

  it('reads brands from a generic "brands" container (added selector)', () => {
    const html = `
      <section class="brands">
        <img alt="Tesla"/>
        <img alt="BMW"/>
      </section>
    `;
    expect(extractCustomers(html)).toEqual(expect.arrayContaining(['Tesla', 'BMW']));
  });
});
