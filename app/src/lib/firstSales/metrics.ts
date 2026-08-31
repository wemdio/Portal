/**
 * Метрики дашборда первички.
 *
 * Отличия от `salesReport/metrics.ts` — сознательные, зафиксированы в спеке:
 *   1. Лиды считаются ВСЕ, включая закрытые в минус и лид-магниты. Отчёт продаж
 *      их выбрасывает; для дашборда это означало бы, что число лидов за май
 *      уменьшается задним числом каждый раз, когда майскую сделку закрывают.
 *      Прошлое должно быть неподвижным.
 *   2. Договоры считаются по ДАТЕ достижения этапа из истории переходов, а
 *      не когортно «из пришедших в окне дошли до». Встречи — по ДАТЕ записи
 *      разговора (`meeting_deal_links` → `tg_video_transcripts`), а не по
 *      этапу AMO вовсе: этап «Встреча проведена» засорён, см. `meetings.ts`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkArray, IN_CHUNK_SIZE } from '@/lib/cisLeads/batchedQuery';
import { bucketKey, buildBuckets, type GroupBy } from '@/lib/firstSales/buckets';
import { MEETINGS_RELIABLE_SINCE, type MeetingLinkRow } from '@/lib/firstSales/meetings';
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
  raw: unknown;
};

export type SeriesBucket = {
  key: string;
  leads: number;
  qualified: number;
  meetings: number;
  contracts: number;
};

/**
 * Разбивка по ответственному менеджеру.
 *
 * Считается ровно теми же правилами, что и разбивка по источникам: лиды по
 * дате создания, договоры по дате этапа, встречи по записям разговоров. Иначе
 * два среза одного дашборда давали бы разные суммы, и объяснить это было бы
 * нечем.
 */
