/**
 * Тарифы: названия, цены, периоды, скидки — ЕДИНЫЙ источник истины.
 *
 * Почему отдельный файл, а не всё в lib/tariffs.ts: тот помечен `server-only`
 * (тянет supabaseAdmin), поэтому клиентские страницы — админка, ЛК клиента,
 * счёта — импортировать его физически не могут. Раньше из-за этого цены,
 * скидки и лейблы были скопированы по файлам с комментарием «keep in sync»:
 * цены в 2 местах, лейблы тарифов в 3, лейблы периодов в 2, плюс две
 * независимые реализации расчёта суммы. Расхождение означало бы, что админ
 * видит одну цифру, а клиент в ЛК — другую, и заметили бы это только по
 * жалобе клиента.
 *
 * Здесь только чистые данные и чистые функции — ни БД, ни env, ни fetch.
 * Поэтому файл безопасно импортировать и на сервере, и в браузере.
 * lib/tariffs.ts реэкспортирует всё отсюда, так что серверные импорты
 * `from '@/lib/tariffs'` продолжают работать без правок.
 */

/**
 * Значения тарифа = названия из продукта. Так же они лежат в БД
 * (client_tariffs.tariff_type — text + CHECK), чтобы логи, SQL-запросы и
 * выгрузки говорили на одном языке с лендингом и ЛК, без промежуточного
 * маппинга. Миграция: supabase/migrations/20260725_0001_tariff_type_rename.sql
 */
export const TARIFF_LAUNCH = 'Запуск';
export const TARIFF_FLOW = 'Поток';
export const TARIFF_SCALE = 'Масштаб';

export type TariffType = typeof TARIFF_LAUNCH | typeof TARIFF_FLOW | typeof TARIFF_SCALE;

/** Тарифы с фиксированной ценой. «Масштаб» считается вручную. */
export type PaidTariffType = typeof TARIFF_LAUNCH | typeof TARIFF_FLOW;

export type BillingMode = 'invoice' | 'autopayment';

export type BillingPeriod = 'month' | 'quarter' | 'half_year' | 'year';

/**
 * Прежние значения → текущие. Нужны в двух реальных сценариях, а не «на
 * всякий случай»:
 *   1. Строки в БД, не доехавшие до миграции (или записанные старым кодом в
 *      окне между preflight-миграцией и переключением трафика на новый образ);
 *   2. Открытые вкладки клиентов. После деплоя браузер продолжает крутить
 *      старый JS и POST'ит `tariff_type: 'standard'` в /api/client/payment —
 *      без нормализации клиент с открытой страницей не смог бы оплатить.
 * Поэтому ВСЕ входы (тело запроса, чтение из БД) проходят через normalize.
 */
const LEGACY_TARIFF_VALUES: Record<string, TariffType> = {
  standard: TARIFF_LAUNCH,
  pro: TARIFF_FLOW,
  custom: TARIFF_SCALE,
};

/** Приводит любое известное значение тарифа к текущему. null — не распознано. */
export function normalizeTariffType(value: string | null | undefined): TariffType | null {
  if (!value) return null;
  if (value === TARIFF_LAUNCH || value === TARIFF_FLOW || value === TARIFF_SCALE) return value;
  return LEGACY_TARIFF_VALUES[value] ?? null;
}

/**
 * Отображаемые названия. Сейчас совпадают со значениями в БД один-к-одному —
 * маппинг оставлен как шов на случай, если отображение снова разойдётся с
 * хранением (например, понадобится английская локаль).
 */
export const TARIFF_LABELS_RU: Record<TariffType, string> = {
  [TARIFF_LAUNCH]: TARIFF_LAUNCH,
  [TARIFF_FLOW]: TARIFF_FLOW,
  [TARIFF_SCALE]: TARIFF_SCALE,
};

export type TariffLimits = {
  max_contacts: number;
  max_rows: number;
  max_chains_per_month: number;
  max_domains: number;
  max_emails: number;
};

