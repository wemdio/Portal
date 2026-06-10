/** @jest-environment node */

import {
  extractHiring,
  extractProfession,
  findExternalCareerLinks,
} from '@/lib/enrich/extractors/hiringExtractor';

describe('extractProfession — strips noise from a raw vacancy title', () => {
  it('passes through a clean single-word profession unchanged', () => {
    expect(extractProfession('Лифтёр')).toBe('Лифтёр');
    expect(extractProfession('Электромонтажник')).toBe('Электромонтажник');
    expect(extractProfession('Designer')).toBe('Designer');
  });

  it('strips level prefix (Senior / Junior / Старший / Главный / ...)', () => {
    expect(extractProfession('Senior Frontend Developer')).toBe('Frontend Developer');
    expect(extractProfession('Старший электромонтажник')).toBe('электромонтажник');
    expect(extractProfession('Главный бухгалтер')).toBe('бухгалтер');
    expect(extractProfession('Junior QA Engineer')).toBe('QA Engineer');
    expect(extractProfession('Lead Product Manager')).toBe('Product Manager');
  });

  it('strips trailing salary fragments ("от 80 000 ₽", "100 000 руб")', () => {
    expect(extractProfession('Электромонтажник от 80 000 ₽')).toBe('Электромонтажник');
    expect(extractProfession('Слесарь 100 000 руб')).toBe('Слесарь');
    expect(extractProfession('Менеджер от 60 000 рублей')).toBe('Менеджер');
  });

  it('strips trailing location fragments ("в Москве", "СПб", "удалённо")', () => {
    expect(extractProfession('Разработчик удалённо')).toBe('Разработчик');
    expect(extractProfession('Лифтёр в Москве')).toBe('Лифтёр');
    expect(extractProfession('Бариста в Санкт-Петербурге')).toBe('Бариста');
  });

  it('strips work-mode tails ("полный день", "вахта", "сменный")', () => {
    expect(extractProfession('Машинист крана вахта')).toBe('Машинист крана');
    expect(extractProfession('Повар полный день')).toBe('Повар');
    expect(extractProfession('Слесарь сменный график')).toBe('Слесарь');
  });

  it('strips parenthetical qualifiers — they almost always carry the qualifier, not the noun', () => {
    expect(extractProfession('Менеджер по продажам (Senior)')).toBe('Менеджер по продажам');
    expect(extractProfession('Разработчик C# [удалённо]')).toBe('Разработчик C#');
    expect(extractProfession('Лифтёр (4 разряд)')).toBe('Лифтёр');
  });

  it('strips post-comma noise (location/qualifier after a comma)', () => {
    expect(extractProfession('Электрик, удалённо')).toBe('Электрик');
    expect(extractProfession('Бухгалтер, опыт от 3 лет')).toBe('Бухгалтер');
  });

  it('caps the result at 4 tokens — longer specs collapse to the meaningful head', () => {
    expect(extractProfession('Электромонтажник по силовым сетям и подстанциям'))
      .toBe('Электромонтажник по силовым сетям');
  });

  it('drops bookkeeping/filler titles that are not real professions', () => {
    expect(extractProfession('Все вакансии')).toBe('');
    expect(extractProfession('Открытые вакансии')).toBe('');
    expect(extractProfession('Career')).toBe('');
    expect(extractProfession('')).toBe('');
    expect(extractProfession('   ')).toBe('');
  });

  it('drops single-character / 2-letter snippets', () => {
    expect(extractProfession('1')).toBe('');
    expect(extractProfession('AB')).toBe('');
  });
});

