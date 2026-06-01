/** @jest-environment node */

import { extractPricingDetails } from '@/lib/enrich/extractors/pricingDetailExtractor';

describe('extractPricingDetails', () => {
  it('extracts minimal RUB price and detects free trial', () => {
    const html = `
      <div class="pricing">
        <div class="plan"><h3>Базовый</h3><div class="price">990 ₽/мес</div></div>
        <div class="plan"><h3>Pro</h3><div class="price">2 990 ₽/мес</div></div>
        <div class="plan"><h3>Enterprise</h3><div class="price">9 990 ₽/мес</div></div>
        <p>Попробуйте бесплатно 14 дней</p>
      </div>
    `;

    const result = extractPricingDetails(html);

    expect(result.pricing_min).toEqual({ value: 990, currency: 'RUB' });
    expect(result.free_trial).toBe(true);
  });

  it('extracts USD price when prices are in dollars', () => {
    const html = `
      <section>
        <div>$29/mo</div>
        <div>$99/mo</div>
        <div>$299/mo</div>
      </section>
    `;

    const result = extractPricingDetails(html);

    expect(result.pricing_min).toEqual({ value: 29, currency: 'USD' });
  });

  it('detects free trial via EN variants ("Start free trial", "14-day trial")', () => {
    const html = `<p>Start your 14-day free trial today</p>`;

    const result = extractPricingDetails(html);

    expect(result.free_trial).toBe(true);
  });

  it('returns no pricing_min when no prices are found, free_trial=false by default', () => {
    const html = `<p>Contact us for pricing</p>`;

    const result = extractPricingDetails(html);

    expect(result.pricing_min).toBeUndefined();
    expect(result.free_trial).toBe(false);
  });

  it('ignores prices >100M (likely IDs / phone numbers / wrong matches)', () => {
    const html = `
      <p>Order #99999999999</p>
      <div class="price">990 ₽</div>
    `;

    const result = extractPricingDetails(html);

    expect(result.pricing_min).toEqual({ value: 990, currency: 'RUB' });
  });

  it('ignores a bare number+currency that has no pricing context', () => {
    const html = `
      <p>Дарим бонус 2 ₽ за регистрацию</p>
      <p>Комплексное продвижение от 30 000 ₽</p>
    `;

    const result = extractPricingDetails(html);

    expect(result.pricing_min).toEqual({ value: 30000, currency: 'RUB' });
  });

  it('extracts an "от N ₽" price from body text', () => {
    const html = `<h2>SEO-продвижение от 45 000 ₽ в месяц</h2>`;

    const result = extractPricingDetails(html);

    expect(result.pricing_min).toEqual({ value: 45000, currency: 'RUB' });
  });

  it('prefers a plan/period price over per-lead unit rates', () => {
    const html = `
      <div class="pricing">
        <div class="plan"><h3>Старт</h3><div class="price">19 900 ₽/мес</div></div>
        <div class="plan"><h3>Бизнес</h3><div class="price">69 900 ₽/мес</div></div>
      </div>
      <p>Также работаем по модели оплаты за результат — от 590 ₽ за лид</p>
    `;

    const result = extractPricingDetails(html);

    expect(result.pricing_min).toEqual({ value: 19900, currency: 'RUB' });
  });

  it('falls back to a per-unit rate when the company prices only per lead', () => {
    const html = `<h2>Генерация лидов от 590 ₽ за лид</h2>`;

    const result = extractPricingDetails(html);

    expect(result.pricing_min).toEqual({ value: 590, currency: 'RUB' });
  });

  it('skips pricing extraction on a JSON-LD JobPosting page so salary cannot leak', () => {
    const html = `
      <script type="application/ld+json">{"@type":"JobPosting","title":"Директор по развитию"}</script>
      <h1>Вакансия: Директор по развитию</h1>
      <p>Зарплата: от 150 000 ₽ до 250 000 ₽</p>
      <p>Опыт работы: от 3 лет</p>
    `;

    const result = extractPricingDetails(html);

    expect(result.pricing_min).toBeUndefined();
    expect(result.free_trial).toBe(false);
  });

  it('skips pricing extraction on a job-posting page with 2+ characteristic text markers', () => {
    const html = `
      <h1>Региональный директор по продажам</h1>
      <h2>Обязанности:</h2>
      <ul><li>Развитие продаж</li></ul>
      <h2>Требования к кандидату</h2>
      <ul><li>Опыт работы от 5 лет</li></ul>
      <p>Зарплата — от 200 000 ₽</p>
    `;

    const result = extractPricingDetails(html);

    expect(result.pricing_min).toBeUndefined();
  });

  it('does NOT mistake a normal service page mentioning "опыт работы" once for a job posting', () => {
    // One isolated mention of "опыт работы" without 2+ supporting markers is
    // common copy — the page is a real pricing page.
    const html = `
      <h1>SEO-продвижение</h1>
      <p>Опыт работы — более 10 лет.</p>
      <div class="pricing">
        <div class="plan"><div class="price">19 900 ₽/мес</div></div>
      </div>
    `;

    const result = extractPricingDetails(html);

    expect(result.pricing_min).toEqual({ value: 19900, currency: 'RUB' });
  });

  it('detects a free trial when the company offers a free consultation or audit (agency pattern)', () => {
    // Agencies do not have SaaS-style trials; their equivalent is the free
    // first call / pilot / audit — that's what the user wants flagged.
    const cases = [
      '<p>Запишитесь на бесплатную консультацию</p>',
      '<p>Закажите бесплатный аудит вашего сайта</p>',
      '<p>Первая консультация бесплатна</p>',
      '<p>Free consultation with our experts</p>',
      '<p>Free audit of your marketing</p>',
      '<p>Пробный урок бесплатно</p>',
    ];
    for (const html of cases) {
      expect(extractPricingDetails(html).free_trial).toBe(true);
    }
  });
});
