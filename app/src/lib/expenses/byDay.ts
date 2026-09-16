import type { ExpenseRow, IncomeRow } from '@/lib/expenses/types';

/**
 * Раскладка операций по дням — для раскрывающегося списка в разделе «Деньги».
 *
 * Графики отвечают на вопрос «сколько», а этот список — на вопрос «куда
 * именно ушло» и «откуда именно пришло»: день, сумма за день, а внутри — сами
 * операции. Разбор идёт по московскому дню (`occurred_on_msk` уже приходит из
 * витрины в МСК), поэтому здесь только группировка, без арифметики с зонами.
 */

export interface DayGroup<Row> {
  /** `YYYY-MM-DD` по МСК. */
  date: string;
  count: number;
  /** Сумма в рублях по строкам, где рублёвая сумма известна. */
  total: number;
  /**
   * Сколько операций дня остались без рублёвой суммы (валютная трата, для
   * которой не подтянулся курс ЦБ). Показывается рядом с итогом: иначе день
   * молча выглядел бы дешевле, чем он есть — та же причина, по которой в
   * выгрузке у таких строк пустая клетка, а не ноль.
   */
  withoutRate: number;
  items: Row[];
}

type DatedRow = { occurred_on_msk: string; amount_rub: number | null };

export function groupByDay<Row extends DatedRow>(rows: Row[]): DayGroup<Row>[] {
  const byDate = new Map<string, DayGroup<Row>>();
  for (const row of rows) {
    const date = row.occurred_on_msk;
    let group = byDate.get(date);
    if (!group) {
      group = { date, count: 0, total: 0, withoutRate: 0, items: [] };
      byDate.set(date, group);
    }
    group.count += 1;
    if (row.amount_rub === null) group.withoutRate += 1;
    else group.total += row.amount_rub;
    group.items.push(row);
  }
  // Свежий день сверху: список читают сверху вниз и начинают с последнего.
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

export type ExpenseDayGroup = DayGroup<ExpenseRow>;
export type IncomeDayGroup = DayGroup<IncomeRow>;
