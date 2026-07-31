import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { ExpenseRow } from '@/lib/expenses/types';

/**
 * PostgREST по умолчанию отдаёт максимум 1000 строк и делает это МОЛЧА —
 * без пагинации годовой период просто обрезался бы, а дашборд показывал бы
 * заниженную сумму без единой ошибки в логах. Поэтому читаем страницами.
 */
const PAGE_SIZE = 1000;
const MAX_ROWS = 100_000;

/**
 * Колонки витрины, которые читает дашборд.
 *
 * Каст результата к `ExpenseRow[]` ниже непроверяем: если в `expenses_v`
 * переименуют колонку, TypeScript этого не заметит, а дашборд покажет 0 ₽ без
 * единой ошибки. Единственное, что здесь можно удержать статически, —
 * совпадение списка полей с ключами `ExpenseRow`; за этим следит
 * `tests/lib/expensesRowsSelect.test.ts`, который читает реальный аргумент
 * `.select()` и сверяет его с типом.
 */
const SELECT_COLUMNS =
  'source, source_ref, occurred_on_msk, amount, currency, counterparty, counterparty_inn, details, vendor_id, vendor_name, category, classification_method, amount_rub';

export interface RowFilters {
  from: string;
  to: string;
  source?: string | null;
  /**
   * Одна категория либо список. Список нужен показателю «перемещения»: он
   * считается по всему `TRANSFER_CATEGORIES`, а не по захардкоженной строке.
   */
  category?: string | readonly string[] | null;
  vendorId?: string | null;
  unclassifiedOnly?: boolean;
}

export async function fetchExpenseRows(filters: RowFilters): Promise<ExpenseRow[]> {
  if (!supabaseAdmin) throw new Error('Server misconfigured: supabaseAdmin недоступен');

  const rows: ExpenseRow[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    let query = supabaseAdmin
      .from('expenses_v')
      .select(SELECT_COLUMNS)
      .gte('occurred_on_msk', filters.from)
      .lte('occurred_on_msk', filters.to)
      // Порядок обязан быть полным и стабильным: без второго ключа строки с
      // одинаковой датой могут перетасоваться между страницами, и постраничная
      // выборка начнёт терять и дублировать операции.
      .order('occurred_on_msk', { ascending: false })
      .order('source_ref', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (filters.source) query = query.eq('source', filters.source);
    if (Array.isArray(filters.category)) {
      query = query.in('category', filters.category as string[]);
    } else if (typeof filters.category === 'string' && filters.category) {
      query = query.eq('category', filters.category);
    }
    if (filters.vendorId) query = query.eq('vendor_id', filters.vendorId);
    if (filters.unclassifiedOnly) query = query.is('vendor_id', null);

    const { data, error } = await query;
    if (error) throw new Error(`expenses_v: ${error.message}`);

    const page = (data ?? []) as unknown as ExpenseRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }

  // Потолок выбран — дальше мы бы снова тихо обрезали период, ровно от чего и
  // защищались. Молчать нельзя, поэтому оставляем след в логах.
  console.warn(
    `[expenses] выборка витрины упёрлась в потолок ${MAX_ROWS} строк ` +
      `(${filters.from}..${filters.to}) — итог занижен, нужен более узкий период или агрегация в SQL`,
  );
  return rows;
}