describe('extractHiring — returns top-N concrete professions from vacancy cards', () => {
  it('returns vacancies_count and an empty professions list on a page with no vacancy markup', () => {
    const result = extractHiring(`<article><h1>About us</h1><p>Our story.</p></article>`);
    expect(result.vacancies_count).toBe(0);
    expect(result.professions).toEqual([]);
  });

  it('counts vacancy cards and aggregates their profession titles (промка example)', () => {
    // Real-world МОСЛИФТ-style markup: a /jobs page with 5 blue-collar vacancies.
    const html = `
      <main>
        <a class="vacancy">Лифтёр 4 разряда</a>
        <a class="vacancy">Лифтёр 5 разряда (от 60 000 ₽)</a>
        <a class="vacancy">Электромонтажник по силовым сетям</a>
        <a class="vacancy">Слесарь-ремонтник лифтового оборудования</a>
        <a class="vacancy">Диспетчер аварийной службы вахта</a>
      </main>
    `;
    const result = extractHiring(html);

    expect(result.vacancies_count).toBe(5);
    // Лифтёр appears twice → ranked first by frequency.
    expect(result.professions[0].toLowerCase()).toContain('лифтёр');
    // The complete list of distinct professions present (after dedup).
    expect(result.professions.map((p) => p.toLowerCase()).join(' '))
      .toMatch(/лифтёр.*(?:электромонтажник|слесар|диспетчер)/);
  });

  it('counts vacancy cards and aggregates a SaaS-style profession list', () => {
    const html = `
      <main>
        <div class="job-card"><h3>Senior Frontend Developer</h3></div>
        <div class="job-card"><h3>Junior Frontend Developer</h3></div>
        <div class="job-card"><h3>Product Manager</h3></div>
        <div class="job-card"><h3>UX Designer</h3></div>
      </main>
    `;
    const result = extractHiring(html);

    expect(result.vacancies_count).toBe(4);
    // After level-prefix stripping, "Frontend Developer" appears twice — tops the list.
    expect(result.professions[0]).toBe('Frontend Developer');
    expect(result.professions).toEqual(expect.arrayContaining(['Product Manager', 'UX Designer']));
  });

  it('falls back to text-derived count when there is no vacancy markup', () => {
    const result = extractHiring(`<p>Открытых вакансий: 12</p>`);
    expect(result.vacancies_count).toBe(12);
    expect(result.professions).toEqual([]);
  });

  it('caps the returned professions at 5 entries even if there are more distinct titles', () => {
    const titles = [
      'Разработчик',
      'Дизайнер',
      'Менеджер по продажам',
      'Маркетолог',
      'Аналитик',
      'Бухгалтер',
      'Юрист',
    ];
    const html =
      '<main>' +
      titles.map((t) => `<a class="vacancy">${t}</a>`).join('') +
      '</main>';
    const result = extractHiring(html);

    expect(result.professions.length).toBeLessThanOrEqual(5);
  });

  it('preserves first-seen casing when dedup is case-insensitive', () => {
    const html = `
      <main>
        <a class="vacancy">Электрик</a>
        <a class="vacancy">электрик</a>
        <a class="vacancy">ЭЛЕКТРИК</a>
      </main>
    `;
    const result = extractHiring(html);
    expect(result.professions).toEqual(['Электрик']);
  });
});

describe('findExternalCareerLinks', () => {
  it('finds hh.ru/employer/N links in page anchors', () => {
    const html = `
      <footer>
        <a href="https://hh.ru/employer/123456">Наши вакансии на HH</a>
        <a href="https://example.com">other</a>
      </footer>
    `;
    expect(findExternalCareerLinks(html)).toContain('https://hh.ru/employer/123456');
  });

  it('finds career.habr.com/companies links', () => {
    const html = `<a href="https://career.habr.com/companies/acme">Хабр Карьера</a>`;
    expect(findExternalCareerLinks(html)).toContain('https://career.habr.com/companies/acme');
  });

  it('strips query and fragment to dedupe the same link', () => {
    const html = `
      <a href="https://hh.ru/employer/111?from=footer">A</a>
      <a href="https://hh.ru/employer/111#vacancies">B</a>
    `;
    expect(findExternalCareerLinks(html)).toEqual(['https://hh.ru/employer/111']);
  });

  it('returns empty for pages with no external-career links', () => {
    expect(findExternalCareerLinks(`<p>About us</p>`)).toEqual([]);
  });

  it('does not match generic hh.ru profile / search URLs', () => {
    const html = `
      <a href="https://hh.ru/">HH</a>
      <a href="https://hh.ru/search/vacancy?text=devops">search</a>
    `;
    expect(findExternalCareerLinks(html)).toEqual([]);
  });
});
