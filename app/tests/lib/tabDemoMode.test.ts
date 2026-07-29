/**
 * Тесты per-tab демо-режима (sessionStorage-флаг + захват ?demo=1).
 * jsdom даёт настоящий sessionStorage/history — моки не нужны.
 */

import {
  isTabDemoMode,
  enableTabDemoMode,
  disableTabDemoMode,
  captureTabDemoFromLocation,
} from '@/lib/clientDemo/tabDemoMode';

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, '', 'http://localhost/client');
});

describe('tabDemoMode', () => {
  it('по умолчанию выключен', () => {
    expect(isTabDemoMode()).toBe(false);
  });

  it('enable → включен, disable → выключен', () => {
    enableTabDemoMode();
    expect(isTabDemoMode()).toBe(true);
    disableTabDemoMode();
    expect(isTabDemoMode()).toBe(false);
  });

  it('capture ?demo=1 → включает флаг и чистит URL', () => {
    window.history.replaceState(null, '', 'http://localhost/client/replies?demo=1&status=all');
    expect(captureTabDemoFromLocation()).toBe(true);
    expect(isTabDemoMode()).toBe(true);
    expect(window.location.search).toBe('?status=all');
  });

  it('capture без параметра → false, флаг не трогает', () => {
    expect(captureTabDemoFromLocation()).toBe(false);
    expect(isTabDemoMode()).toBe(false);
  });

  it('capture ?demo=0 → не включает (только строгое demo=1)', () => {
    window.history.replaceState(null, '', 'http://localhost/client?demo=0');
    expect(captureTabDemoFromLocation()).toBe(false);
    expect(isTabDemoMode()).toBe(false);
  });

  it('флаг не переживает «закрытие вкладки» (sessionStorage очищен)', () => {
    enableTabDemoMode();
    window.sessionStorage.clear(); // имитация новой вкладки
    expect(isTabDemoMode()).toBe(false);
  });
});
