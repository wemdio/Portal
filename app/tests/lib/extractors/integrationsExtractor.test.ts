/** @jest-environment node */

import { extractIntegrations } from '@/lib/enrich/extractors/integrationsExtractor';

describe('extractIntegrations', () => {
  it('extracts integration names from img alt in integrations/partners containers', () => {
    const html = `
      <section class="integrations">
        <img alt="AmoCRM" src="/amo.png" />
        <img alt="Slack" src="/slack.png" />
        <img alt="Telegram" src="/tg.png" />
      </section>
      <div class="partners">
        <img alt="Битрикс24" src="/b24.png" />
      </div>
    `;

    const result = extractIntegrations(html);

    expect(result).toEqual(expect.arrayContaining(['AmoCRM', 'Slack', 'Telegram', 'Битрикс24']));
    expect(result).toHaveLength(4);
  });

  it('filters generic alts and deduplicates case-insensitively', () => {
    const html = `
      <section class="integrations">
        <img alt="logo" src="/1.png" />
        <img alt="" src="/2.png" />
        <img alt="Slack" src="/3.png" />
        <img alt="SLACK" src="/4.png" />
      </section>
    `;

    const result = extractIntegrations(html);

    expect(result).toHaveLength(1);
    expect(result[0].toLowerCase()).toBe('slack');
  });

  it('caps result at 20 names', () => {
    const items = Array.from({ length: 50 }, (_, i) => `<img alt="Tool${i}" src="/${i}.png" />`).join('');
    const html = `<section class="integrations">${items}</section>`;

    expect(extractIntegrations(html)).toHaveLength(20);
  });

  it('returns empty array when no integrations container is present', () => {
    const html = `<header><img alt="Site Logo" src="/logo.png" /></header>`;

    expect(extractIntegrations(html)).toEqual([]);
  });

  it('drops CSS-class fragments, generic UI words and category labels — real tools only', () => {
    // The exact noise patterns observed in the spreadsheet rows:
    //   "blue circle color", "hero img", "material symbols light mail",
    //   "analytics", "integration", "services", "Read more",
    //   "SaaS / IT", "HR / Рекрутинг".
    const html = `
      <section class="integrations">
        <img alt="blue circle color" src="/1.svg" />
        <img alt="hero img" src="/2.png" />
        <img alt="material symbols light mail" src="/3.svg" />
        <img alt="analytics" src="/4.png" />
        <img alt="integration" src="/5.png" />
        <img alt="services" src="/6.png" />
        <img alt="Read more" src="/7.png" />
        <img alt="SaaS / IT" src="/8.png" />
        <img alt="HR / Рекрутинг" src="/9.png" />
        <img alt="Битрикс24" src="/10.png" />
        <img alt="amoCRM" src="/11.png" />
        <img alt="Slack" src="/12.png" />
      </section>
    `;

    const result = extractIntegrations(html);

    expect(result).toEqual(expect.arrayContaining(['Битрикс24', 'amoCRM', 'Slack']));
    expect(result).not.toContain('blue circle color');
    expect(result).not.toContain('hero img');
    expect(result).not.toContain('material symbols light mail');
    expect(result).not.toContain('analytics');
    expect(result).not.toContain('integration');
    expect(result).not.toContain('services');
    expect(result).not.toContain('Read more');
    expect(result).not.toContain('SaaS / IT');
    expect(result).not.toContain('HR / Рекрутинг');
  });
});
