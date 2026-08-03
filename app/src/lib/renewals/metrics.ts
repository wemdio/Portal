/**
 * Метрики дашборда продлений.
 *
 * Источник — НЕ поле `projects.project_type` (ручная пометка в карточке
 * проекта, 32 записи). Продление — это строка `renewal_marks` с
 * `is_renewal = true`, соединённая с породившей её `bank_transactions`:
 *   - дата продления — `occurred_at` (дата ПЛАТЕЖА, а не дата, когда человек
 *     подтвердил отметку в AMO или на экране разбора);
 *   - сумма продления — `amount` (сумма ПЛАТЕЖА, а не число из текста
 *     комментария/задачи — текст используется только для сверки при
 *     автоподтверждении, см. `apply_renewal_marks()` в
 *     `supabase/migrations/20260803_0002_renewal_marks.sql` и
 *     `20260803_0004_renewal_marks_note_text.sql`).
 *
 * `renewal_marks` сама по себе не хранит весь список кандидатов — кандидат
 * это ВЫЧИСЛЯЕМОЕ множество (повторный приход с ИНН, кроме первого платежа
 * этого ИНН), которого в `renewal_marks` может ещё не быть вовсе. Поэтому
 * этот файл тянет ДВЕ выборки — `renewal_marks` целиком и полную историю
 * приходов с ИНН — и сам восстанавливает то же ранжирование "какой платёж по
 * счёту у ИНН", которое использует SQL-функция `apply_renewal_marks()`, чтобы
 * посчитать счётчик "не разобрано" (см. `computeRenewalsMetrics`).
 *
 * Стиль и границы — по образцу `firstSales/metrics.ts`:
 *   1. Чистая функция `computeRenewalsMetrics` + отдельные функции выборки.
 *   2. Группировка по датам — только через `bucketKey`/`buildBuckets` из
 *      `firstSales/buckets.ts`: границы МСК там уже решены, копировать нельзя
 *      — вторая реализация разъедется с первой, и два дашборда начнут
 *      показывать разные месяцы.
 *
 * Старый расчёт по `projects.project_type`/`project_periods` отсюда убран
 * целиком, а не оставлен рядом: две цифры «продлений» под одним названием —
 * гарантированный спор о том, какая правильная (см. задачу).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { bucketKey, buildBuckets, type GroupBy } from '@/lib/firstSales/buckets';

/** Совпадает с CHECK-констрейнтом `renewal_marks.method`
 *  (`20260803_0004_renewal_marks_note_text.sql`). */
export type RenewalMarkMethod = 'note_text' | 'task_text' | 'project_type' | 'manual' | 'not_renewal';

export type RenewalMarkRow = {
  transaction_id: number;
  is_renewal: boolean;
  method: RenewalMarkMethod;
  amo_deal_id: number | null;
  note: string | null;
};

export type RevenueTransactionRow = {
  id: number;
  payer_inn: string | null;
  payer_name: string | null;
  /** `numeric(14,2)` в БД — PostgREST/Supabase-JS отдаёт такие колонки уже
   *  числом (тот же приём, что `amount`/`amount_rub` в `expenses/types.ts`),
   *  поэтому, в отличие от старого `projects.budget` (текстовое поле), здесь
   *  не нужен защитный парсинг вроде `parseAmount` — источник истины сам по
   *  себе числовой. */
  amount: number;
  occurred_at: string;
  purpose: string | null;
};

export type RenewalSeriesBucket = {
  key: string;
  count: number;
  revenue: number;
};

