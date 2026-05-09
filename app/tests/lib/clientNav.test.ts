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
  ClientNavGroupId,
  type ClientNavGroup,
  type ClientNavItem,
} from '@/lib/clientNav';

const allItems: readonly ClientNavItem[] = [
  CLIENT_NAV_DASHBOARD,
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
      '/client/leads',
      '/client/bases',
      '/client/reports',
      '/client/build',
      '/client/parsers?tab=email-sequence',
      '/client/launch',
      '/client/brief',
    ]);
    const actualHrefs = new Set(allItems.map((i) => i.href));
    expect(actualHrefs).toEqual(expectedHrefs);
  });

  it('Старт group orders items pedagogically (brief → collect & clean → write → launch)', () => {
    const start = CLIENT_NAV_GROUPS.find((g) => g.id === 'start') as ClientNavGroup;
    expect(start.items.map((i) => i.id)).toEqual([
      'brief',
      'build',
      'sequence',
      'launch',
    ]);
  });

  it('hub «Базы» replaces the three split items (Собрать/Парсеры/Очистить)', () => {
    const build = allItems.find((i) => i.id === 'build');
    expect(build?.href).toBe('/client/build');
    expect(build?.label).toBe('Базы');
    // Sanity: the old standalone items must NOT appear in the sidebar.
    const ids = new Set(allItems.map((i) => i.id));
    expect(ids.has('parsers')).toBe(false);
    expect(ids.has('clean')).toBe(false);
  });

  it('Мониторинг group contains tracking surfaces only', () => {
    const monitoring = CLIENT_NAV_GROUPS.find(
      (g) => g.id === 'monitoring',
    ) as ClientNavGroup;
    expect(monitoring.items.map((i) => i.id)).toEqual([
      'campaigns',
      'replies',
      'reports',
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

  it('label rename: «Лиды» → «Ответы и лиды»', () => {
    const replies = allItems.find((i) => i.id === 'replies');
    expect(replies?.label).toBe('Ответы и лиды');
    expect(replies?.href).toBe('/client/leads');
  });

  it('label rename: «Базы» → «Базы в кампаниях»', () => {
    const bases = allItems.find((i) => i.id === 'bases');
    expect(bases?.label).toBe('Базы в кампаниях');
  });

  it('Email Sequences live in Старт via query param (not as a Парсеры tab)', () => {
    const sequence = allItems.find((i) => i.id === 'sequence');
    expect(sequence?.href).toBe('/client/parsers?tab=email-sequence');
    expect(sequence?.label).toBe('Цепочки писем');
  });
});
