/**
 * Реальные деньги дашборда первички: банковский приход, связанный со сделкой
 * воронки по ИНН плательщика.
 *
 * Что здесь важно понимать до чтения цифры на экране:
 *
 * 1. Связка идёт по ИНН и только по ИНН. Имя плательщика в выписке («ООО
 *    "РОМАШКА"») не сходится с названием в AMO («Ромашка»), суммы совпадают у
 *    половины платежей месяца. ИНН есть по обе стороны и не допускает
 *    толкований. Тот же ключ уже использует `apply_renewal_marks()`.
 *
 * 2. ИНН у сделок заполнен плохо — 232 сделки из 5540 на 09.09.2026. Но там,
 *    где дошло до денег, его заполняют: у всех 12 выигранных сделок августа
 *    ИНН есть. Поэтому покрытие («ИНН есть у N продаж из M») по-прежнему
 *    показывается рядом с суммой — не как извинение, а как проверка: как
 *    только оно просядет, занижение будет видно сразу, а не через месяц.
 *
 * 3. Продления не считаются первичкой, а рассрочка — считается. Первый приход
 *    от ИНН — всегда первичка. Следующий приход, укладывающийся в сумму той же
 *    сделки, — транш того же договора ('installment'), и он идёт в деньги:
 *    договор на 229 000 ₽ тремя платежами это одна продажа, а не продажа и два
 *    продления. Приход, вышедший за сумму сделки, снова становится кандидатом
 *    в продления: либо размечен человеком, либо ждёт разбора. Неразобранные в
 *    деньги НЕ идут, но и не пропадают — показываются отдельной строкой «ждут
 *    разбора», чтобы занижение было видно, а не молчаливо.
 *
 * 4. Спорные платежи (один ИНН — несколько сделок воронки) тоже не относятся
 *    ни к менеджеру, ни к каналу: выбирать за человека, какая из двух сделок
 *    «та самая», значит выдумать данные. Они идут отдельной строкой.
 *
 * 5. Экран обязан сходиться с выпиской. Поэтому сюда приходят ВСЕ приходы-
 *    выручка окна, а не только связанные с первичкой: ушедшее в продления и
 *    вовсе ни с чем не связанное (эквайринг) считается отдельными строками, а
 *    их сумма с деньгами первички даёт банковский итог. Пока этих строк не
 *    было, разницу между дашбордом и банком выясняли в переписке.
 */
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { extractCustomField } from '@/lib/leadsReport/extractCustomField';

/** Имя кастомного поля AMO с ИНН. Дублируется в SQL (`first_sales_payments`,
 *  `apply_renewal_marks`) — SQL не может импортировать эту константу. */
export const INN_FIELD_NAME = 'ИНН';

/** Воронка «Вторичные (и не только) продажи». Значение — то же, что у
 *  дашборда продлений (lib/renewals/funnel.ts): одна воронка, один источник
 *  правды, и расходиться этим двум числам нельзя. */
export const RENEWALS_PIPELINE_ID = Number(process.env.RENEWALS_PIPELINE_ID ?? '11176862');

export type RenewalState = 'first' | 'installment' | 'not_renewal' | 'renewal' | 'pending';

export type FirstSalesPaymentRow = {
  transaction_id: number;
  occurred_at: string;
  /** Рубли. PostgREST отдаёт numeric числом, но приводим явно — цена ошибки
   *  здесь конкатенация строк вместо сложения. */
  amount: number | string;
  payer_inn: string | null;
  payer_name: string | null;
  /** Сделка воронки; осмыслен только при `deal_matches === 1`. */
  amo_deal_id: number | null;
  deal_matches: number;
  /** Сколько сделок воронки ПРОДЛЕНИЙ делят этот ИНН. Нужен, чтобы показать,
   *  куда ушла разница между выпиской и деньгами первички. */
  renewal_deal_matches: number;
  renewal_state: RenewalState;
};

/** Деньги окна. Всё в рублях, кроме счётчиков платежей. */
export type MoneyTotals = {
  /** Отнесено к сделкам воронки — то, что показывает карточка. */
  received: number;
  payments: number;
  /** Один ИНН — несколько сделок воронки. Деньги реальные, адресат неизвестен. */
  ambiguous: number;
  ambiguousPayments: number;
  /** Кандидаты в продления, которых ещё не разобрали. */
  pending: number;
  pendingPayments: number;
  /** У скольких продаж окна вообще заполнен ИНН — знаменатель честности. */
  contractsWithInn: number;
  /** Ушло в продления: ИНН нашёлся в воронке продлений либо платёж размечен
   *  человеком как продление. Первичкой это не является — но и молчать о
   *  нём нельзя, иначе экран не сходится с выпиской. */
  renewals: number;
  renewalsPayments: number;
  /** Приходы, не связанные ни с одной сделкой: эквайринг, платежи клиентов
   *  без сделки в AMO. */
  unlinked: number;
  unlinkedPayments: number;
  /** Весь приход-выручка окна по банкам — контрольная сумма экрана. */
  bankTotal: number;
  bankPayments: number;
};

