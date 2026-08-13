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
 * 2. ИНН у сделок заполнен плохо — на 12.08.2026 283 сделки из 5238. Значит
 *    цифра денег НЕ полная и не может быть полной, пока менеджеры не начнут
 *    заполнять поле. Поэтому рядом всегда показывается покрытие («ИНН есть у
 *    N договоров из M»): без него «пришло 400к» читается как «мы заработали
 *    400к», хотя правильное чтение — «мы смогли связать 400к».
 *
 * 3. Продления не считаются первичкой. Правило берётся готовым из разметки
 *    продлений: первый приход от ИНН — всегда первичка, последующие либо
 *    размечены человеком/автоматчиком, либо ждут разбора. Неразобранные в
 *    деньги НЕ идут (иначе продление годовалого клиента станет новой
 *    продажей), но и не пропадают — показываются отдельной строкой «ждут
 *    разбора», чтобы занижение было видно, а не молчаливо.
 *
 * 4. Спорные платежи (один ИНН — несколько сделок воронки) тоже не относятся
 *    ни к менеджеру, ни к каналу: выбирать за человека, какая из двух сделок
 *    «та самая», значит выдумать данные. Они идут отдельной строкой.
 */
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { extractCustomField } from '@/lib/leadsReport/extractCustomField';

/** Имя кастомного поля AMO с ИНН. Дублируется в SQL (`first_sales_payments`,
 *  `apply_renewal_marks`) — SQL не может импортировать эту константу. */
export const INN_FIELD_NAME = 'ИНН';

export type RenewalState = 'first' | 'not_renewal' | 'renewal' | 'pending';

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
  /** У скольких договоров окна вообще заполнен ИНН — знаменатель честности. */
  contractsWithInn: number;
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

/** Первичка ли это вообще. `pending` сюда не входит намеренно — см. п.3 в
 *  заголовке файла. */
export function isFirstSaleMoney(state: RenewalState): boolean {
  return state === 'first' || state === 'not_renewal';
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
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error) throw error;
  return (data ?? []) as FirstSalesPaymentRow[];
}
