/**
 * Regression test for client portal navigation structure.
 *
 * The information architecture defined here is the contract approved during
 * Phase 0 of the UX redesign (sidebar with three groups: Старт / Мониторинг /
 * Архив). Any future change to nav structure should update this test in the
 * same PR — the test is the single source of truth for the agreed IA.
 *
 * URLs are intentionally locked: Phase 1-3 of the redesign rename labels and
 * regroup items but does NOT change routes (to avoid breaking client bookmarks).
 */

import {
  CLIENT_NAV_GROUPS,
  CLIENT_NAV_DASHBOARD,
  CLIENT_NAV_OFFER,
  CLIENT_NAV_SETTINGS,
  CLIENT_NAV_SUPPORT,
  ClientNavGroupId,
  resolveActiveNavId,
  type ClientNavGroup,
  type ClientNavItem,
} from '@/lib/clientNav';

// CLIENT_NAV_OFFER intentionally excluded from this list: the legal-footer
// link surfaces in the same sidebar block as Support but is conceptually a
// reference page, not a workflow surface. Keeping it out of `allItems` means
// the IA invariants below (workflow group structure, locked URL set) stay
// scoped to the workflow proper. CLIENT_NAV_OFFER gets its own dedicated
// test (`exposes an offer root item linking to /client/offer`).
const allItems: readonly ClientNavItem[] = [
  CLIENT_NAV_DASHBOARD,
  CLIENT_NAV_SUPPORT,
  ...CLIENT_NAV_GROUPS.flatMap((g) => g.items),
];