export type RenewalsTotals = {
  /** Продлений (`is_renewal=true`) с датой ПЛАТЕЖА в [from, to]. */
  count: number;
  /** Сумма `amount` по тем же продлениям. */
  revenue: number;
  avgCheck: number | null;
  medianCheck: number | null;
  cycleAvgDays: number | null;
  cycleMedianDays: number | null;
  /** Сколько продлений периода реально дали цикл (числитель). Почти всегда
   *  равно `cycleCandidates` — см. doc-комментарий `computeRenewalsMetrics`
   *  про якоря цикла, — но может быть меньше, если у платежа-продления
   *  пустой ИНН после обрезки пробелов (защитный случай). */
  cycleSampleSize: number;
  /** Знаменатель — он же `count`, продублирован для удобства UI. */
  cycleCandidates: number;
  /**
   * «Не разобрано» — кандидаты (повторный приход с ИНН, не первый платёж
   * этого ИНН) с датой платежа в [from, to], у которых ещё НЕТ строки в
   * `renewal_marks` вовсе — ни «продление», ни «не продление». Пока эта
   * цифра большая, числам `count`/`revenue` за тот же период верить нельзя:
   * часть из них станет продлениями только после разбора человеком.
   *
   * Период тот же, что у остальных плиток ряда (см. отчёт по задаче,
   * вопрос 2, и `unassignedLeads` в `firstSales/metrics.ts` — тот же приём:
   * там «лиды без канала» тоже считаются внутри окна `[from, to]`, а не
   * сквозной цифрой по всей истории). Каждая плитка КПИ-ряда отвечает на
   * вопрос "что мы знаем про выбранный период" — неразобранные кандидаты
   * периода прямо отвечают на этот же вопрос («насколько цифрам периода
   * можно верить»), а не на отдельный вопрос про весь бэклог целиком.
   */
  unresolved: number;
};

