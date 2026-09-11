/**
 * Метрики дашборда первички.
 *
 * Отличия от `salesReport/metrics.ts` — сознательные, зафиксированы в спеке:
 *   1. Лиды считаются ВСЕ, включая закрытые в минус и лид-магниты. Отчёт продаж
 *      их выбрасывает; для дашборда это означало бы, что число лидов за май
 *      уменьшается задним числом каждый раз, когда майскую сделку закрывают.
 *      Прошлое должно быть неподвижным.
 *   2. Продажи считаются по ДАТЕ закрытия сделки в плюс, а не по этапу
 *      «Согласование договора»: за август 2026 этап дал 9 при 13 реально
 *      оплаченных сделках — пять продаж Егора этап вообще не проходили, а три
 *      прошли его в прошлых месяцах. Этап остаётся промежуточной отметкой в
 *      карточке сделки, метрикой перестал быть 09.09.2026. Встречи — по ДАТЕ
 *      записи разговора (`meeting_deal_links` → `tg_video_transcripts`), а не
 *      по этапу AMO вовсе: этап «Встреча проведена» засорён, см. `meetings.ts`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkArray, IN_CHUNK_SIZE } from '@/lib/cisLeads/batchedQuery';
import { bucketKey, buildBuckets, type GroupBy } from '@/lib/firstSales/buckets';
import { MEETINGS_RELIABLE_SINCE } from '@/lib/firstSales/meetings';
import {
  attributablePayment,
  dealInn,
  emptyMoneyTotals,
  paymentAmount,
  type FirstSalesPaymentRow,
  type MoneyTotals,
} from '@/lib/firstSales/money';
import {
  NO_SOURCE_KEY,
  NO_SOURCE_LABEL,
  resolveSource,
  type ResolvedSource,
} from '@/lib/firstSales/sources';

export type FirstSalesLeadRow = {
  amo_id: number;
  name: string | null;
  /** Компания из карточки AMO. Именно ею клиента зовут продажи и финансы,
   *  тогда как `name` сделки часто техническое («Заявка с сайта — форма…»). */
  company_name: string | null;
  /** Ответственный в AMO. Заполняется синком; null — сделка без ответственного. */
  responsible_name: string | null;
  created_at: string | null;
  first_qualified_at: string | null;
  first_meeting_at: string | null;
  first_contract_at: string | null;
  won_at: string | null;
  history_complete: boolean;
  /**
   * Текущий этап сделки в AMO. Нужен ради одного правила: закрытая в минус
   * (143) сделка квалом не считается — см. isQualifiedInWindow.
   */
  status_id: number | null;
  raw: unknown;
};

export type SeriesBucket = {
  key: string;
  leads: number;
  qualified: number;
  meetings: number;
  /** Сделки, закрытые в плюс в этой корзине. См. `isSaleInWindow`. */
  sales: number;
};

/**
 * Разбивка по ответственному менеджеру.
 *
 * Считается ровно теми же правилами, что и разбивка по источникам: лиды по
 * дате создания, продажи по дате закрытия, встречи по записям разговоров. Иначе
 * два среза одного дашборда давали бы разные суммы, и объяснить это было бы
 * нечем.
 */
export type ManagerBreakdown = {
  manager: string;
  leads: number;
  qualified: number;
  meetings: number;
  sales: number;
  /** Рубли, пришедшие в окне по сделкам этого менеджера. См. `money.ts`. */
  money: number;
};

export type SourceBreakdown = {
  /** Ключ группировки, он же значение `source` в API drill-down. */
  key: string;
  /** Название источника как заведено в AMO. */
  source: string;
  leads: number;
  qualified: number;
  meetings: number;
  sales: number;
  /** Рубли, пришедшие в окне по сделкам этого источника. См. `money.ts`. */
  money: number;
};

/** Пункт выпадашки фильтра. Считается ДО применения фильтра — см. комментарий
 *  в computeFirstSalesSeries. */
export type AvailableSource = { key: string; label: string; leads: number };

