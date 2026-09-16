/** @jest-environment node */

/**
 * Разнос суточной нормы первых сообщений по дню. Инцидент 09.09.2026, ATOL-1:
 * 29 аккаунтов словили PEER_FLOOD после 3–6 сообщений подряд при норме 4
 * в сутки — суточный лимит не защищает от очереди за минуты. Правила
 * «пора/не пора» и «сколько за окно» проверяем на чистой функции, без базы
 * и Telegram.
 */

import { portionBudget } from '@/lib/tgOutreach/firstTouch/selectContacts';

const NOW = 1_800_000_000_000;
const min = (m: number) => m * 60_000;

describe('portionBudget — пора ли порция', () => {
  it('никогда не писавший аккаунт отправляет сразу', () => {
    const plan = portionBudget({ perDay: 4, sentToday: 0, lastSentAtMs: null, nowMs: NOW });
    expect(plan.due).toBe(true);
  });

  it('пауза не истекла — не пора', () => {
    const plan = portionBudget({ perDay: 4, sentToday: 1, lastSentAtMs: NOW - min(59), nowMs: NOW });
    expect(plan.due).toBe(false);
    expect(plan.budget).toBe(0);
  });

  it('пауза истекла — пора (граница включительно)', () => {
    const plan = portionBudget({ perDay: 4, sentToday: 1, lastSentAtMs: NOW - min(60), nowMs: NOW });
    expect(plan.due).toBe(true);
  });

  it('отправка вчера давно — пора', () => {
    const plan = portionBudget({ perDay: 4, sentToday: 0, lastSentAtMs: NOW - min(60 * 26), nowMs: NOW });
    expect(plan.due).toBe(true);
  });
});

describe('portionBudget — размер порции', () => {
  it('за окно не больше двух (дефолт), даже если норма больше', () => {
    const plan = portionBudget({ perDay: 10, sentToday: 0, lastSentAtMs: null, nowMs: NOW });
    expect(plan.budget).toBe(2);
  });

  it('суточная норма остаётся потолком порции', () => {
    const plan = portionBudget({ perDay: 1, sentToday: 0, lastSentAtMs: null, nowMs: NOW });
    expect(plan.budget).toBe(1);
  });

  it('остаток нормы считается от отправленного сегодня', () => {
    const plan = portionBudget({ perDay: 4, sentToday: 3, lastSentAtMs: NOW - min(90), nowMs: NOW });
    expect(plan.budget).toBe(1);
  });

  it('норма выбрана — не отправляем вовсе', () => {
    const plan = portionBudget({ perDay: 4, sentToday: 4, lastSentAtMs: NOW - min(90), nowMs: NOW });
    expect(plan.due).toBe(false);
    expect(plan.budget).toBe(0);
  });

  it('норма не задана — первое касание выключено', () => {
    const plan = portionBudget({ perDay: 0, sentToday: 0, lastSentAtMs: null, nowMs: NOW });
    expect(plan.budget).toBe(0);
  });
});

describe('portionBudget — настройки', () => {
  it('отсутствие паузы = дефолт 60 минут, а не «выключено»', () => {
    const plan = portionBudget({ perDay: 4, sentToday: 0, gapMinutes: undefined, lastSentAtMs: NOW - min(30), nowMs: NOW });
    expect(plan.due).toBe(false);
  });

  it('ноль выключает разнос: вся норма одной очередью', () => {
    const plan = portionBudget({ perDay: 6, sentToday: 0, gapMinutes: 0, lastSentAtMs: NOW - min(1), nowMs: NOW });
    expect(plan.due).toBe(true);
    expect(plan.budget).toBe(6);
  });

  it('своя пауза уважается: 120 минут — значит 110 мало', () => {
    expect(portionBudget({ perDay: 4, sentToday: 0, gapMinutes: 120, lastSentAtMs: NOW - min(110), nowMs: NOW }).due)
      .toBe(false);
    expect(portionBudget({ perDay: 4, sentToday: 0, gapMinutes: 120, lastSentAtMs: NOW - min(120), nowMs: NOW }).due)
      .toBe(true);
  });

  it('порция меньше единицы не оставляет аккаунт без отправки', () => {
    const plan = portionBudget({ perDay: 4, sentToday: 0, perGap: 0, lastSentAtMs: null, nowMs: NOW });
    expect(plan.budget).toBe(1);
  });
});
