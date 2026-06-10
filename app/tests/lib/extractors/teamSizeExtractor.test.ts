/** @jest-environment node */

import { extractTeamSize } from '@/lib/enrich/extractors/teamSizeExtractor';

describe('extractTeamSize', () => {
  it('counts items by typical team-member class patterns', () => {
    const html = `
      <section class="team">
        <div class="member-card"><img alt="Иван" /><h4>Иван</h4></div>
        <div class="member-card"><img alt="Мария" /><h4>Мария</h4></div>
        <div class="employee"><h4>Алексей</h4></div>
      </section>
    `;

    expect(extractTeamSize(html)).toBe(3);
  });

  it('counts photo-only team members (when no card wrapper)', () => {
    const html = `
      <section class="team">
        <img alt="Member 1" src="/m1.jpg" />
        <img alt="Member 2" src="/m2.jpg" />
        <img alt="Member 3" src="/m3.jpg" />
      </section>
    `;

    expect(extractTeamSize(html)).toBe(3);
  });

  it('returns 0 when strict team selector blows past the trust limit without a textual claim — almost always a CMS false positive (LLM fallback runs instead)', () => {
    const items = Array.from({ length: 500 }, () => `<div class="member-card">x</div>`).join('');
    const html = `<main>${items}</main>`;

    expect(extractTeamSize(html)).toBe(0);
  });

  it('trusts a high team-photo count only when corroborated by text', () => {
    const photos = Array.from({ length: 60 }, (_, i) => `<img alt="Member ${i}" src="/m${i}.jpg" />`).join('');
    const html = `<section class="team"><p>Команда из 45 человек</p>${photos}</section>`;

    // Loose-selector count 60 is above its 30-photo trust limit; the text
    // claim of "45 человек" wins.
    expect(extractTeamSize(html)).toBe(45);
  });

  it('returns 0 when no team-related markup is present', () => {
    const html = `<article><h1>About</h1></article>`;

    expect(extractTeamSize(html)).toBe(0);
  });

  it('extracts team_size from JSON-LD numberOfEmployees (nested QuantitativeValue)', () => {
    const html = `<script type="application/ld+json">
      {"@type":"Organization","numberOfEmployees":{"@type":"QuantitativeValue","value":"42"}}
    </script>`;
    expect(extractTeamSize(html)).toBe(42);
  });

  it('extracts team_size from JSON-LD numberOfEmployees (flat numeric)', () => {
    const html = `<script type="application/ld+json">
      {"@type":"Organization","numberOfEmployees":85}
    </script>`;
    expect(extractTeamSize(html)).toBe(85);
  });

  it('extracts team_size from microdata itemprop="numberOfEmployees"', () => {
    expect(extractTeamSize(`<meta itemprop="numberOfEmployees" content="120">`)).toBe(120);
    expect(extractTeamSize(`<span itemprop="numberOfEmployees">55</span>`)).toBe(55);
  });

  it('extracts team_size from text phrasings the old single regex missed', () => {
    expect(extractTeamSize(`<p>В нашей команде уже 80 человек</p>`)).toBe(80);
    expect(extractTeamSize(`<p>Наша команда — 25 экспертов</p>`)).toBe(25);
    expect(extractTeamSize(`<p>Свыше 100 разработчиков</p>`)).toBe(100);
    expect(extractTeamSize(`<p>We are a team of 18</p>`)).toBe(18);
  });

  it('extracts the lower bound from a LinkedIn-style "Company size: 10—50"', () => {
    expect(extractTeamSize(`<p>Размер компании: 50—200</p>`)).toBe(50);
  });

  // Industrial-sector phrasings (МОСЛИФТ / КАСКАД-ЭНЕРГО feedback 09.06).
  // Promka sites lean on "штат / численность работников / коллектив насчитывает"
  // instead of "team / специалисты" — the LinkedIn-shaped patterns didn't fire.
  it('extracts team_size from "штат компании / штат составляет / штат насчитывает"', () => {
    expect(extractTeamSize(`<p>Штат компании: 250 человек</p>`)).toBe(250);
    expect(extractTeamSize(`<p>Штат компании 180</p>`)).toBe(180);
    expect(extractTeamSize(`<p>Штат составляет более 100 работников</p>`)).toBe(100);
    expect(extractTeamSize(`<p>Штат насчитывает 75 сотрудников</p>`)).toBe(75);
  });

  it('extracts team_size from "численность работников / сотрудников / персонала: N"', () => {
    expect(extractTeamSize(`<p>Численность работников: 320</p>`)).toBe(320);
    expect(extractTeamSize(`<p>Численность сотрудников более 150</p>`)).toBe(150);
    expect(extractTeamSize(`<p>Численность персонала — 90</p>`)).toBe(90);
  });

  it('extracts team_size from "коллектив насчитывает / включает / объединяет N"', () => {
    expect(extractTeamSize(`<p>Коллектив насчитывает свыше 200 человек</p>`)).toBe(200);
    expect(extractTeamSize(`<p>Коллектив компании объединяет 65 специалистов</p>`)).toBe(65);
    expect(extractTeamSize(`<p>Коллектив состоит из 40 экспертов</p>`)).toBe(40);
  });

  it('extracts team_size from "около N специалистов / сотрудников / человек"', () => {
    expect(extractTeamSize(`<p>Около 120 специалистов работают в компании</p>`)).toBe(120);
    expect(extractTeamSize(`<p>Около 80 сотрудников</p>`)).toBe(80);
  });

  it('extracts team_size from blue-collar professions (промка фидбэк 09.06)', () => {
    // МОСЛИФТ-style: компания пишет "300 рабочих" а не "300 сотрудников"
    expect(extractTeamSize(`<p>В штате 300 рабочих</p>`)).toBe(300);
    expect(extractTeamSize(`<p>50 монтажников и слесарей</p>`)).toBe(50);
    expect(extractTeamSize(`<p>Свыше 100 электриков</p>`)).toBe(100);
    expect(extractTeamSize(`<p>Более 200 человек работают на предприятии</p>`)).toBe(200);
  });
});