export type FirstSalesTotals = {
  leads: number;
  qualified: number;
  meetings: number;
  /** Сделки, закрытые в плюс в окне, — то, что продажи называют продажами. */
  sales: number;
  leadMagnets: number;
  noSourceLeads: number;
  wonCount: number;
  cycleAvgDays: number | null;
  cycleMedianDays: number | null;
  /**
   * false — окно целиком раньше `MEETINGS_RELIABLE_SINCE` (1 мая 2026), с
   * которой метрике встреч можно верить. До неё этап AMO двигали и без
   * разговора: май дал 152 сделки на этапе при 20 с записью разговора, июнь —
   * 207 при 60. Цифра за такой период не занижена, а раздута втрое, и UI
   * обязан показать прочерк вместо неё.
   */
  meetingsReliable: boolean;
  /** Дата вступления правила в силу — чтобы UI мог назвать её пользователю. */
  meetingsSince: string;
  /**
   * Реальные деньги окна — банковские приходы, связанные со сделками воронки
   * по ИНН. Отдельным объектом, а не полями в totals: у денег своя оговорка о
   * неполноте (ИНН заполнен у меньшинства сделок), и держать её рядом с самой
   * цифрой надёжнее, чем в соседнем поле, о котором легко забыть. См.
   * `money.ts`.
   */
  money: MoneyTotals;
};

export type FirstSalesSeries = {
  series: SeriesBucket[];
  bySource: SourceBreakdown[];
  availableSources: AvailableSource[];
  byManager: ManagerBreakdown[];
  totals: FirstSalesTotals;
};

/** Сделка без ответственного — отдельная строка, а не выброшенная. */
export const NO_MANAGER = 'Без ответственного';