export type RenewalsResult = {
  series: RenewalSeriesBucket[];
  totals: RenewalsTotals;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** ИНН без пробелов по краям, `null`/пусто → `null` — единая нормализация,
 *  использованная во всех местах ниже, которые группируют платежи по ИНН. */
function normInn(raw: string | null): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function occurredAtTime(row: RevenueTransactionRow): number {
  return new Date(row.occurred_at).getTime();
}

/**
 * Считает метрики продлений за окно `[from, to]`.
 *
 * `marks` — вся таблица `renewal_marks` (и продления, и `not_renewal`, и уже
 * решённые вручную — нужны целиком, чтобы отличить «кандидат без решения» от
 * «кандидат, решённый как не продление»). `transactions` — ВСЯ история
 * приходов с ИНН (`direction=credit, is_revenue=true, payer_inn заполнен`),
 * а не только окно `[from, to]`: без полной истории нельзя понять, каким по
 * счёту для этого ИНН является платёж внутри окна — платёж, третий по счёту
 * для клиента, в обрезанной по датам выборке выглядел бы первым и терял
 * статус кандидата.
 *
 * ### Якорь цикла — почему не «просто предыдущий платёж»
 *
 * Наивное «предыдущий платёж этого ИНН» ломается на реальном примере из
 * плана (ООО «СМАРТВЭЙ», ИНН 7714379242): между подтверждённым продлением
 * 2026-06-14 (задача без слова «продление», НЕ подтверждено) и следующим
 * подтверждённым продлением 2026-07-30 лежит платёж 2026-01-22 за телеграм
 * (другая услуга) и ещё один неподтверждённый платёж — ни один из них не
 * граница периода, оба просто транши/другие услуги внутри уже идущего
 * периода. Взять «предыдущий платёж» буквально — значит мерить цикл до
 * ближайшего шума, а не до конца прошлого периода.
 *
 * Поэтому якорь для платежа-продления X этого ИНН — не предыдущий платёж
 * вообще, а ПРЕДЫДУЩАЯ ГРАНИЦА ПЕРИОДА: последнее из двух — либо самый
 * ранний платёж ИНН (это и есть первичка, начало периода 1 — она специально
 * не считается кандидатом в `apply_renewal_marks()`, но как точка отсчёта
 * цикла годится), либо более раннее подтверждённое продление того же ИНН,
 * если оно есть. Тогда: цикл первого продления = от первички до него; цикл
 * каждого следующего = от предыдущего ПОДТВЕРЖДЁННОГО продления, а не от
 * случайного платежа между ними.
 */
export function computeRenewalsMetrics(
  marks: RenewalMarkRow[],
  transactions: RevenueTransactionRow[],
  from: Date,
  to: Date,
  groupBy: GroupBy,
): RenewalsResult {
  const fromKey = bucketKey(from, 'day');
  const toKey = bucketKey(to, 'day');

  const keys = buildBuckets(from, to, groupBy);
  const series = new Map<string, RenewalSeriesBucket>(
    keys.map((key) => [key, { key, count: 0, revenue: 0 }]),
  );

  const txnById = new Map<number, RevenueTransactionRow>();
  for (const t of transactions) txnById.set(t.id, t);

  // Платежи с ИНН, сгруппированные по ИНН и отсортированные по возрастанию
  // (occurred_at, id) — то же упорядочивание, что `row_number() over (
  // partition by payer_inn order by occurred_at asc, id asc)` в
  // apply_renewal_marks(). list[0] каждой группы — первый платёж ИНН
  // (первичка, не кандидат); остальные — кандидаты.
  const byInn = new Map<string, RevenueTransactionRow[]>();
  for (const t of transactions) {
    const inn = normInn(t.payer_inn);
    if (!inn) continue;
    const list = byInn.get(inn);
    if (list) list.push(t);
    else byInn.set(inn, [t]);
  }
  for (const list of byInn.values()) {
    list.sort((a, b) => {
      const diff = occurredAtTime(a) - occurredAtTime(b);
      return diff !== 0 ? diff : a.id - b.id;
    });
  }

  const candidateIds = new Set<number>();
  for (const list of byInn.values()) {
    for (let i = 1; i < list.length; i += 1) candidateIds.add(list[i].id);
  }

  const decidedIds = new Set(marks.map((m) => m.transaction_id));

  // Якоря цикла по ИНН: первый платёж ИНН + время каждого подтверждённого
  // продления этого ИНН (см. doc-комментарий функции). Инициализируем первым
  // платежом каждого ИНН, затем добавляем подтверждённые продления.
  const boundariesByInn = new Map<string, number[]>();
  for (const [inn, list] of byInn) {
    boundariesByInn.set(inn, [occurredAtTime(list[0])]);
  }
  for (const mark of marks) {
    if (!mark.is_renewal) continue;
    const txn = txnById.get(mark.transaction_id);
    if (!txn) continue;
    const inn = normInn(txn.payer_inn);
    if (!inn) continue;
    const t = occurredAtTime(txn);
    const list = boundariesByInn.get(inn);
    if (list) list.push(t);
    else boundariesByInn.set(inn, [t]);
  }
  for (const list of boundariesByInn.values()) list.sort((a, b) => a - b);

  /** Дней с последней границы периода этого ИНН СТРОГО раньше `t` (то есть не
   *  считая саму `t`, даже если она сама есть в списке границ). `null` — нет
   *  ни одной более ранней границы (не должно случаться для платежа, который
   *  прошёл через кандидаты, — первый платёж ИНН всегда раньше — но список
   *  границ инициализируется только для ИНН, встретившихся в `transactions`,
   *  поэтому защитный `null` на случай расхождения данных не помешает). */
  function cycleDaysBefore(inn: string, t: number): number | null {
    const list = boundariesByInn.get(inn);
    if (!list) return null;
    let prev: number | null = null;
    for (const b of list) {
      if (b < t) prev = b;
      else break; // список отсортирован по возрастанию — дальше только >= t
    }
    if (prev === null) return null;
    const days = (t - prev) / DAY_MS;
    return Number.isFinite(days) && days >= 0 ? days : null;
  }

  const totals: RenewalsTotals = {
    count: 0,
    revenue: 0,
    avgCheck: null,
    medianCheck: null,
    cycleAvgDays: null,
    cycleMedianDays: null,
    cycleSampleSize: 0,
    cycleCandidates: 0,
    unresolved: 0,
  };

  const checks: number[] = [];
  const cycles: number[] = [];

  for (const mark of marks) {
    if (!mark.is_renewal) continue;
    const txn = txnById.get(mark.transaction_id);
    if (!txn) continue; // защитный случай: отметка на транзакцию вне выборки

    const paymentKey = bucketKey(new Date(txn.occurred_at), 'day');
    if (paymentKey < fromKey || paymentKey > toKey) continue;

    totals.count += 1;
    totals.revenue += txn.amount;
    checks.push(txn.amount);

    const bucket = series.get(bucketKey(new Date(txn.occurred_at), groupBy));
    if (bucket) {
      bucket.count += 1;
      bucket.revenue += txn.amount;
    }

    const inn = normInn(txn.payer_inn);
    if (inn) {
      const days = cycleDaysBefore(inn, occurredAtTime(txn));
      if (days !== null) cycles.push(days);
    }
  }

  totals.cycleCandidates = totals.count;
  totals.cycleSampleSize = cycles.length;
  totals.avgCheck = checks.length > 0 ? checks.reduce((a, b) => a + b, 0) / checks.length : null;
  totals.medianCheck = median(checks);
  totals.cycleAvgDays = cycles.length > 0 ? cycles.reduce((a, b) => a + b, 0) / cycles.length : null;
  totals.cycleMedianDays = median(cycles);

  // «Не разобрано»: кандидаты без строки в renewal_marks вовсе, с датой
  // платежа внутри того же [from, to] — см. doc-комментарий у поля
  // RenewalsTotals.unresolved про выбор периода вместо сквозной цифры.
  for (const id of candidateIds) {
    if (decidedIds.has(id)) continue;
    const txn = txnById.get(id);
    if (!txn) continue;
    const key = bucketKey(new Date(txn.occurred_at), 'day');
    if (key < fromKey || key > toKey) continue;
    totals.unresolved += 1;
  }

  return {
    series: keys.map((k) => series.get(k) as RenewalSeriesBucket),
    totals,
  };
}

/**
 * PostgREST по умолчанию отдаёт максимум 1000 строк за запрос и делает это
 * МОЛЧА — без пагинации история старше тысячной строки просто обрезалась бы,
 * а метрики занижались бы без единой ошибки в логах (тот же приём и та же
 * причина, что в `expenses/rows.ts`). `MAX_ROWS` — не бизнес-лимит, а защита
 * от бесконечного цикла, если пагинация где-то сломается.
 */
const PAGE_SIZE = 1000;
const MAX_ROWS = 100_000;

const REVENUE_TRANSACTION_COLUMNS = 'id, payer_inn, payer_name, amount, occurred_at, purpose';

/**
 * Приходы (`direction=credit`, `is_revenue=true`) с непустым ИНН плательщика
 * — то же множество, из которого `apply_renewal_marks()` (SQL) вычисляет
 * кандидатов. Тянем ВСЮ историю, а не окно `[from, to]` — см. doc-комментарий
 * `computeRenewalsMetrics` про то, зачем нужна полная история для
 * ранжирования «какой платёж по счёту у ИНН».
 *
 * `.not('payer_inn', 'is', null)` отсекает только NULL; строки из пробелов
 * («   ») проходят фильтр на уровне SQL и отсеиваются уже в
 * `computeRenewalsMetrics` через `normInn` — так же, как `coalesce(btrim(...),
 * '') <> ''` делает это в SQL-функции.
 */
export async function fetchRevenueTransactions(db: SupabaseClient): Promise<RevenueTransactionRow[]> {
  const rows: RevenueTransactionRow[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const { data, error } = await db
      .from('bank_transactions')
      .select(REVENUE_TRANSACTION_COLUMNS)
      .eq('direction', 'credit')
      .eq('is_revenue', true)
      .not('payer_inn', 'is', null)
      .order('occurred_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as RevenueTransactionRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
  throw new Error(`fetchRevenueTransactions: строк больше ${MAX_ROWS} — пагинация не успевает, проверь потолок`);
}

const RENEWAL_MARK_COLUMNS = 'transaction_id, is_renewal, method, amo_deal_id, note';

/** Решения по кандидатам целиком — и автоматические (`apply_renewal_marks`),
 *  и ручные, и `is_renewal=true`, и `not_renewal`. Нужны целиком: чтобы
 *  отличить «кандидат без решения» («не разобрано») от «кандидат, решённый
 *  как не продление», важно видеть решение независимо от `is_renewal`. */
export async function fetchRenewalMarks(db: SupabaseClient): Promise<RenewalMarkRow[]> {
  const rows: RenewalMarkRow[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const { data, error } = await db
      .from('renewal_marks')
      .select(RENEWAL_MARK_COLUMNS)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as RenewalMarkRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
  throw new Error(`fetchRenewalMarks: строк больше ${MAX_ROWS} — пагинация не успевает, проверь потолок`);
}
