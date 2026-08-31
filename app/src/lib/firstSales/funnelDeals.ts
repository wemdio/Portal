/**
 * Раскладка сделок по ступеням воронки первички — для списка справа от самой
 * воронки (спека: docs/superpowers/specs/2026-08-30-first-sales-funnel-deals-design.md).
 *
 * Воронка вложенная: те же 9 договоров сидят и в 35 встречах, и в 67 квалах, и
 * в 290 лидах. Показывать сделку в каждой ступени, которой она достигла,
 * значило бы вывести одну карточку четыре раза и превратить список в кашу.
 * Поэтому каждая сделка попадает РОВНО В ОДНУ группу — самую глубокую из
 * достигнутых, и список читается как «эти дошли до договора, эти застряли на
 * встрече, эти на квале, эти остались лидами».
 *
 * Сумма по группам НЕ равна числу лидов периода, и это не ошибка: «Встречи» и
 * «Договоры» считаются по дате самого события, а «Лиды» и «Квал» — когортно, по
 * дате прихода лида. Сделка из июля со встречей в августе даёт августу встречу,
 * но в число лидов августа не входит. Та же особенность уже объяснена сноской
 * под самой воронкой (FunnelChart.tsx). Поэтому UI обязан показывать в
 * заголовке группы её собственный размер, а число со ступени воронки — рядом и
 * отдельно, а не выдавать одно за другое.
 */

/**
 * Ступени в порядке показа — сверху вниз, как на самой воронке: лиды,
 * квал, встречи, договоры.
 *
 * Список читается глазами вместе с воронкой слева, и порядок обязан совпадать
 * с ней. Обратный («сначала договоры») выглядит логично сам по себе — сверху
 * самое ценное, — но рядом с воронкой заставляет читать два соседних блока в
 * разные стороны.
 */
export const FUNNEL_STAGE_ORDER = ['lead', 'qualified', 'meeting', 'contract'] as const;

export type FunnelStageId = (typeof FUNNEL_STAGE_ORDER)[number];

export const FUNNEL_STAGE_LABEL: Record<FunnelStageId, string> = {
  lead: 'Лиды',
  qualified: 'Квал',
  meeting: 'Встречи',
  contract: 'Договоры',
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
  contract: 'var(--chart-series-4)',
};

/** Что этой сделки попало в период — те же поля, что отдаёт drill-down. */
export type FunnelHits = {
  lead: boolean;
  qualified: boolean;
  meetings: number;
  contract: boolean;
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
  contractsReliable: boolean;
};

/**
 * Самая глубокая ступень, которой сделка достигла в окне.
 *
 * `null` — сделка не дала периоду ни одной ступени воронки. Так бывает: в
 * выборку drill-down она попадает и по оплате тоже, а оплата ступенью воронки
 * не является. Такие сделки в список не идут — на воронке их тоже нет.
 */
export function deepestStage(hits: FunnelHits, available: StageAvailability): FunnelStageId | null {
  if (hits.contract && available.contractsReliable) return 'contract';
  if (hits.meetings > 0 && available.meetingsReliable) return 'meeting';
  if (hits.qualified) return 'qualified';
  if (hits.lead) return 'lead';
  return null;
}

export type FunnelStageGroup<T> = {
  stage: FunnelStageId;
  label: string;
  deals: T[];
};

/**
 * Разносит сделки по группам в порядке FUNNEL_STAGE_ORDER.
 *
 * Пустые группы не возвращаются: заголовок «Договоры — 0» на экране, где
 * договоров нет, занимает место и ничего не сообщает. Порядок сделок внутри
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