function managerKey(name: string | null): string {
  const clean = (name ?? '').trim();
  return clean || NO_MANAGER;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Лид-магнит — сделка, автосозданная TG-ботом «Polza Site Feedback»:
 *  имя всегда с префиксом «Бот:». Из лидов не исключается, но считается
 *  отдельно, чтобы всплеск магнитов не читался как рост спроса. */
function isLeadMagnet(name: string | null): boolean {
  return typeof name === 'string' && name.trimStart().startsWith('Бот:');
}

function inWindow(value: string | null, from: Date, to: Date): boolean {
  if (!value) return false;
  const t = new Date(value).getTime();
  return Number.isFinite(t) && t >= from.getTime() && t <= to.getTime();
}

/**
 * Дата, с которой этап «Согласование договора» в AMO начал означать договор.
 *
 * До неё этап ставили и когда договор действительно правили, и когда его
 * просто отправили по просьбе клиента. Из-за этого за июнь 2026 туда попали
 * 169 сделок, из которых 162 умерли с нулевой суммой, — при том что реальных
 * договоров у продаж около двадцати в месяц. Разделить одно от другого задним
 * числом нечем: в данных нет признака, по которому это можно отличить.
 *
 * Егор с командой договорились (30.07.2026) ставить этап только при реальном
 * согласовании и правках. Поэтому договоры считаются с этой даты, а раньше
 * отдаётся `null` — прочерк, а не ноль: ноль читался бы как «договоров не
 * было», и это было бы враньём худшего сорта, чем отсутствие цифры.
 */
export const CONTRACT_RULE_SINCE = new Date(
  process.env.FIRST_SALES_CONTRACT_RULE_SINCE ?? '2026-07-30T00:00:00.000Z',
);

/**
 * Что именно этой сделки попало в выбранный период.
 *
 * Правила ОДНИ на всё: и на цифры разбивок, и на список сделок, который
 * раскрывается под строкой. Раньше список тянул всю выборку окна целиком, а
 * выборка сознательно шире периода (сделка могла прийти в 2024-м, а встреча
 * или оплата по ней — случиться сейчас). Из-за этого под строкой «269 лидов за
 * август» показывались сделки 2024 года, и читалось это как «фильтр периода не
 * работает». Теперь строка списка обязана иметь хотя бы одно попадание в
 * период, а какое именно — видно в отдельной колонке.
 */
/**
 * Какие ступени воронки достоверны для окна, кончающегося на `to`.
 *
 * Окно целиком раньше даты правила означает, что ступени НЕТ, а не что она
 * равна нулю: до этой даты записи разговоров не подписывали, и привязать их
 * нечем. Одна функция на всех, потому что правило читают в трёх местах —
 * сводка, воронка и список сделок рядом с ней, — и разъехавшись, они покажут
 * разное на одном экране.
 *
 * Продажи такой оговорки не требуют: они считаются по дате закрытия сделки,
 * а она синкается с 2024 года и достоверна на всю историю — в отличие от
 * этапа «Согласование договора», ради которого эта оговорка и заводилась.
 *
 * Для встреч оговорка осталась и после возврата метрики на этап AMO
 * (10.09.2026), только причина сменилась: раньше проблемой была привязка
 * записей разговоров, теперь — дисциплина в самом AMO до мая 2026.
 */
export function stageAvailability(to: Date): { meetingsReliable: boolean } {
  return {
    meetingsReliable: to.getTime() >= MEETINGS_RELIABLE_SINCE.getTime(),
  };
}

export function isLeadInWindow(lead: FirstSalesLeadRow, from: Date, to: Date): boolean {
  return inWindow(lead.created_at, from, to);
}

/**
 * Квал периода — лид, заведённый в периоде И квалифицированный в нём же.
 *
 * До 11.09.2026 хватало первого условия: лид августа, дошедший до квала в
 * сентябре, засчитывался августу, и цифра прошлого месяца росла задним числом
 * (за август 80 квалов, из них 5 квалифицированы уже в сентябре). Продажи
 * смотрят на период как на срез: сделки и их этапы на его конец. Этап после
 * конца периода к нему не относится.
 *
 * Закрытая в минус сделка квалом не считается вовсе, когда бы её ни закрыли:
 * так квалы считает отчёт продаж, и дашборд с ним сверяют. Цена решения —
 * квалы прошлого периода уменьшаются, когда его сделку закрывают позже.
 */
const LOST_STATUS_ID = 143;

export function isQualifiedInWindow(lead: FirstSalesLeadRow, from: Date, to: Date): boolean {
  return (
    isLeadInWindow(lead, from, to)
    && inWindow(lead.first_qualified_at, from, to)
    && lead.history_complete
    && lead.status_id !== LOST_STATUS_ID
  );
}

/**
 * Продажа — сделка, закрытая в плюс внутри окна.
 *
 * Именно это продажи называют продажей, и именно это сходится с деньгами:
 * за август 2026 закрыто 13 сделок и получено 13 первых платежей, тогда как
 * этап «Согласование договора» дал 9. `won_at` приходит из `closed_at`,
 * который синкается с 2024 года, поэтому оговорка о достоверности здесь не
 * нужна — в отличие от этапа договора.
 */
export function isSaleInWindow(lead: FirstSalesLeadRow, from: Date, to: Date): boolean {
  return inWindow(lead.won_at, from, to);
}

/**
 * Этап «Согласование договора» — промежуточная отметка в карточке сделки.
 *
 * Метрикой перестал быть 09.09.2026 (см. заголовок файла), но из drill-down
 * не убран: пометка «договор» в строке сделки показывает, что этап проходили,
 * и это полезный след работы менеджера. Ограничение CONTRACT_RULE_SINCE
 * остаётся — до него этап ставили и на «просто отправил файл».
 */
export function isContractInWindow(lead: FirstSalesLeadRow, from: Date, to: Date): boolean {
  return (
    lead.history_complete
    && inWindow(lead.first_contract_at, from, to)
    && new Date(lead.first_contract_at as string).getTime() >= CONTRACT_RULE_SINCE.getTime()
  );
}

/**
 * Встреча сделки внутри окна — по этапу AMO «Встреча проведена».
 *
 * Источник метрики вернулся с записей разговоров на этап 10.09.2026 (решение
 * продаж). Записи остаются привязанными к сделкам (`meeting_deal_links`), но
 * нужны они теперь ИИ-аналитике продаж — связать разговор с сделкой, — а не
 * дашборду.
 *
 * Считается по `first_meeting_at`, то есть один раз на сделку: два разговора
 * с одним клиентом в разные дни дают одну встречу, а не две.
 */
export function isMeetingInWindow(lead: FirstSalesLeadRow, from: Date, to: Date): boolean {
  return inWindow(lead.first_meeting_at, from, to);
}

/**
 * Дата встречи сделки внутри периода: по этапу AMO, а если этапом встреча не
 * отмечена — по закрытой задаче «Встреча», при которой карточка в конце периода
 * так и осталась на «Назначена встреча» (fetchTaskMeetings в meetings.ts).
 * null — встречи в периоде нет.
 *
 * Этап важнее задачи: сделка, дошедшая до «Встреча проведена», считается по
 * дате этапа, и одна встреча не может посчитаться дважды.
 */
function meetingDateInWindow(
  lead: FirstSalesLeadRow,
  from: Date,
  to: Date,
  taskMeetings: Map<number, string>,
): string | null {
  if (isMeetingInWindow(lead, from, to)) return lead.first_meeting_at;
  return taskMeetings.get(lead.amo_id) ?? null;
}

/** Сделка → 1, если её встреча (по этапу или по закрытой задаче) попала в период. */
export function meetingsByDeal(
  leads: FirstSalesLeadRow[],
  from: Date,
  to: Date,
  taskMeetings: Map<number, string> = new Map(),
): Map<number, number> {
  const byDeal = new Map<number, number>();
  for (const lead of leads) {
    if (meetingDateInWindow(lead, from, to, taskMeetings)) byDeal.set(lead.amo_id, 1);
  }
  return byDeal;
}

/**
 * Сделка → дата её встречи внутри периода.
 *
 * Нужна списку рядом с воронкой: строка обязана показывать дату события,
 * которым сделка попала в период, а не дату своего создания. Сделка 2024 года
 * со встречей в августе 2026 иначе выглядит как «список не слушается фильтра».
 */
export function meetingAtByDeal(
  leads: FirstSalesLeadRow[],
  from: Date,
  to: Date,
  taskMeetings: Map<number, string> = new Map(),
): Map<number, string> {
  const byDeal = new Map<number, string>();
  for (const lead of leads) {
    const meetingAt = meetingDateInWindow(lead, from, to, taskMeetings);
    if (meetingAt) byDeal.set(lead.amo_id, meetingAt);
  }
  return byDeal;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function computeFirstSalesSeries(
  leads: FirstSalesLeadRow[],
  from: Date,
  to: Date,
  groupBy: GroupBy,
  sourceFilter: string[] | null,
  // Последним и необязательным — сознательно: деньги считаются отдельным
  // проходом поверх уже посчитанной воронки и ничего в ней не меняют. Так все
  // существующие вызовы (и тесты воронки) остаются валидными, а расчёт без
  // денег — законным состоянием, а не забытым аргументом.
  payments: FirstSalesPaymentRow[] = [],
  // Встречи по закрытой задаче «Встреча» (fetchTaskMeetings): сделка → срок
  // задачи. Необязательно по той же причине, что и деньги.
  taskMeetings: Map<number, string> = new Map(),
): FirstSalesSeries {
  const allowed = sourceFilter && sourceFilter.length > 0 ? new Set(sourceFilter) : null;

  const keys = buildBuckets(from, to, groupBy);
  const series = new Map<string, SeriesBucket>(
    keys.map((key) => [key, { key, leads: 0, qualified: 0, meetings: 0, sales: 0 }]),
  );
  const bySource = new Map<string, SourceBreakdown>();
  const byManager = new Map<string, ManagerBreakdown>();

  const managerRow = (name: string | null): ManagerBreakdown => {
    const key = managerKey(name);
    let row = byManager.get(key);
    if (!row) {
      row = { manager: key, leads: 0, qualified: 0, meetings: 0, sales: 0, money: 0 };
      byManager.set(key, row);
    }
    return row;
  };

  /** Строка разбивки по источнику. Заводится в трёх местах (лиды, встречи,
   *  деньги) — общий конструктор, чтобы новое поле не появилось в двух из
   *  трёх. Название строке проставляется здесь только как временное значение
   *  для новых строк — окончательное имя на выходе берётся из `labelPick`
   *  (см. `return`), чтобы не зависеть от того, какая сделка встретилась
   *  первой. */
  const sourceRow = (key: string, label: string): SourceBreakdown => {
    let row = bySource.get(key);
    if (!row) {
      row = { key, source: label, leads: 0, qualified: 0, meetings: 0, sales: 0, money: 0 };
      bySource.set(key, row);
    }
    return row;
  };

  const totals: FirstSalesTotals = {
    leads: 0, qualified: 0, meetings: 0, sales: 0,
    leadMagnets: 0, noSourceLeads: 0, wonCount: 0,
    cycleAvgDays: null, cycleMedianDays: null,
    ...stageAvailability(to),
    meetingsSince: MEETINGS_RELIABLE_SINCE.toISOString(),
    money: emptyMoneyTotals(),
  };
  const cycles: number[] = [];

  // Источник СДЕЛКИ, не записи разговора — иначе фильтр не работал бы для
  // встреч. Заполняется в основном цикле ДО фильтра, чтобы в карте остались
  // все сделки независимо от текущего выбора.
  const dealSourceMap = new Map<number, ResolvedSource>();
  /** Сделка → ответственный: встречи считаются отдельным проходом, где самой
   *  сделки под рукой уже нет. */
  const dealManagerMap = new Map<number, string | null>();

  // Название источника берём у сделки с наибольшим created_at (при равенстве —
  // с наибольшим amo_id, чтобы результат не зависел от порядка строк выборки).
  // Если продажи переименуют пункт в AMO, у старых, давно не синхронизированных
  // сделок в raw останется прежнее написание — показываем свежее.
  const labelPick = new Map<string, { label: string; createdAt: number; amoId: number }>();

  // Список для выпадашки фильтра. Считается ДО отсева по источнику: иначе,
  // выбрав один источник, пользователь получил бы список из одного пункта и
  // добавить второй стало бы нечем — фильтр съел бы сам себя.
  const availableLeads = new Map<string, number>();

  // Тип поля сужен до счётчиков: `keyof SeriesBucket` включал бы `key: string`,
  // и `bucket[field] += 1` не прошёл бы проверку типов.
  type CounterField = 'leads' | 'qualified' | 'meetings' | 'sales';
  const bump = (key: string | null, field: CounterField) => {
    if (!key) return;
    const bucket = series.get(key);
    if (bucket) bucket[field] += 1;
  };

  for (const lead of leads) {
    const resolved = resolveSource(lead.raw);
    dealSourceMap.set(lead.amo_id, resolved);
    dealManagerMap.set(lead.amo_id, lead.responsible_name);

    const createdAt = lead.created_at ? new Date(lead.created_at).getTime() : Number.NEGATIVE_INFINITY;
    const bestLabel = labelPick.get(resolved.key);
    if (
      !bestLabel
      || createdAt > bestLabel.createdAt
      || (createdAt === bestLabel.createdAt && lead.amo_id > bestLabel.amoId)
    ) {
      labelPick.set(resolved.key, { label: resolved.label, createdAt, amoId: lead.amo_id });
    }
    if (!availableLeads.has(resolved.key)) availableLeads.set(resolved.key, 0);
    if (inWindow(lead.created_at, from, to)) {
      availableLeads.set(resolved.key, (availableLeads.get(resolved.key) as number) + 1);
    }

    if (allowed && !allowed.has(resolved.key)) continue;

    const manager = managerRow(lead.responsible_name);
    const breakdown = sourceRow(resolved.key, resolved.label);

    // Лиды — по дате создания. Без исключений по статусу.
    if (isLeadInWindow(lead, from, to)) {
      totals.leads += 1;
      breakdown.leads += 1;
      manager.leads += 1;
      bump(bucketKey(new Date(lead.created_at as string), groupBy), 'leads');
      if (isLeadMagnet(lead.name)) totals.leadMagnets += 1;
      if (resolved.key === NO_SOURCE_KEY) totals.noSourceLeads += 1;

      // «Дошёл до квала» кладётся в корзину по дате СОЗДАНИЯ, а не по дате
      // достижения этапа; first_qualified_at проверяется только на то, что
      // квал случился внутри того же периода (с 11.09.2026, см.
      // isQualifiedInWindow). Это когортная семантика — «из пришедших в этот день/
      // неделю/месяц скольких сумели квалифицировать», та же логика, что и у
      // «леды». Отличается от meetings/sales ниже, которые по спеке
      // кладутся по дате самого этапа («сколько встреч случилось в этот
      // день», независимо от того, когда лид пришёл). Оба взгляда осмыслены,
      // но соседствуют в одном SeriesBucket — при чтении графика это стоит
      // держать в голове: столбец qualified отвечает на другой вопрос, чем
      // столбцы meetings/sales в той же строке.
      if (isQualifiedInWindow(lead, from, to)) {
        totals.qualified += 1;
        breakdown.qualified += 1;
        manager.qualified += 1;
        bump(bucketKey(new Date(lead.created_at as string), groupBy), 'qualified');
      }
    }

    // Договор — по дате достижения этапа. Сделка с неполной историей
    // исключается: у неё переход мог случиться до горизонта событий, и мы его
    // не видели. Считать её нулём — врать.
    //
    // Встречи здесь больше не считаются: этап AMO «Встреча проведена» был
    // источником этой метрики раньше и давал 200+ встреч в месяц против 64 у
    // руководителя продаж — этап засорён, сделку двигают по нему и без
    // реальной встречи. Новый расчёт — ниже, отдельным проходом по
    // `meetingLinks` (привязки записей разговоров к сделкам), см. блок после
    // основного цикла. `first_meeting_at` на объекте лида НЕ удалён — он
    // остаётся полезным следом того, что происходило в CRM, и показывается в
    // drill-down (SourceTable) под меткой «Этап AMO», но в счётчик встреч не
    // идёт, чтобы под одним названием не жили две разные цифры.
    // Продажи — по дате закрытия сделки в плюс. Этап «Согласование договора»
    // метрикой быть перестал: за август 2026 он дал 9 при 13 оплаченных
    // сделках, потому что пять продаж его вообще не проходили. Этап остался
    // отметкой в карточке (см. isContractInWindow), но не цифрой на экране.
    if (isSaleInWindow(lead, from, to)) {
      totals.sales += 1;
      breakdown.sales += 1;
      manager.sales += 1;
      bump(bucketKey(new Date(lead.won_at as string), groupBy), 'sales');
      // Покрытие ИНН считается ровно по тем продажам, что попали в метрику:
      // знаменатель «сколько денег мы вообще могли бы увидеть» должен быть
      // тем же числом, что показано на карточке «Продажи», иначе доля будет
      // считаться от одного, а читаться от другого.
      if (dealInn(lead.raw)) totals.money.contractsWithInn += 1;
    }

    // Цикл — от создания до оплаты, по оплаченным в окне. От глубины истории
    // событий не зависит: won_at приходит из closed_at.
    if (inWindow(lead.won_at, from, to) && lead.created_at) {
      const days =
        (new Date(lead.won_at as string).getTime() - new Date(lead.created_at).getTime()) / DAY_MS;
      if (Number.isFinite(days) && days >= 0) {
        totals.wonCount += 1;
        cycles.push(days);
      }
    }
  }

  if (cycles.length > 0) {
    totals.cycleAvgDays = cycles.reduce((a, b) => a + b, 0) / cycles.length;
    totals.cycleMedianDays = median(cycles);
  }

  // ─── Встречи — по этапу AMO «Встреча проведена» ─────────────────────────
  //
  // Источник вернулся с записей разговоров на этап AMO 10.09.2026 — решение
  // продаж. Причина, по которой этап когда-то забраковали (сделку двигают по
  // нему и без разговора), к августу 2026 ушла: 83 сделки по этапу против 83
  // сделок с записью разговора, у 73 из них есть и то, и другое. Записи
  // продолжают привязываться к сделкам (`meeting_deal_links`), но нужны они
  // теперь ИИ-аналитике продаж, а не этой метрике.
  //
  // Встреча считается один раз на сделку: у `first_meeting_at` дата одна,
  // поэтому два разговора с одним клиентом в разные дни дают одну встречу.
  //
  // С 11.09.2026 правила сверены с отчётом продаж (август: 78 = 78):
  //   - «Перенос» встречей не делает — это в самом view (миграция 20260911_0001);
  //   - встреча, проведённая по закрытой задаче «Встреча», но не отмеченная
  //     этапом (карточка осталась на «Назначена встреча»), засчитывается по
  //     сроку задачи — см. meetingDateInWindow.
  for (const lead of leads) {
    const meetingAt = meetingDateInWindow(lead, from, to, taskMeetings);
    if (!meetingAt) continue;

    const resolved = dealSourceMap.get(lead.amo_id);
    const key = resolved?.key ?? NO_SOURCE_KEY;
    if (allowed && !allowed.has(key)) continue;

    totals.meetings += 1;
    bump(bucketKey(new Date(meetingAt), groupBy), 'meetings');

    sourceRow(key, resolved?.label ?? NO_SOURCE_LABEL).meetings += 1;
    managerRow(dealManagerMap.get(lead.amo_id) ?? null).meetings += 1;
  }

  // ─── Деньги — по банковским приходам, связанным по ИНН ───────────────────
  //
  // Отдельным проходом и последним: деньги ничего не меняют в воронке, они
  // ложатся поверх неё. Правила отбора (первичка vs продление, спорные) живут
  // в `money.ts` — здесь только раскладка по срезам.
  //
  // Спорные и неразобранные НЕ фильтруются по источнику: источник берётся у
  // сделки, а у этих платежей сделка либо неизвестна (несколько кандидатов),
  // либо решение по ней ещё не принято. Показать их «ноль при выбранном
  // источнике» значило бы спрятать признание в незнании, а именно оно тут и
  // ценно.
  for (const p of payments) {
    const amount = paymentAmount(p);
    // Ноль и минус — возвраты и служебные строки: в «пришло денег» им не
    // место, а вычитать их из выручки первички нельзя (возврат может
    // относиться к платежу другого окна).
    if (amount <= 0) continue;
    if (!inWindow(p.occurred_at, from, to)) continue;

    // Контрольная сумма экрана: сюда идёт КАЖДЫЙ приход окна, включая чужие
    // первичке. Читатель обязан видеть, что дашборд и выписка сходятся, —
    // иначе разницу выясняют в переписке (так и было до 09.09.2026).
    totals.money.bankTotal += amount;
    totals.money.bankPayments += 1;

    // Сделки первички у платежа нет вовсе: либо клиент живёт в воронке
    // продлений, либо это не клиентский платёж (эквайринг). Разбирается до
    // `renewal_state` намеренно — состояние «первый приход от ИНН» у чужого
    // платежа ничего не значит.
    if (p.deal_matches === 0) {
      if (p.renewal_deal_matches > 0) {
        totals.money.renewals += amount;
        totals.money.renewalsPayments += 1;
      } else {
        totals.money.unlinked += amount;
        totals.money.unlinkedPayments += 1;
      }
      continue;
    }

    if (p.renewal_state === 'renewal') {
      // Размеченное человеком продление по клиенту, который есть и в
      // первичке: в деньги первички не идёт, но в сходимость с банком — да.
      totals.money.renewals += amount;
      totals.money.renewalsPayments += 1;
      continue;
    }
    if (p.renewal_state === 'pending') {
      totals.money.pending += amount;
      totals.money.pendingPayments += 1;
      continue;
    }
    if (!attributablePayment(p)) {
      totals.money.ambiguous += amount;
      totals.money.ambiguousPayments += 1;
      continue;
    }

    const dealId = p.amo_deal_id as number;
    const resolved = dealSourceMap.get(dealId);
    const key = resolved?.key ?? NO_SOURCE_KEY;
    if (allowed && !allowed.has(key)) continue;

    totals.money.received += amount;
    totals.money.payments += 1;
    sourceRow(key, resolved?.label ?? NO_SOURCE_LABEL).money += amount;
    managerRow(dealManagerMap.get(dealId) ?? null).money += amount;
  }

  return {
    series: keys.map((k) => series.get(k) as SeriesBucket),
    // Пустые строки отбрасываем: выборка тянет сделки с любой активностью в
    // окне, поэтому источник может попасть в разбивку из-за оплаты старой
    // сделки и дать строку из одних нулей. Строка «источник, по которому
    // ничего не произошло» — шум, а не факт.
    //
    // Название проставляется здесь, а не при создании строки: `sourceRow`
    // кладёт имя той сделки, что встретилась первой, а показать нужно самое
    // свежее написание (см. `labelPick`).
    bySource: [...bySource.values()]
      .filter((s) => s.leads + s.qualified + s.meetings + s.sales + s.money > 0)
      .map((s) => ({ ...s, source: labelPick.get(s.key)?.label ?? s.source }))
      .sort((a, b) => b.leads - a.leads),
    // Список для выпадашки фильтра — по всем сделкам выборки, ДО отсева по
    // источнику: иначе, выбрав один источник, пользователь получил бы список
    // из одного пункта и добавить второй стало бы нечем.
    availableSources: [...availableLeads.entries()]
      .map(([key, leads]) => ({ key, label: labelPick.get(key)?.label ?? key, leads }))
      .sort((a, b) => b.leads - a.leads || a.label.localeCompare(b.label, 'ru-RU')),
    // Пустые строки отбрасываем по той же причине, что и у источников: сделка
    // могла попасть в выборку оплатой старой сделки и дать менеджеру строку из
    // одних нулей.
    byManager: [...byManager.values()]
      .filter((m) => m.leads + m.qualified + m.meetings + m.sales + m.money > 0)
      .sort((a, b) => b.leads - a.leads || a.manager.localeCompare(b.manager, 'ru')),
    totals,
  };
}

const STAGE_DATE_COLUMNS =
  'amo_deal_id, created_at, first_qualified_at, first_meeting_at, first_contract_at, won_at, history_complete';

type StageDateRow = Omit<FirstSalesLeadRow, 'amo_id' | 'name' | 'responsible_name' | 'raw' | 'status_id'> & { amo_deal_id: number };

/**
 * Тянет сделки воронки первички вместе с датами этапов из view.
 *
 * `extraDealIds` — сделки, которые обязаны попасть в выборку ДАЖЕ если ни
 * одно из полей окна (`created_at`/`first_meeting_at`/`first_contract_at`/
 * `won_at`) в окно не попадает. Нужны для встреч: сделка могла прийти в
 * марте, а привязанная запись разговора — датироваться июлем; фильтр по
 * стадиям её не увидит, а `computeFirstSalesSeries` без неё не сможет
 * определить канал сделки для встречи (канал резолвится из `raw`, который
 * есть только у сделок, попавших в этот массив) — встреча в лучшем случае
 * ушла бы в «не распределено», в худшем — потерялась бы при фильтре по
 * каналу. Вызывающий код передаёт сюда id сделок из `fetchMeetingLinks` за
 * то же окно.
 */
export async function fetchFirstSalesLeads(
  db: SupabaseClient,
  pipelineId: number,
  from: Date,
  to: Date,
  extraDealIds: number[] = [],
): Promise<FirstSalesLeadRow[]> {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  // Берём сделки с ЛЮБОЙ активностью в окне: созданы, дошли до встречи,
  // до договора или оплачены. Иначе встреча июльской сделки, пришедшей в июне,
  // в июльское окно не попадёт.
  const { data, error } = await db
    .from('amo_lead_stage_dates_v')
    .select(STAGE_DATE_COLUMNS)
    .eq('pipeline_id', pipelineId)
    .or(
      `and(created_at.gte.${fromIso},created_at.lte.${toIso}),` +
        `and(first_meeting_at.gte.${fromIso},first_meeting_at.lte.${toIso}),` +
        `and(first_contract_at.gte.${fromIso},first_contract_at.lte.${toIso}),` +
        `and(won_at.gte.${fromIso},won_at.lte.${toIso})`,
    );
  if (error) throw error;

  const stageRows = (data ?? []) as StageDateRow[];

  // Сделки из extraDealIds, которые окно по стадиям не поймало (см. doc-
  // комментарий выше). Отдельным запросом, без date-фильтра — только
  // воронка и конкретные id.
  const seenIds = new Set(stageRows.map((r) => r.amo_deal_id));
  const missingExtraIds = extraDealIds.filter((id) => !seenIds.has(id));
  const extraChunks = await Promise.all(
    chunkArray(missingExtraIds, IN_CHUNK_SIZE).map(async (chunk) => {
      const { data: extraData, error: extraError } = await db
        .from('amo_lead_stage_dates_v')
        .select(STAGE_DATE_COLUMNS)
        .eq('pipeline_id', pipelineId)
        .in('amo_deal_id', chunk);
      if (extraError) throw extraError;
      return (extraData ?? []) as StageDateRow[];
    }),
  );
  // Дедуп после сбора, а не по ходу цикла: чанки теперь идут параллельно, и
  // «уже видели» нельзя проверять внутри чанка — только когда пришли все.
  // Чанки не пересекаются по id, но `seenIds` сюда приходит уже непустым
  // (сделки из оконной выборки), так что проверка нужна.
  for (const row of extraChunks.flat()) {
    if (seenIds.has(row.amo_deal_id)) continue;
    stageRows.push(row);
    seenIds.add(row.amo_deal_id);
  }

  if (stageRows.length === 0) return [];

  // Список id может уйти за тысячи сделок (год активности воронки). PostgREST
  // отдаёт весь `.in(...)` одной строкой query-параметра — при большом списке
  // это НЕ тихо усекает выборку, а роняет запрос целиком (400/414: URL
  // превышает ~8 КБ). В этом кодовом стиле уже есть готовый паттерн под эту
  // проблему — `cisLeads/batchedQuery.ts` — используем его: бьём id на чанки
  // по IN_CHUNK_SIZE и мержим результаты.
  const ids = stageRows.map((r) => r.amo_deal_id);
  const leadChunks = await Promise.all(
    chunkArray(ids, IN_CHUNK_SIZE).map(async (chunk) => {
      const { data: leadsChunk, error: leadsError } = await db
        .from('amo_leads')
        .select('amo_id, name, company_name, responsible_name, status_id, raw')
        .in('amo_id', chunk);
      if (leadsError) throw leadsError;
      return (leadsChunk ?? []) as Array<{
        amo_id: number; name: string | null; company_name: string | null;
        responsible_name: string | null; status_id: number | null; raw: unknown;
      }>;
    }),
  );
  const leadsById = new Map<
    number,
    { name: string | null; company_name: string | null; responsible_name: string | null; status_id: number | null; raw: unknown }
  >();
  for (const l of leadChunks.flat()) {
    leadsById.set(l.amo_id, {
      name: l.name, company_name: l.company_name, responsible_name: l.responsible_name,
      status_id: l.status_id === null ? null : Number(l.status_id), raw: l.raw,
    });
  }

  return stageRows.map((r) => ({
    amo_id: r.amo_deal_id,
    name: leadsById.get(r.amo_deal_id)?.name ?? null,
    company_name: leadsById.get(r.amo_deal_id)?.company_name ?? null,
    responsible_name: leadsById.get(r.amo_deal_id)?.responsible_name ?? null,
    status_id: leadsById.get(r.amo_deal_id)?.status_id ?? null,
    raw: leadsById.get(r.amo_deal_id)?.raw ?? null,
    created_at: r.created_at,
    first_qualified_at: r.first_qualified_at,
    first_meeting_at: r.first_meeting_at,
    first_contract_at: r.first_contract_at,
    won_at: r.won_at,
    history_complete: r.history_complete,
  }));
}
