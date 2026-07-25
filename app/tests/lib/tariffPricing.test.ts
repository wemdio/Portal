/**
 * Фиксирует денежную математику тарифов и то, что источник цен один.
 *
 * Зачем: до появления lib/tariffPricing.ts цены и скидки были скопированы по
 * четырём файлам с комментариями «keep in sync», и рассинхрон уже случился —
 * публичная /tariffs показывала «Поток» за 80 000 ₽/мес, тогда как счёт
 * выставлялся на 65 000. Тест ловит именно такой класс расхождения: если
 * кто-то поправит цену или процент скидки в одном месте, упадёт здесь, а не
 * обнаружится по жалобе клиента.
 */

import {
  TARIFF_LAUNCH,
  TARIFF_FLOW,
  TARIFF_SCALE,
  normalizeTariffType,
  TARIFF_MONTHLY_PRICE,
  BILLING_PERIOD_MONTHS,
  BILLING_PERIOD_DISCOUNT,
  TARIFF_LABELS_RU,
  TEST_TARIFF_PRICE,
  calcBillingAmount,
} from '@/lib/tariffPricing';

describe('tariff pricing — источник истины', () => {
  it('месячные цены совпадают с лендингом outreachos.pro', () => {
    expect(TARIFF_MONTHLY_PRICE[TARIFF_LAUNCH]).toBe(40_000);
    expect(TARIFF_MONTHLY_PRICE[TARIFF_FLOW]).toBe(65_000);
  });

  it('названия тарифов совпадают с лендингом', () => {
    expect(TARIFF_LABELS_RU).toEqual({
      [TARIFF_LAUNCH]: 'Запуск',
      [TARIFF_FLOW]: 'Поток',
      [TARIFF_SCALE]: 'Масштаб',
    });
  });

  it('скидки по периодам: месяц 0%, 3 мес −5%, 6 мес −10%, год −20%', () => {
    expect(BILLING_PERIOD_DISCOUNT.month).toBe(1);
    expect(BILLING_PERIOD_DISCOUNT.quarter).toBe(0.95);
    expect(BILLING_PERIOD_DISCOUNT.half_year).toBe(0.9);
    expect(BILLING_PERIOD_DISCOUNT.year).toBe(0.8);
  });

  it('множители месяцев соответствуют названиям периодов', () => {
    expect(BILLING_PERIOD_MONTHS).toEqual({
      month: 1,
      quarter: 3,
      half_year: 6,
      year: 12,
    });
  });
});

describe('normalizeTariffType — совместимость со старыми значениями', () => {
  it('прежние значения приводит к текущим', () => {
    expect(normalizeTariffType('standard')).toBe(TARIFF_LAUNCH);
    expect(normalizeTariffType('pro')).toBe(TARIFF_FLOW);
    expect(normalizeTariffType('custom')).toBe(TARIFF_SCALE);
  });

  it('текущие значения пропускает как есть', () => {
    expect(normalizeTariffType('Запуск')).toBe(TARIFF_LAUNCH);
    expect(normalizeTariffType('Поток')).toBe(TARIFF_FLOW);
    expect(normalizeTariffType('Масштаб')).toBe(TARIFF_SCALE);
  });

  it('пустое и неизвестное → null, а не молчаливый дефолт', () => {
    expect(normalizeTariffType(null)).toBeNull();
    expect(normalizeTariffType(undefined)).toBeNull();
    expect(normalizeTariffType('')).toBeNull();
    expect(normalizeTariffType('business')).toBeNull();
    expect(normalizeTariffType('ЗАПУСК')).toBeNull(); // регистр не угадываем
  });

  it('после нормализации значение годится для расчёта суммы', () => {
    // Именно этот путь спасает оплату из вкладки со старым JS: браузер
    // присылает 'pro', нормализация даёт Поток, сумма считается.
    const legacy = normalizeTariffType('pro')!;
    expect(calcBillingAmount(legacy, 'year')).toBe(624_000);
  });
});

describe('calcBillingAmount', () => {
  it('считает Запуск по периодам со скидкой', () => {
    expect(calcBillingAmount(TARIFF_LAUNCH, 'month')).toBe(40_000);
    expect(calcBillingAmount(TARIFF_LAUNCH, 'quarter')).toBe(114_000); // 120k − 5%
    expect(calcBillingAmount(TARIFF_LAUNCH, 'half_year')).toBe(216_000); // 240k − 10%
    expect(calcBillingAmount(TARIFF_LAUNCH, 'year')).toBe(384_000); // 480k − 20%
  });

  it('считает Поток по периодам со скидкой', () => {
    expect(calcBillingAmount(TARIFF_FLOW, 'month')).toBe(65_000);
    expect(calcBillingAmount(TARIFF_FLOW, 'quarter')).toBe(185_250); // 195k − 5%
    expect(calcBillingAmount(TARIFF_FLOW, 'half_year')).toBe(351_000); // 390k − 10%
    expect(calcBillingAmount(TARIFF_FLOW, 'year')).toBe(624_000); // 780k − 20%
  });

  it('для Масштаба возвращает null — сумма ставится вручную', () => {
    expect(calcBillingAmount(TARIFF_SCALE, 'month')).toBeNull();
    expect(calcBillingAmount(TARIFF_SCALE, 'year')).toBeNull();
  });

  it('длинный период всегда дешевле того же срока по месяцам', () => {
    for (const tariff of [TARIFF_LAUNCH, TARIFF_FLOW] as const) {
      const monthly = calcBillingAmount(tariff, 'month')!;
      expect(calcBillingAmount(tariff, 'quarter')!).toBeLessThan(monthly * 3);
      expect(calcBillingAmount(tariff, 'half_year')!).toBeLessThan(monthly * 6);
      expect(calcBillingAmount(tariff, 'year')!).toBeLessThan(monthly * 12);
    }
  });

  it('в тест-магазине отдаёт фиксированные тестовые цены, а не боевые', () => {
    expect(calcBillingAmount(TARIFF_LAUNCH, 'month', true)).toBe(TEST_TARIFF_PRICE[TARIFF_LAUNCH].month);
    expect(calcBillingAmount(TARIFF_FLOW, 'year', true)).toBe(TEST_TARIFF_PRICE[TARIFF_FLOW].year);
  });

  it('в тест-магазине quarter не поддерживается — null, а не боевая цена', () => {
    expect(calcBillingAmount(TARIFF_LAUNCH, 'quarter', true)).toBeNull();
    expect(calcBillingAmount(TARIFF_FLOW, 'quarter', true)).toBeNull();
  });
});
