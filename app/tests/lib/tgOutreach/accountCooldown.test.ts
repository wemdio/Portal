/** @jest-environment node */

import { isFloodLimitReason, cooldownUntilIso } from '@/lib/tgOutreach/accountCooldown';

describe('isFloodLimitReason', () => {
  it('ловит PEER_FLOOD и FLOOD_WAIT — это лимит нашего аккаунта', () => {
    expect(isFloodLimitReason('PEER_FLOOD')).toBe(true);
    expect(isFloodLimitReason('Telegram ограничил аккаунт (FLOOD_WAIT)')).toBe(true);
    expect(isFloodLimitReason('SLOWMODE_WAIT')).toBe(true);
  });

  it('не путает с мёртвой сессией и обрывом прокси', () => {
    expect(isFloodLimitReason('AUTH_KEY_UNREGISTERED')).toBe(false);
    expect(isFloodLimitReason('ECONNRESET')).toBe(false);
    expect(isFloodLimitReason('принимает сообщения только от Premium-аккаунтов')).toBe(false);
  });
});

describe('cooldownUntilIso', () => {
  it('откладывает ровно на заданные часы', () => {
    const now = new Date('2026-08-24T12:00:00.000Z');
    expect(cooldownUntilIso(24, now)).toBe('2026-08-25T12:00:00.000Z');
  });
});
