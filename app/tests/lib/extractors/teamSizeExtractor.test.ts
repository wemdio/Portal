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
});
