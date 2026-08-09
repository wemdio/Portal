/**
 * @jest-environment node
 *
 * Кто виноват в сорванной переписке прогрева.
 *
 * Повод: 2 сорванные переписки давали в UI «4 аккаунта не подрубаются» —
 * провал приписывался обоим участникам, включая тех, кто был на связи.
 */

import { culpritNames, isCulprit } from '@/lib/tgOutreach/warmup/errorAttribution';

describe('warmup error attribution', () => {
  it('вычленяет одного не подключившегося', () => {
    expect(culpritNames('account_not_connected: Vladimir Nehilov')).toEqual(['Vladimir Nehilov']);
  });

  it('вычленяет обоих, когда не подключились оба', () => {
    expect(culpritNames('account_not_connected: Mihail Leshko, Vladimir Nemhov')).toEqual([
      'Mihail Leshko',
      'Vladimir Nemhov',
    ]);
  });

  it('вычленяет виновника оборванной отправки', () => {
    expect(culpritNames('отправка не удалась (Gleb Leshko): PEER_FLOOD')).toEqual(['Gleb Leshko']);
  });

  it('общие причины виновника не выделяют', () => {
    expect(culpritNames('peer_not_resolvable')).toBeNull();
    expect(culpritNames('resolve_failed: FLOOD_WAIT')).toBeNull();
    expect(culpritNames(null)).toBeNull();
  });

  it('старый формат без имени считается виной обоих', () => {
    expect(culpritNames('account_not_connected')).toBeNull();
    expect(isCulprit('account_not_connected', 'Valdes Fadeevs')).toBe(true);
  });

  it('собеседник не виноват, виновник — виноват', () => {
    const reason = 'account_not_connected: Vladimir Nehilov';
    expect(isCulprit(reason, 'Vladimir Nehilov')).toBe(true);
    expect(isCulprit(reason, 'Valdes Fadeevs')).toBe(false);
  });
});