/** Лимиты по умолчанию для Запуска и Потока. Масштаб задаётся вручную. */
export const TARIFF_DEFAULTS: Record<PaidTariffType, TariffLimits> = {
  [TARIFF_LAUNCH]: {
    max_contacts: 10_000,
    max_rows: 20_000,
    max_chains_per_month: 10,
    max_domains: 4,
    max_emails: 16,
  },
  [TARIFF_FLOW]: {
    max_contacts: 20_000,
    max_rows: 40_000,
    max_chains_per_month: 20,
    max_domains: 8,
    max_emails: 32,
  },
};

/** Подписи периодов оплаты для UI. */
export const BILLING_PERIOD_LABELS: Record<BillingPeriod, string> = {
  month: '1 месяц',
  quarter: '3 месяца',
  half_year: '6 месяцев',
  year: '12 месяцев',
};

/** Дней setup-триала до первой оплаты. */
export const SETUP_DAYS = 15;

/**
 * Цены тарифов за месяц для выставления счёта (отличаются от цен автопродления
 * в /api/cron/auto-renew). Масштаб — сумма проставляется вручную.
 * Выровнено с outreachos.pro лендингом 23.06.2026: ЗАПУСК=40k, ПОТОК=65k.
 */
export const TARIFF_MONTHLY_PRICE: Record<PaidTariffType, number> = {
  [TARIFF_LAUNCH]: 40_000,
  [TARIFF_FLOW]: 65_000,
};

/** Множители месяцев для периодов оплаты (без скидок). */
export const BILLING_PERIOD_MONTHS: Record<BillingPeriod, number> = {
  month: 1,
  quarter: 3,
  half_year: 6,
  year: 12,
};

/**
 * Скидка по периоду (множитель к итоговой сумме). 3 мес = -5%, 6 мес = -10%,
 * 12 мес = -20%. Месяц — без скидки. Выровнено с outreachos.pro лендингом.
 */
export const BILLING_PERIOD_DISCOUNT: Record<BillingPeriod, number> = {
  month: 1,
  quarter: 0.95,
  half_year: 0.9,
  year: 0.8,
};

/* ─── Test shop tariffs ──────────────────────────────────────────────────
 * Когда admin включает is_test_shop в модалке, подписка попадает в
 * тестовый магазин YooKassa с этими ценами и сокращёнными сроками.
 * Quarter не поддерживается — admin-UI его не показывает.
 * Месяц/полугодие/год прод-периодов отображаются на 10/15/20 минут.
 */
export const TEST_TARIFF_PRICE: Record<PaidTariffType, Partial<Record<BillingPeriod, number>>> = {
  [TARIFF_LAUNCH]: { month: 10, half_year: 15, year: 20 },
  [TARIFF_FLOW]:   { month: 11, half_year: 16, year: 21 },
};

export const TEST_PERIOD_MINUTES_BY_PERIOD: Partial<Record<BillingPeriod, number>> = {
  month:     10,
  half_year: 15,
  year:      20,
};

/** Setup-трайл в тестовом магазине — +5 мин (в прод это SETUP_DAYS=15 дней). */
export const TEST_SETUP_MINUTES = 5;

/**
 * Считает сумму к оплате за выбранный период с учётом скидки. Для custom
 * возвращает null — сумма проставляется вручную при выставлении счёта.
 *
 * При isTestShop=true возвращает фиксированную тест-цену из TEST_TARIFF_PRICE
 * (или null если связка tariff+period не определена — например, quarter).
 */
export function calcBillingAmount(
  tariff: TariffType,
  period: BillingPeriod,
  isTestShop = false,
): number | null {
  if (tariff === TARIFF_SCALE) return null;
  if (isTestShop) {
    return TEST_TARIFF_PRICE[tariff][period] ?? null;
  }
  const base = TARIFF_MONTHLY_PRICE[tariff] * BILLING_PERIOD_MONTHS[period];
  return Math.round(base * BILLING_PERIOD_DISCOUNT[period]);
}
