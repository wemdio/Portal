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
});
