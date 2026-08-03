import type { RenewalMarkMethod, RenewalMarkRow, RevenueTransactionRow } from '@/lib/renewals/metrics';
import { bucketKey } from '@/lib/firstSales/buckets';

/**
 * Строка таблицы продлений на дашборде.
 *
 * Одна строка = одно подтверждённое продление (`renewal_marks.is_renewal =
 * true`), соединённое с породившей его `bank_transactions`. `paymentDate` —
 * ключ корзины дня в МСК (`YYYY-MM-DD`, тот же формат, что возвращает
 * `bucketKey(_, 'day')`) и всегда заполнен: у банковского платежа дата есть
 * всегда, в отличие от старого `projects.payment_date` (текстовое поле,
 * заполнялось руками, могло быть пустым или мусорным) — поэтому, в отличие от
 * старой версии этого файла, здесь больше нет ни `isPlanned`, ни строк «без
 * даты»: обоим было не из чего появиться на новом источнике.
 */
export type RenewalTableRow = {
  transactionId: number;
  client: string | null;
  inn: string | null;
  amount: number;
  paymentDate: string;
  method: RenewalMarkMethod;
  methodLabel: string;
  note: string | null;
  purpose: string | null;
  amoDealId: number | null;
  amoDealUrl: string | null;
};

/** Человеческое название способа подтверждения — для колонки «Подтверждено».
 *  `not_renewal` в эту таблицу никогда не попадает (см. `buildRenewalTableRows`
 *  — фильтр `is_renewal`), но `Record` по всем значениям `RenewalMarkMethod`
 *  держит соответствие исчерпывающим на уровне типов: новый метод в
 *  CHECK-констрейнте `renewal_marks.method` не пройдёт компиляцию, пока сюда
 *  не добавят подпись. */
const METHOD_LABELS: Record<RenewalMarkMethod, string> = {
  note_text: 'комментарий AMO о продлении',
  task_text: 'текст задачи AMO',
  project_type: 'тип проекта (устаревший сигнал)',
  manual: 'вручную',
  not_renewal: 'не продление',
};

/**
 * Собирает строки таблицы продлений: только `is_renewal = true`, соединённые
 * с транзакцией по `transaction_id`. Без периода (`window === null`) отдаёт
 * все продления за всю историю; с периодом — только те, чья дата ПЛАТЕЖА
 * (`occurred_at`, приведённая к дню в МСК) попадает в `[fromKey, toKey]`
 * включительно.
 *
 * Период фильтрует таблицу так же, как `computeRenewalsMetrics` фильтрует
 * KPI-плитки, — той же границей (`bucketKey(_, 'day')`), чтобы таблица
 * показывала ровно те продления, которые вошли в `totals.count`/`totals.revenue`.
 * Две выборки под одним фильтром, посчитанные по-разному, разошлись бы, и
 * объяснять расхождение пришлось бы в переписке.
 *
 * `amoBaseUrl` — базовый URL AMO (например, `https://example.amocrm.ru`) или
 * `null`, если переменная окружения не задана; параметром, а не чтением
 * `process.env` внутри — та же причина, что и у остальных параметров этого
 * модуля: чистая функция должна тестироваться без побочных зависимостей.
 */
export function buildRenewalTableRows(
  marks: RenewalMarkRow[],
  transactions: RevenueTransactionRow[],
  amoBaseUrl: string | null,
  window: { fromKey: string; toKey: string } | null = null,
): RenewalTableRow[] {
  const txnById = new Map(transactions.map((t) => [t.id, t]));
  const result: RenewalTableRow[] = [];

  for (const mark of marks) {
    if (!mark.is_renewal) continue;
    const txn = txnById.get(mark.transaction_id);
    if (!txn) continue; // защитный случай: отметка на транзакцию вне выборки

    const paymentDate = bucketKey(new Date(txn.occurred_at), 'day');

    if (window !== null) {
      if (paymentDate < window.fromKey || paymentDate > window.toKey) continue;
    }

    result.push({
      transactionId: txn.id,
      client: txn.payer_name,
      inn: txn.payer_inn,
      amount: txn.amount,
      paymentDate,
      method: mark.method,
      methodLabel: METHOD_LABELS[mark.method],
      note: mark.note,
      purpose: txn.purpose,
      amoDealId: mark.amo_deal_id,
      amoDealUrl:
        amoBaseUrl && mark.amo_deal_id !== null ? `${amoBaseUrl}/leads/detail/${mark.amo_deal_id}` : null,
    });
  }

  // Свежие сверху — тот же порядок по умолчанию, что был в старой версии
  // таблицы. Даты всегда заполнены (в отличие от старой версии), поэтому,
  // в отличие от неё, здесь не нужна отдельная ветка для «без даты — в конец».
  result.sort((a, b) => {
    if (a.paymentDate === b.paymentDate) return 0;
    return a.paymentDate > b.paymentDate ? -1 : 1;
  });

  return result;
}
