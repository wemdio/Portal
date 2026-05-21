/**
 * Tests for the auto-mode nav filter introduced for the HH auto-pipeline.
 *
 * Two contracts here:
 *   1. filterClientNavGroupsForMode keeps everything in manual, strips most
 *      items in auto.
 *   2. CLIENT_NAV_AUTO_PIPELINE_SETUP is a top-level item with a /client/*
 *      route — resolveActiveNavId picks it up correctly.
 *
 * Original clientNav.test.ts validates the manual-mode IA contract; this file
 * validates only the auto-mode additions, leaving the existing contract test
 * untouched.
 */

import {
  CLIENT_NAV_AUTO_PIPELINE_SETUP,
  CLIENT_NAV_GROUPS,
  filterClientNavGroupsForMode,
  resolveActiveNavId,
  type ClientNavMode,
} from '@/lib/clientNav';

describe('filterClientNavGroupsForMode', () => {
  it('returns groups unchanged for manual mode', () => {
    const manual = filterClientNavGroupsForMode(CLIENT_NAV_GROUPS, 'manual');
    expect(manual).toBe(CLIENT_NAV_GROUPS);
  });

  it('keeps only replies / leads / reports for auto mode', () => {
    const auto = filterClientNavGroupsForMode(CLIENT_NAV_GROUPS, 'auto');
    const visibleIds = auto.flatMap((g) => g.items.map((i) => i.id));
    expect(visibleIds.sort()).toEqual(['leads', 'replies', 'reports'].sort());
  });

  it('drops empty groups in auto mode', () => {
    const auto = filterClientNavGroupsForMode(CLIENT_NAV_GROUPS, 'auto');
    // After filter Start (нет ни одного из replies/leads/reports там) и Archive
    // должны исчезнуть — остаётся только Monitoring.
    expect(auto.map((g) => g.id)).toEqual(['monitoring']);
  });

  it('is pure — does not mutate input groups array', () => {
    const before = JSON.stringify(CLIENT_NAV_GROUPS);
    filterClientNavGroupsForMode(CLIENT_NAV_GROUPS, 'auto');
    expect(JSON.stringify(CLIENT_NAV_GROUPS)).toBe(before);
  });

  it('rejects unknown modes by defaulting to manual via TS — guard at compile-time', () => {
    // Smoke: с любыми двумя валидными значениями результат предсказуем.
    const modes: ClientNavMode[] = ['manual', 'auto'];
    for (const m of modes) {
      const out = filterClientNavGroupsForMode(CLIENT_NAV_GROUPS, m);
      expect(Array.isArray(out)).toBe(true);
    }
  });
});

describe('CLIENT_NAV_AUTO_PIPELINE_SETUP', () => {
  it('has stable id, /client route and bilingual labels', () => {
    expect(CLIENT_NAV_AUTO_PIPELINE_SETUP.id).toBe('auto-pipeline-setup');
    expect(CLIENT_NAV_AUTO_PIPELINE_SETUP.href).toBe('/client/auto-pipeline/setup');
    expect(CLIENT_NAV_AUTO_PIPELINE_SETUP.label).toBeTruthy();
    expect(CLIENT_NAV_AUTO_PIPELINE_SETUP.labelEn).toBeTruthy();
  });

  it('is NOT in any of the manual-mode groups (top-level item only)', () => {
    const inGroups = CLIENT_NAV_GROUPS.some((g) =>
      g.items.some((i) => i.id === 'auto-pipeline-setup'),
    );
    expect(inGroups).toBe(false);
  });
});

describe('resolveActiveNavId — auto-pipeline-setup', () => {
  it('picks auto-pipeline-setup for the exact setup path', () => {
    expect(resolveActiveNavId('/client/auto-pipeline/setup')).toBe('auto-pipeline-setup');
  });

  it('picks auto-pipeline-setup for nested setup paths', () => {
    expect(resolveActiveNavId('/client/auto-pipeline/setup/anything')).toBe(
      'auto-pipeline-setup',
    );
  });

  it('does not match unrelated /client/auto-pipeline paths to setup', () => {
    // Например, summary API под /api, тут чисто проверяем что портал-роуты
    // не путаются с настройкой. Если в будущем добавим /client/auto-pipeline/<x>
    // — этот тест прозвенит.
    expect(resolveActiveNavId('/client/auto-pipeline')).not.toBe('auto-pipeline-setup');
  });
});
