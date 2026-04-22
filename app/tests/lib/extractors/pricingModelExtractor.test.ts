/** @jest-environment node */

import { extractPricingModel } from '@/lib/enrich/extractors/pricingModelExtractor';

describe('extractPricingModel', () => {
  it('returns "self-serve" when prices in RUB/USD and Buy CTA are present', () => {
    const html = `
      <div class="pricing">
        <div class="plan">
          <h3>Базовый</h3>
          <div class="price">990 ₽/мес</div>
          <button>Купить</button>
        </div>
        <div class="plan">
          <h3>Pro</h3>
          <div class="price">2 990 ₽/мес</div>
          <button>Купить</button>
        </div>
      </div>
    `;

    expect(extractPricingModel(html)).toBe('self-serve');
  });

  it('returns "self-serve" for USD prices with Buy now CTA', () => {
    const html = `
      <section class="plans">
        <div>$29/mo <a href="/buy">Buy now</a></div>
        <div>$99/mo <a href="/buy">Buy now</a></div>
      </section>
    `;

    expect(extractPricingModel(html)).toBe('self-serve');
  });

  it('returns "sales-led" when only contact-sales / book-demo CTAs are present', () => {
    const html = `
      <div class="pricing">
        <div class="plan">
          <h3>Business</h3>
          <p>Custom pricing for your team</p>
          <a href="/contact">Связаться с продажами</a>
        </div>
        <div class="plan">
          <h3>Enterprise</h3>
          <a href="/demo">Заказать демо</a>
        </div>
      </div>
    `;

    expect(extractPricingModel(html)).toBe('sales-led');
  });

  it('returns "enterprise" when no public prices and only "Talk to sales" is present', () => {
    const html = `
      <section>
        <h1>Pricing</h1>
        <p>We offer custom pricing tailored to enterprise customers.</p>
        <a href="/talk">Talk to sales</a>
      </section>
    `;

    expect(extractPricingModel(html)).toBe('enterprise');
  });

  it('returns "freemium" when "Free trial" or "Бесплатно навсегда" is present', () => {
    const html = `
      <div class="pricing">
        <div class="plan">
          <h3>Free</h3>
          <div class="price">Бесплатно навсегда</div>
        </div>
        <div class="plan">
          <h3>Pro</h3>
          <div class="price">990 ₽/мес</div>
          <button>Start free trial</button>
        </div>
      </div>
    `;

    expect(extractPricingModel(html)).toBe('freemium');
  });

  it('returns "unknown" when HTML does not look like a pricing page', () => {
    const html = `
      <article>
        <h1>About us</h1>
        <p>We are a company that does things.</p>
      </article>
    `;

    expect(extractPricingModel(html)).toBe('unknown');
  });
});
