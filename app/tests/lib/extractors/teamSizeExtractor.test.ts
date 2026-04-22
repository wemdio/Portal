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

  it('caps result at 200 to ignore wrong markup', () => {
    const items = Array.from({ length: 500 }, () => `<div class="member-card">x</div>`).join('');
    const html = `<main>${items}</main>`;

    expect(extractTeamSize(html)).toBe(200);
  });

  it('returns 0 when no team-related markup is present', () => {
    const html = `<article><h1>About</h1></article>`;

    expect(extractTeamSize(html)).toBe(0);
  });
});
