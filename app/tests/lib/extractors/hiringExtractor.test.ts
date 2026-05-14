/** @jest-environment node */

import { extractHiring } from '@/lib/enrich/extractors/hiringExtractor';

describe('extractHiring', () => {
  it('counts vacancy items by typical class patterns', () => {
    const html = `
      <main>
        <a class="vacancy" href="/v1">Frontend Developer</a>
        <a class="vacancy" href="/v2">Backend Developer</a>
        <div class="job-card">
          <h3>Marketing Manager</h3>
        </div>
        <li class="position">Sales Lead</li>
      </main>
    `;

    const result = extractHiring(html);

    expect(result.vacancies_count).toBe(4);
  });

  it('detects marketing roles by EN/RU keywords in titles', () => {
    const html = `
      <main>
        <a class="vacancy">Performance Marketing Manager</a>
        <a class="vacancy">SMM-специалист</a>
        <a class="vacancy">PPC специалист</a>
      </main>
    `;

    const result = extractHiring(html);

    expect(result.has_marketing).toBe(true);
    expect(result.has_engineering).toBe(false);
    expect(result.has_sales).toBe(false);
  });

  it('detects engineering roles by EN/RU keywords', () => {
    const html = `
      <main>
        <a class="vacancy">Senior Frontend Developer</a>
        <a class="vacancy">Бэкенд-разработчик</a>
        <a class="vacancy">DevOps Engineer</a>
      </main>
    `;

    const result = extractHiring(html);

    expect(result.has_engineering).toBe(true);
    expect(result.has_marketing).toBe(false);
  });

  it('detects sales roles by EN/RU keywords', () => {
    const html = `
      <main>
        <a class="vacancy">Account Executive</a>
        <a class="vacancy">Менеджер по продажам</a>
        <a class="vacancy">SDR</a>
      </main>
    `;

    const result = extractHiring(html);

    expect(result.has_sales).toBe(true);
  });

  it('detects design roles by EN/RU keywords', () => {
    const html = `
      <main>
        <a class="vacancy">UX/UI Designer</a>
        <a class="vacancy">Графический дизайнер</a>
      </main>
    `;

    const result = extractHiring(html);

    expect(result.has_design).toBe(true);
    expect(result.has_product).toBe(false);
  });

  it('detects product roles by EN/RU keywords', () => {
    const html = `
      <main>
        <a class="vacancy">Product Manager</a>
        <a class="vacancy">Продакт-менеджер</a>
      </main>
    `;

    const result = extractHiring(html);

    expect(result.has_product).toBe(true);
  });

  it('returns zero count and all-false flags when page does not look like /careers', () => {
    const html = `
      <article>
        <h1>About us</h1>
        <p>Our story.</p>
      </article>
    `;

    const result = extractHiring(html);

    expect(result.vacancies_count).toBe(0);
    expect(result.has_marketing).toBe(false);
    expect(result.has_engineering).toBe(false);
    expect(result.has_sales).toBe(false);
    expect(result.has_design).toBe(false);
    expect(result.has_product).toBe(false);
  });

  it('combines all role flags when multiple departments hire', () => {
    const html = `
      <main>
        <div class="job">Marketing Lead</div>
        <div class="job">Senior Engineer</div>
        <div class="job">Sales Manager</div>
        <div class="job">Product Manager</div>
        <div class="job">UX Designer</div>
        <div class="job">Customer Support</div>
      </main>
    `;

    const result = extractHiring(html);

    expect(result.vacancies_count).toBe(6);
    expect(result.has_marketing).toBe(true);
    expect(result.has_engineering).toBe(true);
    expect(result.has_sales).toBe(true);
    expect(result.has_design).toBe(true);
    expect(result.has_product).toBe(true);
  });
});
