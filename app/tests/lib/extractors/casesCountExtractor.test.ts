/** @jest-environment node */

import { extractCasesCount } from '@/lib/enrich/extractors/casesCountExtractor';

describe('extractCasesCount', () => {
  it('counts items by typical case-card class patterns', () => {
    const html = `
      <main>
        <article class="case-card"><h3>Case 1</h3></article>
        <article class="case-card"><h3>Case 2</h3></article>
        <div class="client-card"><h3>Client</h3></div>
        <li class="case-item">Another</li>
      </main>
    `;

    expect(extractCasesCount(html)).toBe(4);
  });

  it('returns 0 when DOM matches blow past the trust limit without a textual claim — that count is almost always a CMS false positive (and the LLM fallback runs instead)', () => {
    const items = Array.from({ length: 500 }, () => `<div class="case-card">x</div>`).join('');
    const html = `<main>${items}</main>`;

    expect(extractCasesCount(html)).toBe(0);
  });

  it('trusts a high DOM count when text on the same page corroborates it', () => {
    const items = Array.from({ length: 220 }, () => `<div class="case-card">x</div>`).join('');
    const html = `<main><p>Более 150 успешных проектов</p>${items}</main>`;

    // Text claim is 150 → clamped to MAX_CASES (100).
    expect(extractCasesCount(html)).toBe(100);
  });

  it('returns 0 when page has no case-related markup', () => {
    const html = `<article><h1>Hello</h1></article>`;

    expect(extractCasesCount(html)).toBe(0);
  });

  it('does not double-count nested same-class elements', () => {
    const html = `
      <div class="case-card">
        <div class="case-card-inner">nested but different class</div>
      </div>
      <div class="case-card">another</div>
    `;

    expect(extractCasesCount(html)).toBe(2);
  });
});