export function emptyMoneyTotals(): MoneyTotals {
  return {
    received: 0,
    payments: 0,
    ambiguous: 0,
    ambiguousPayments: 0,
    pending: 0,
    pendingPayments: 0,
    contractsWithInn: 0,
    renewals: 0,
    renewalsPayments: 0,
    unlinked: 0,
    unlinkedPayments: 0,
    bankTotal: 0,
    bankPayments: 0,
  };
}

/**
 * ИНН, очищенный до цифр, если получилось 10 (юрлицо) или 12 (ИП) — иначе
 * null. Зеркало SQL-функции `public.norm_inn`: обе стороны должны нормализовать
 * одинаково, иначе покрытие на экране разойдётся со связкой в базе.
 */
export function normalizeInn(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  return /^(\d{10}|\d{12})$/.test(digits) ? digits : null;
}

/** ИНН сделки из `raw` AMO. null — поле не заполнено или заполнено мусором. */
export function dealInn(raw: unknown): string | null {
  return normalizeInn(extractCustomField(raw, INN_FIELD_NAME));
}

/**
 * Первичка ли это вообще.
 *
 * `installment` входит: это очередной транш по уже посчитанной сделке, а не
 * новая продажа клиенту — деньги того же договора (см. п.3 в заголовке).
 * `pending` не входит намеренно — решение по нему ещё не принято.
 */
export function isFirstSaleMoney(state: RenewalState): boolean {
  return state === 'first' || state === 'installment' || state === 'not_renewal';
}

/**
 * Можно ли отнести платёж к конкретной сделке (а значит — к менеджеру и
 * каналу). `deal_matches === 1` — единственный случай, когда `amo_deal_id`
 * что-то значит.
 */
export function attributablePayment(row: FirstSalesPaymentRow): boolean {
  return isFirstSaleMoney(row.renewal_state)
    && row.deal_matches === 1
    && row.amo_deal_id != null;
}

/** Сумма платежа числом. Возвраты и нули отсекаются вызывающим кодом. */
export function paymentAmount(row: FirstSalesPaymentRow): number {
  const n = typeof row.amount === 'number' ? row.amount : Number(row.amount);
  return Number.isFinite(n) ? n : 0;
}

export async function fetchFirstSalesPayments(
  db: SupabaseClient,
  pipelineId: number,
  from: Date,
  to: Date,
): Promise<FirstSalesPaymentRow[]> {
  const { data, error } = await db.rpc('first_sales_payments', {
    p_pipeline_id: pipelineId,
    // Воронка продлений — вторым параметром: по ней функция помечает приходы,
    // которые ушли не в первичку, и без этого экран не сходился бы с выпиской.
    p_renewals_pipeline_id: RENEWALS_PIPELINE_ID,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) throw error;
  return (data ?? []) as FirstSalesPaymentRow[];
}

/**
 * Сделка → рубли, отнесённые к ней в окне.
 *
 * Правила отбора те же, что в `computeFirstSalesSeries`: только положительные
 * приходы внутри окна, не продления, не «ждут разбора» и не спорные — то есть
 * ровно та сумма, которая стоит в столбце «Деньги» разбивки. Нужна списку
 * сделок под строкой: без неё он не может показать, за счёт чего сделка попала
 * в период, и оплаченная в августе сделка из марта выглядела бы случайной.
 */
export function moneyByDeal(
  payments: FirstSalesPaymentRow[],
  from: Date,
  to: Date,
): Map<number, number> {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const byDeal = new Map<number, number>();
  for (const p of payments) {
    const amount = paymentAmount(p);
    if (amount <= 0) continue;
    const t = new Date(p.occurred_at).getTime();
    if (!Number.isFinite(t) || t < fromMs || t > toMs) continue;
    if (!attributablePayment(p)) continue;
    const dealId = p.amo_deal_id as number;
    byDeal.set(dealId, (byDeal.get(dealId) ?? 0) + amount);
  }
  return byDeal;
}