describe('client nav IA', () => {
  it('contains exactly the expected groups in order', () => {
    expect(CLIENT_NAV_GROUPS.map((g) => g.id)).toEqual<ClientNavGroupId[]>([
      'start',
      'monitoring',
      'archive',
    ]);
  });

  it('exposes a dashboard root item separate from groups', () => {
    expect(CLIENT_NAV_DASHBOARD.href).toBe('/client/dashboard');
    expect(CLIENT_NAV_DASHBOARD.id).toBe('dashboard');
    expect(CLIENT_NAV_DASHBOARD.label).toBeTruthy();
    expect(CLIENT_NAV_DASHBOARD.labelEn).toBeTruthy();
  });

  it('has a single primary CTA flagged across all items', () => {
    const ctas = allItems.filter((i) => i.primaryCta === true);
    expect(ctas).toHaveLength(1);
    expect(ctas[0]?.href).toBe('/client/launch');
  });

  it('every item has unique id', () => {
    const ids = allItems.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every item has both RU and EN labels', () => {
    for (const item of allItems) {
      expect(item.label.trim().length).toBeGreaterThan(0);
      expect(item.labelEn.trim().length).toBeGreaterThan(0);
    }
  });

  it('every item href starts with /client', () => {
    for (const item of allItems) {
      expect(item.href.startsWith('/client')).toBe(true);
    }
  });

  it('locks the visible URL set — routes must not regress', () => {
    // Phase 4 consolidation: «Собрать базу», «Парсеры», «Очистить базу» were
    // merged into a single «Базы» entry that opens the /client/build hub.
    // The legacy URLs (/client/companies-search, /client/parsers,
    // /client/base-constructor) keep working — they're just no longer in the
    // sidebar; the hub links to them.
    const expectedHrefs = new Set([
      '/client',
      '/client/dashboard',
      '/client/projects',
      '/client/replies',
      '/client/leads',
      '/client/blocklist',
      '/client/bases',
      '/client/reports',
      '/client/tariff',
      '/client/build',
      '/client/parsers',
      '/client/launch',
      '/client/brief',
      '/client/support',
    ]);
    const actualHrefs = new Set(allItems.map((i) => i.href));
    expect(actualHrefs).toEqual(expectedHrefs);
  });

  it('exposes a support root item separate from groups (replaces legacy mailto)', () => {
    expect(CLIENT_NAV_SUPPORT.href).toBe('/client/support');
    expect(CLIENT_NAV_SUPPORT.id).toBe('support');
    expect(CLIENT_NAV_SUPPORT.label).toBeTruthy();
    expect(CLIENT_NAV_SUPPORT.labelEn).toBeTruthy();
    // The support item must NOT live inside any of the workflow groups —
    // it's an always-available helpdesk surface, not a step.
    for (const g of CLIENT_NAV_GROUPS) {
      expect(g.items.some((i) => i.id === 'support')).toBe(false);
    }
  });

  it('exposes an offer root item linking to /client/offer', () => {
    // In-portal version: the client sidebar opens /client/offer (wrapped by
    // the client layout's top bar + sidebar + theme tokens). The standalone
    // /offer page is reserved for the /login footer link, where there's no
    // session and a chromeless legal page is the right surface.
    expect(CLIENT_NAV_OFFER.href).toBe('/client/offer');
    expect(CLIENT_NAV_OFFER.id).toBe('offer');
    expect(CLIENT_NAV_OFFER.label).toBeTruthy();
    expect(CLIENT_NAV_OFFER.labelEn).toBeTruthy();
    for (const g of CLIENT_NAV_GROUPS) {
      expect(g.items.some((i) => i.id === 'offer')).toBe(false);
    }
  });

  it('resolveActiveNavId picks offer for /client/offer', () => {
    expect(resolveActiveNavId('/client/offer')).toBe('offer');
    expect(resolveActiveNavId('/client/offer/foo')).toBe('offer');
  });

  it('exposes a settings root item linking to /client/settings', () => {
    // Account-level settings page (password change today). Like Offer, it lives
    // OUTSIDE the workflow groups — it's an always-available account surface,
    // not a step. Therefore intentionally excluded from `allItems` invariants
    // above and gets its own dedicated test instead.
    expect(CLIENT_NAV_SETTINGS.href).toBe('/client/settings');
    expect(CLIENT_NAV_SETTINGS.id).toBe('settings');
    expect(CLIENT_NAV_SETTINGS.label).toBeTruthy();
    expect(CLIENT_NAV_SETTINGS.labelEn).toBeTruthy();
    for (const g of CLIENT_NAV_GROUPS) {
      expect(g.items.some((i) => i.id === 'settings')).toBe(false);
    }
  });

  it('resolveActiveNavId picks settings for /client/settings', () => {
    expect(resolveActiveNavId('/client/settings')).toBe('settings');
    expect(resolveActiveNavId('/client/settings/account')).toBe('settings');
  });

  it('resolveActiveNavId picks support for /client/support', () => {
    expect(resolveActiveNavId('/client/support')).toBe('support');
    expect(resolveActiveNavId('/client/support/foo')).toBe('support');
  });

  it('Старт group orders items pedagogically (brief → collect & clean → write → launch)', () => {
    const start = CLIENT_NAV_GROUPS.find((g) => g.id === 'start') as ClientNavGroup;
    expect(start.items.map((i) => i.id)).toEqual([
      'brief',
      'build',
      'parsers',
      'launch',
    ]);
  });

  it('hub «Базы» replaces the three split items (Собрать/Очистить)', () => {
    const build = allItems.find((i) => i.id === 'build');
    expect(build?.href).toBe('/client/build');
    expect(build?.label).toBe('Базы');
    const ids = new Set(allItems.map((i) => i.id));
    expect(ids.has('clean')).toBe(false);
  });

  it('Мониторинг group contains tracking surfaces only', () => {
    const monitoring = CLIENT_NAV_GROUPS.find(
      (g) => g.id === 'monitoring',
    ) as ClientNavGroup;
    expect(monitoring.items.map((i) => i.id)).toEqual([
      'campaigns',
      'replies',
      'leads',
      'blocklist',
      'reports',
      'tariff',
    ]);
  });

  it('Архив group is read-only background data', () => {
    const archive = CLIENT_NAV_GROUPS.find(
      (g) => g.id === 'archive',
    ) as ClientNavGroup;
    expect(archive.items.map((i) => i.id)).toEqual(['bases', 'projects']);
  });

  it('Кампании lives at /client (legacy entry point preserved)', () => {
    const campaigns = allItems.find((i) => i.id === 'campaigns');
    expect(campaigns?.href).toBe('/client');
  });

  it('label rename: «Запуск кампаний» → «Создать кампанию»', () => {
    const launch = allItems.find((i) => i.id === 'launch');
    expect(launch?.label).toBe('Создать кампанию');
    expect(launch?.primaryCta).toBe(true);
  });

  it('splits replies and leads into separate monitoring tabs', () => {
    const replies = allItems.find((i) => i.id === 'replies');
    const leads = allItems.find((i) => i.id === 'leads');
    expect(replies?.label).toBe('Ответы');
    expect(replies?.href).toBe('/client/replies');
    expect(leads?.label).toBe('Лиды');
    expect(leads?.href).toBe('/client/leads');
  });

  it('label rename: «Базы» → «Базы в кампаниях»', () => {
    const bases = allItems.find((i) => i.id === 'bases');
    expect(bases?.label).toBe('Базы в кампаниях');
  });

  it('Инструменты парсинга live in Старт as a standalone page', () => {
    const parsers = allItems.find((i) => i.id === 'parsers');
    expect(parsers?.href).toBe('/client/parsers');
    expect(parsers?.label).toBe('Инструменты парсинга');
  });
});
