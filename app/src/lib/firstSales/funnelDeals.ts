/**
 * Раскладка сделок по ступеням воронки первички — для списка справа от самой
 * воронки (спека: docs/superpowers/specs/2026-08-30-first-sales-funnel-deals-design.md).
 *
 * Воронка вложенная: те же 13 продаж сидят и во встречах, и в квалах, и в
 * лидах. Показывать сделку в каждой ступени, которой она достигла, значило бы
 * вывести одну карточку четыре раза и превратить список в кашу. Поэтому каждая
 * сделка попадает РОВНО В ОДНУ группу — самую глубокую из достигнутых, и
 * список читается как «эти купили, эти застряли на встрече, эти на квале, эти
 * остались лидами».
 *
 * Сумма по группам НЕ равна числу лидов периода, и это не ошибка: «Встречи» и
 * «Продажи» считаются по дате самого события, а «Лиды» и «Квал» — когортно, по
 * дате прихода лида. Сделка из июля со встречей в августе даёт августу встречу,
 * но в число лидов августа не входит. Та же особенность уже объяснена сноской
 * под самой воронкой (FunnelChart.tsx). Поэтому UI обязан показывать в
 * заголовке группы её собственный размер, а число со ступени воронки — рядом и
 * отдельно, а не выдавать одно за другое.
 */

/**
 * Ступени в порядке показа — сверху вниз, как на самой воронке: лиды,
 * квал, встречи, продажи.
 *
 * Список читается глазами вместе с воронкой слева, и порядок обязан совпадать
 * с ней. Обратный («сначала продажи») выглядит логично сам по себе — сверху
 * самое ценное, — но рядом с воронкой заставляет читать два соседних блока в
 * разные стороны.
 */
export const FUNNEL_STAGE_ORDER = ['lead', 'qualified', 'meeting', 'sale'] as const;

export type FunnelStageId = (typeof FUNNEL_STAGE_ORDER)[number];

export const FUNNEL_STAGE_LABEL: Record<FunnelStageId, string> = {
  lead: 'Лиды',
  qualified: 'Квал',
  meeting: 'Встречи',
  sale: 'Продажи',
};

/**
 * Цвет ступени — та же переменная палитры, которой красит ступень сама воронка
 * (`seriesColor(theme, slot)` в FunnelChart.tsx, слоты 0..3 по порядку).
 * Берём именно переменную, а не hex: палитра объявлена в globals.css и разная
 * для светлой и тёмной темы, копия здесь разъехалась бы с графиком.
 */
export const FUNNEL_STAGE_COLOR_VAR: Record<FunnelStageId, string> = {
  lead: 'var(--chart-series-1)',
  qualified: 'var(--chart-series-2)',
  meeting: 'var(--chart-series-3)',
  sale: 'var(--chart-series-4)',
};

/** Что этой сделки попало в период — те же поля, что отдаёт drill-down. */
export type FunnelHits = {
  lead: boolean;
  qualified: boolean;
  meetings: number;
  /** Сделка закрыта в плюс внутри окна. */
  sale: boolean;
};

/**
 * Какие ступени воронки вообще существуют для этого окна.
 *
 * Ступень, признанная недостоверной, из воронки выбрасывается, а не рисуется
 * нулём (см. FunnelChart.tsx). Список обязан вести себя так же: группы у такой
 * ступени быть не должно вовсе. Иначе на воронке ступени нет, а в списке под
 * ней лежат сделки — и читается это как «график что-то скрывает».
 */
export type StageAvailability = {
  meetingsReliable: boolean;
};

/**
 * Самая глубокая ступень, которой сделка достигла в окне.
 *
 * `null` — сделка не дала периоду ни одной ступени воронки. Так бывает: в
 * выборку drill-down она попадает и по оплате тоже, а оплата ступенью воронки
 * не является. Такие сделки в список не идут — на воронке их тоже нет.
 */
export function deepestStage(hits: FunnelHits, available: StageAvailability): FunnelStageId | null {
  if (hits.sale) return 'sale';
  if (hits.meetings > 0 && available.meetingsReliable) return 'meeting';
  if (hits.qualified) return 'qualified';
  if (hits.lead) return 'lead';
  return null;
}

/** Даты сделки, из которых выбирается показываемая в строке. */
export type FunnelStageDates = {
  created_at: string | null;
  meeting_at: string | null;
  won_at: string | null;
};

/**
 * Дата, которой сделка попала в период, — та, что стоит в строке списка.
 *
 * Для продажи это дата закрытия сделки, для встречи — дата встречи; квал и
 * лид считаются когортно по дате прихода лида, поэтому у них это `created_at`.
 * Показывать везде `created_at` нельзя: сделка 2024 года со встречей в августе
 * 2026 выглядит как сделка вне периода, и список читается как сломанный.
 */
export function stageDate(stage: FunnelStageId, dates: FunnelStageDates): string | null {
  if (stage === 'sale') return dates.won_at ?? dates.created_at;
  if (stage === 'meeting') return dates.meeting_at ?? dates.created_at;
  return dates.created_at;
}

export type FunnelStageGroup<T> = {
  stage: FunnelStageId;
  label: string;
  deals: T[];
};

/**
 * Разносит сделки по группам в порядке FUNNEL_STAGE_ORDER.
 *
 * Пустые группы не возвращаются: заголовок «Продажи — 0» на экране, где
 * продаж нет, занимает место и ничего не сообщает. Порядок сделок внутри
 * группы сохраняется тот, в котором они пришли, — сортировать здесь нечем и
 * незачем, вызывающий уже отсортировал их по дате создания.
 */
export function groupByDeepestStage<T>(
  deals: T[],
  hitsOf: (deal: T) => FunnelHits,
  available: StageAvailability,
): FunnelStageGroup<T>[] {
  const byStage = new Map<FunnelStageId, T[]>();

  for (const deal of deals) {
    const stage = deepestStage(hitsOf(deal), available);
    if (stage === null) continue;
    const list = byStage.get(stage);
    if (list) list.push(deal);
    else byStage.set(stage, [deal]);
  }

  return FUNNEL_STAGE_ORDER
    .filter((stage) => (byStage.get(stage)?.length ?? 0) > 0)
    .map((stage) => ({
      stage,
      label: FUNNEL_STAGE_LABEL[stage],
      deals: byStage.get(stage) as T[],
    }));
}
