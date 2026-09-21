/** @jest-environment node */

/**
 * Рубильник платного поиска сайтов. Поиск — 69% расхода провайдеров и самая
 * вероятная неэффективность; проверить это можно только опытом, поэтому
 * выключение обязано быть безопасным и обратимым.
 */
import { isVePaidWebsiteSearchEnabled } from '@/lib/verticalEngineV2/paidSearchPolicy';

describe('рубильник платного поиска', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  it('по умолчанию поиск разрешён', () => {
    delete process.env.VE_PAID_WEBSITE_SEARCH;
    expect(isVePaidWebsiteSearchEnabled()).toBe(true);
  });

  it('выключается только точным словом off, в любом регистре и с пробелами', () => {
    for (const value of ['off', 'OFF', ' Off ']) {
      process.env.VE_PAID_WEBSITE_SEARCH = value;
      expect(isVePaidWebsiteSearchEnabled()).toBe(false);
    }
  });

  it('опечатка или чужое значение поиск не выключают', () => {
    // Молчаливое выключение дорогого шага из-за опечатки в переменной —
    // худший исход: базы перестали бы набирать контакты незаметно.
    for (const value of ['', '0', 'false', 'no', 'disable', 'offf']) {
      process.env.VE_PAID_WEBSITE_SEARCH = value;
      expect(isVePaidWebsiteSearchEnabled()).toBe(true);
    }
  });
});
