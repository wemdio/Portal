/**
 * Регрессия TZ-фикса лид-алерта спецу (leadNotifier.ts, инцидент 16.07.2026):
 * TZ контейнера = UTC, и дата без timeZone у полуночи съезжала на день назад.
 * Тесты TZ-независимы (пояс задан явно) — ловят возврат к UTC на любой машине.
 */

import { formatLeadAlertDate } from '@/lib/instantly/leadNotifier';

describe('formatLeadAlertDate — дата всегда по Москве', () => {
  it('обычный день: UTC-метка отдаёт московскую дату', () => {
    expect(formatLeadAlertDate('2026-07-16T09:52:36+00:00')).toBe('16 июля');
  });

  it('полуночный кейс: 22:30 UTC 16-го = 01:30 МСК 17-го → «17 июля»', () => {
    expect(formatLeadAlertDate('2026-07-16T22:30:00+00:00')).toBe('17 июля');
  });

  it('битая метка → дата «сейчас», не «Invalid Date»', () => {
    const now = new Date('2026-07-20T10:00:00+00:00');
    expect(formatLeadAlertDate('не-дата', now)).toBe('20 июля');
    expect(formatLeadAlertDate('не-дата', now)).not.toContain('Invalid');
  });

  it('пустая метка → дата «сейчас» по Москве (полуночный кейс)', () => {
    // 22:30 UTC = 01:30 МСК следующего дня
    const now = new Date('2026-07-16T22:30:00+00:00');
    expect(formatLeadAlertDate(null, now)).toBe('17 июля');
  });
});
