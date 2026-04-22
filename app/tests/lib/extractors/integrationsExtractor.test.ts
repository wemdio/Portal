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
});