export type ManagerBreakdown = {
  manager: string;
  leads: number;
  qualified: number;
  meetings: number;
  contracts: number;
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
  contracts: number;
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
  contracts: number;
  leadMagnets: number;
  noSourceLeads: number;
  wonCount: number;
  cycleAvgDays: number | null;
  cycleMedianDays: number | null;
  /**
   * false — окно целиком раньше даты, с которой этап «Согласование договора»
   * начал означать договор. Тогда `contracts` заведомо равен нулю не потому,
   * что договоров не было, а потому что мы отказались считать грязные данные.
   * UI обязан показать прочерк, а не ноль.
   */
  contractsReliable: boolean;
  /** Дата вступления правила в силу — чтобы UI мог назвать её пользователю. */
  contractsSince: string;
  /**
   * false — окно целиком раньше даты, с которой подписи к записям в чате
   * встреч стали регулярными (`MEETINGS_RELIABLE_SINCE`). Тогда `meetings`
   * заведомо занижен не потому, что встреч не было, а потому что автоматчер
   * не может привязать запись без подписи. UI обязан показать прочерк.
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
 * равна нулю: до этой даты этап ставили не по тому поводу (договоры) либо
 * записи разговоров не подписывали (встречи). Одна функция на всех, потому
 * что правило читают в трёх местах — сводка, воронка и список сделок рядом с
 * ней, — и разъехавшись, они покажут разное на одном экране.
 */
export function stageAvailability(to: Date): { meetingsReliable: boolean; contractsReliable: boolean } {
  return {
    meetingsReliable: to.getTime() >= MEETINGS_RELIABLE_SINCE.getTime(),
    contractsReliable: to.getTime() >= CONTRACT_RULE_SINCE.getTime(),
  };
}

export function isLeadInWindow(lead: FirstSalesLeadRow, from: Date, to: Date): boolean {
  return inWindow(lead.created_at, from, to);
}

/** Квал считается когортно — по дате СОЗДАНИЯ лида, см. основной цикл. */
export function isQualifiedInWindow(lead: FirstSalesLeadRow, from: Date, to: Date): boolean {
  return isLeadInWindow(lead, from, to) && !!lead.first_qualified_at && lead.history_complete;
}

/** Договор — по дате этапа и только с CONTRACT_RULE_SINCE. */
export function isContractInWindow(lead: FirstSalesLeadRow, from: Date, to: Date): boolean {
  return (
    lead.history_complete
    && inWindow(lead.first_contract_at, from, to)
    && new Date(lead.first_contract_at as string).getTime() >= CONTRACT_RULE_SINCE.getTime()
  );
}

/**
 * Привязки записей разговоров, которые реально идут в метрику «Встречи»:
 * внутри окна, не раньше MEETINGS_RELIABLE_SINCE и по одной на пару
 * (сделка, день по МСК) — одна встреча часто разрезана на несколько файлов.
 *
 * Вынесено из основного цикла, чтобы список сделок под строкой считал встречи
 * теми же правилами, что и сама строка, а не «примерно так же».
 */
export function countedMeetingLinks(
  links: MeetingLinkRow[],
  from: Date,
  to: Date,
): MeetingLinkRow[] {
  const seen = new Set<string>();
  const out: MeetingLinkRow[] = [];
  for (const link of links) {
    const meetingDate = new Date(link.meeting_at);
    if (!Number.isFinite(meetingDate.getTime())) continue;
    if (!inWindow(link.meeting_at, from, to)) continue;
    if (meetingDate.getTime() < MEETINGS_RELIABLE_SINCE.getTime()) continue;
    const dayKey = `${link.amo_deal_id}|${bucketKey(meetingDate, 'day')}`;
    if (seen.has(dayKey)) continue;
    seen.add(dayKey);
    out.push(link);
  }
  return out;
}

/** Сделка → сколько её встреч попало в период. */
export function meetingsByDeal(
  links: MeetingLinkRow[],
  from: Date,
  to: Date,
): Map<number, number> {
  const byDeal = new Map<number, number>();
  for (const link of countedMeetingLinks(links, from, to)) {
    byDeal.set(link.amo_deal_id, (byDeal.get(link.amo_deal_id) ?? 0) + 1);
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
  meetingLinks: MeetingLinkRow[],
  from: Date,
  to: Date,
  groupBy: GroupBy,
  sourceFilter: string[] | null,
  // Последним и необязательным — сознательно: деньги считаются отдельным
  // проходом поверх уже посчитанной воронки и ничего в ней не меняют. Так все
  // существующие вызовы (и тесты воронки) остаются валидными, а расчёт без
  // денег — законным состоянием, а не забытым аргументом.
  payments: FirstSalesPaymentRow[] = [],
): FirstSalesSeries {
  const allowed = sourceFilter && sourceFilter.length > 0 ? new Set(sourceFilter) : null;

  const keys = buildBuckets(from, to, groupBy);
  const series = new Map<string, SeriesBucket>(
    keys.map((key) => [key, { key, leads: 0, qualified: 0, meetings: 0, contracts: 0 }]),
  );
  const bySource = new Map<string, SourceBreakdown>();
  const byManager = new Map<string, ManagerBreakdown>();

  const managerRow = (name: string | null): ManagerBreakdown => {
    const key = managerKey(name);
    let row = byManager.get(key);
    if (!row) {
      row = { manager: key, leads: 0, qualified: 0, meetings: 0, contracts: 0, money: 0 };
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
      row = { key, source: label, leads: 0, qualified: 0, meetings: 0, contracts: 0, money: 0 };
      bySource.set(key, row);
    }
    return row;
  };

  const totals: FirstSalesTotals = {
    leads: 0, qualified: 0, meetings: 0, contracts: 0,
    leadMagnets: 0, noSourceLeads: 0, wonCount: 0,
    cycleAvgDays: null, cycleMedianDays: null,
    ...stageAvailability(to),
    contractsSince: CONTRACT_RULE_SINCE.toISOString(),
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
  type CounterField = 'leads' | 'qualified' | 'meetings' | 'contracts';
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
      // достижения этапа (first_qualified_at используется только как флаг
      // «дошёл ли»). Это когортная семантика — «из пришедших в этот день/
      // неделю/месяц скольких сумели квалифицировать», та же логика, что и у
      // «леды». Отличается от meetings/contracts ниже, которые по спеке
      // кладутся по дате самого этапа («сколько встреч случилось в этот
      // день», независимо от того, когда лид пришёл). Оба взгляда осмыслены,
      // но соседствуют в одном SeriesBucket — при чтении графика это стоит
      // держать в голове: столбец qualified отвечает на другой вопрос, чем
      // столбцы meetings/contracts в той же строке.
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
    // Договоры — только с даты, когда этап начал означать договор.
    // До неё этап ставили и на «просто отправил файл», см. CONTRACT_RULE_SINCE.
    if (isContractInWindow(lead, from, to)) {
      totals.contracts += 1;
      breakdown.contracts += 1;
      manager.contracts += 1;
      bump(bucketKey(new Date(lead.first_contract_at as string), groupBy), 'contracts');
      // Покрытие ИНН считается ровно по тем договорам, что попали в метрику:
      // знаменатель «сколько денег мы вообще могли бы увидеть» должен быть
      // тем же числом, что показано на карточке «Договоры», иначе доля будет
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

  // ─── Встречи — по привязкам записей разговоров ──────────────────────────
  //
  // Встреча = уникальная пара (сделка, дата записи по МСК), а не запись.
  // Одна встреча часто разрезана на несколько файлов: в боевых данных
  // `denvic.tech` встречается дважды за один день файлами `1.mp4` и `2.mp4` —
  // это одна встреча, а не две. Дедуп — по дню в МСК (bucketKey с groupBy
  // 'day' независимо от groupBy самого графика): при groupBy='month' два
  // разных июльских дня одной сделки — всё ещё две встречи, просто обе
  // попадают в одну месячную корзину графика.
  for (const link of countedMeetingLinks(meetingLinks, from, to)) {
    const meetingDate = new Date(link.meeting_at);
    // (Окно, порог MEETINGS_RELIABLE_SINCE и дедуп «одна сделка — один день»
    // применены в countedMeetingLinks: те же правила нужны и списку сделок
    // под строкой разбивки, а два экземпляра одного правила рано или поздно
    // разъезжаются.)
    //
    // Подписи к записям стали регулярными только с MEETINGS_RELIABLE_SINCE —
    // раньше запись без подписи автоматчер привязать не мог, и привязок за
    // март/апрель кратно меньше июньских/июльских. Считать эти месяцы нулём
    // было бы неверно (см. totals.meetingsReliable), но досчитать их тоже
    // нечем — единственное честное действие для отдельных ранних записей,
    // которые всё же как-то привязались, — не звать их системным сигналом.
    // Не отбрасывать раннюю запись означало бы дать частичную, непроверяемую
    // цифру за месяц, который дальше в UI помечен прочерком.
    // Сделка, на которую сослалась привязка, но которой нет в `leads`, —
    // защитный случай (см. `fetchFirstSalesLeads`, параметр `extraDealIds`:
    // в проде такая сделка должна была подтянуться именно через него). Если
    // всё же не подтянулась — не роняем расчёт, относим встречу к «без
    // источника» вместо того, чтобы потерять её вовсе.
    const resolved = dealSourceMap.get(link.amo_deal_id);
    const key = resolved?.key ?? NO_SOURCE_KEY;
    if (allowed && !allowed.has(key)) continue;

    totals.meetings += 1;
    bump(bucketKey(meetingDate, groupBy), 'meetings');

    sourceRow(key, resolved?.label ?? NO_SOURCE_LABEL).meetings += 1;
    managerRow(dealManagerMap.get(link.amo_deal_id) ?? null).meetings += 1;
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

    if (p.renewal_state === 'renewal') continue;
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
      .filter((s) => s.leads + s.qualified + s.meetings + s.contracts + s.money > 0)
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
      .filter((m) => m.leads + m.qualified + m.meetings + m.contracts + m.money > 0)
      .sort((a, b) => b.leads - a.leads || a.manager.localeCompare(b.manager, 'ru')),
    totals,
  };
}

const STAGE_DATE_COLUMNS =
  'amo_deal_id, created_at, first_qualified_at, first_meeting_at, first_contract_at, won_at, history_complete';

type StageDateRow = Omit<FirstSalesLeadRow, 'amo_id' | 'name' | 'responsible_name' | 'raw'> & { amo_deal_id: number };

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
        .select('amo_id, name, company_name, responsible_name, raw')
        .in('amo_id', chunk);
      if (leadsError) throw leadsError;
      return (leadsChunk ?? []) as Array<{
        amo_id: number; name: string | null; company_name: string | null;
        responsible_name: string | null; raw: unknown;
      }>;
    }),
  );
  const leadsById = new Map<
    number,
    { name: string | null; company_name: string | null; responsible_name: string | null; raw: unknown }
  >();
  for (const l of leadChunks.flat()) {
    leadsById.set(l.amo_id, {
      name: l.name, company_name: l.company_name, responsible_name: l.responsible_name, raw: l.raw,
    });
  }

  return stageRows.map((r) => ({
    amo_id: r.amo_deal_id,
    name: leadsById.get(r.amo_deal_id)?.name ?? null,
    company_name: leadsById.get(r.amo_deal_id)?.company_name ?? null,
    responsible_name: leadsById.get(r.amo_deal_id)?.responsible_name ?? null,
    raw: leadsById.get(r.amo_deal_id)?.raw ?? null,
    created_at: r.created_at,
    first_qualified_at: r.first_qualified_at,
    first_meeting_at: r.first_meeting_at,
    first_contract_at: r.first_contract_at,
    won_at: r.won_at,
    history_complete: r.history_complete,
  }));
}
