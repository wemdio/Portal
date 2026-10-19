/**
 * Правила переходов между этапами воронки «Воронка - новые лиды» (AMO).
 *
 * Этапы — только по id: названия продажи переименовывают (см. память
 * `amo-stages-by-id`). Порядок и id сверены с `amo_statuses` 16.10.2026.
 *
 * Правила (просьба Дмитрия, 16.10.2026):
 *  1. Вперёд — строго на соседний этап основной цепочки.
 *  2. «Новый лид» → только «Взят в работу» или «Закрыто и не реализовано»;
 *     «Взят в работу» → только «Лид квалифицирован» или «Закрыто и не
 *     реализовано» (уточнение Дмитрия, 16.10.2026).
 *  3. «Закрыто и не реализовано» — с любого этапа; из него — только в «Взят в работу».
 *
 * Допущения, которых в просьбе не было (одна строка в таблице ниже, если не так):
 *  - назад — тоже только на соседний этап (просьба продаж, 16.10.2026);
 *    откат запрещённого перехода сам может быть «запрещённым» ходом, поэтому
 *    guard узнаёт свои откаты по таблице amo_funnel_reverts;
 *  - «Не вышел на звонок» и «Перенос» — боковые этапы, в цепочку не входят:
 *    в них можно с «Лид квалифицирован» и дальше, из них — в любой этап
 *    с «Лид квалифицирован»; с первых двух этапов — нельзя;
 *  - «Успешно реализовано» — только из «Оплата получена» (полный цикл).
 */

export const FUNNEL_PIPELINE_ID = 7670334;

export const STAGE = {
  UNSORTED: 63384118,
  NEW: 63385358,
  TAKEN: 63384122,
  QUALIFIED: 87397290,
  MEETING_SCHEDULED: 63384126,
  NO_SHOW: 65917182,
  MEETING_HELD: 65917186,
  PROPOSAL_SENT: 63387174,
  PARKING: 63387178,
  INVOICE_SENT: 63386002,
  CONTRACT: 65954530,
  PAID: 87614510,
  WON: 142,
  LOST: 143,
} as const;

/** Основная цепочка: вперёд можно только на следующий элемент. */
const CHAIN: number[] = [
  STAGE.NEW,
  STAGE.TAKEN,
  STAGE.QUALIFIED,
  STAGE.MEETING_SCHEDULED,
  STAGE.MEETING_HELD,
  STAGE.PROPOSAL_SENT,
  STAGE.PARKING,
  STAGE.INVOICE_SENT,
  STAGE.CONTRACT,
  STAGE.PAID,
];

const SIDE_STAGES = new Set<number>([STAGE.NO_SHOW]);

/** Где в цепочке «стоит» боковой этап, когда из него выходят. */
const SIDE_ANCHOR: Record<number, number> = {
  [STAGE.NO_SHOW]: STAGE.MEETING_SCHEDULED,
};

export const STAGE_NAMES: Record<number, string> = {
  [STAGE.UNSORTED]: 'Неразобранное',
  [STAGE.NEW]: 'Новый лид',
  [STAGE.TAKEN]: 'Взят в работу',
  [STAGE.QUALIFIED]: 'Лид квалифицирован',
  [STAGE.MEETING_SCHEDULED]: 'Встреча назначена',
  [STAGE.NO_SHOW]: 'Не вышел на звонок',
  [STAGE.MEETING_HELD]: 'Встреча проведена',
  [STAGE.PROPOSAL_SENT]: 'КП отправлено',
  [STAGE.PARKING]: 'Перенос',
  [STAGE.INVOICE_SENT]: 'Отправлен счет',
  [STAGE.CONTRACT]: 'Согласование договора',
  [STAGE.PAID]: 'Оплата получена',
  [STAGE.WON]: 'Успешно реализовано',
  [STAGE.LOST]: 'Закрыто и не реализовано',
};

export type TransitionVerdict = { allowed: true } | { allowed: false; reason: string };

const stageName = (id: number) => STAGE_NAMES[id] ?? `этап ${id}`;

export function checkTransition(input: {
  pipelineId: number;
  oldPipelineId: number | null;
  fromStatusId: number;
  toStatusId: number;
}): TransitionVerdict {
  const { pipelineId, oldPipelineId, fromStatusId: from, toStatusId: to } = input;

  // Чужая воронка и переносы между воронками правилами не охвачены.
  if (pipelineId !== FUNNEL_PIPELINE_ID) return { allowed: true };
  if (oldPipelineId !== null && oldPipelineId !== FUNNEL_PIPELINE_ID) return { allowed: true };
  if (from === to) return { allowed: true };

  // Закрытие в минус — с любого этапа.
  if (to === STAGE.LOST) return { allowed: true };
  // Успешно реализовано — только после полного цикла, то есть с «Оплата получена»
  // (просьба Дмитрия, 16.10.2026): иначе сделка засчитается выигранной без оплаты.
  if (to === STAGE.WON) {
    if (from === STAGE.PAID) return { allowed: true };
    return {
      allowed: false,
      reason: `«${stageName(STAGE.WON)}» ставится только после «${stageName(STAGE.PAID)}».`,
    };
  }
  // Выход из «Неразобранного» и переоткрытие «Успешно» не ограничиваем.
  if (from === STAGE.UNSORTED || from === STAGE.WON) return { allowed: true };
  // Из «Закрыто и не реализовано» — только вернуть в работу (Дмитрий, 16.10.2026).
  if (from === STAGE.LOST) {
    if (to === STAGE.TAKEN) return { allowed: true };
    return {
      allowed: false,
      reason: `Из «${stageName(STAGE.LOST)}» сделку можно вернуть только в «${stageName(STAGE.TAKEN)}».`,
    };
  }

  const toKnown = CHAIN.includes(to) || SIDE_STAGES.has(to);
  const fromKnown = CHAIN.includes(from) || SIDE_STAGES.has(from);
  if (!toKnown || !fromKnown) return { allowed: true };

  const early = from === STAGE.NEW || from === STAGE.TAKEN;
  if (early) {
    const next = from === STAGE.NEW ? STAGE.TAKEN : STAGE.QUALIFIED;
    if (to === next) return { allowed: true };
    return {
      allowed: false,
      reason: `Из «${stageName(from)}» сделку можно перенести только в «${stageName(next)}» или «${stageName(STAGE.LOST)}».`,
    };
  }

  // «Не вышел на звонок» — только после «Встреча назначена».
  if (to === STAGE.NO_SHOW) {
    if (from === STAGE.MEETING_SCHEDULED) return { allowed: true };
    return {
      allowed: false,
      reason: `В «${stageName(STAGE.NO_SHOW)}» сделку можно перенести только из «${stageName(STAGE.MEETING_SCHEDULED)}».`,
    };
  }

  const fromIdx = CHAIN.indexOf(SIDE_STAGES.has(from) ? SIDE_ANCHOR[from] : from);
  const toIdx = CHAIN.indexOf(to);


  // Назад — тоже только на один этап (просьба продаж, 16.10.2026): иначе
  // сделку, случайно уехавшую далеко вперёд, можно вернуть на «Лид
  // квалифицирован» и она засчитается там повторно. Из «Не вышел на звонок»
  // можно и на тот же этап, что и из встречи (перенос встречи).
  if (toIdx >= fromIdx - 1 && toIdx <= fromIdx + 1) return { allowed: true };

  const back = fromIdx > 0 ? `«${stageName(CHAIN[fromIdx - 1])}», ` : '';
  return {
    allowed: false,
    reason: `Этапы воронки проходим по порядку: из «${stageName(from)}» можно перейти в ${back}«${stageName(CHAIN[fromIdx + 1])}» или «${stageName(STAGE.LOST)}».`,
  };
}

/** Что именно сообщил вебхук AMO `status_lead` об одной сделке. */
export interface StatusChange {
  leadId: number;
  pipelineId: number;
  oldPipelineId: number | null;
  statusId: number;
  oldStatusId: number;
  /** Когда переход случился; у вебхука не задан — берём «сейчас». */
  occurredAt?: Date;
}

/**
 * Вебхук AMO — form-urlencoded с ключами вида `leads[status][0][status_id]`.
 * Возвращает все пары «сделка — смена этапа» из тела.
 */
export function parseStatusWebhook(body: string): StatusChange[] {
  const params = new URLSearchParams(body);
  const byIndex = new Map<string, Record<string, string>>();
  for (const [key, value] of params) {
    const m = /^leads\[status\]\[(\d+)\]\[(\w+)\]$/.exec(key);
    if (!m) continue;
    const bucket = byIndex.get(m[1]) ?? {};
    bucket[m[2]] = value;
    byIndex.set(m[1], bucket);
  }
  const out: StatusChange[] = [];
  for (const f of byIndex.values()) {
    const leadId = Number(f.id);
    const statusId = Number(f.status_id);
    const oldStatusId = Number(f.old_status_id);
    const pipelineId = Number(f.pipeline_id);
    if (![leadId, statusId, oldStatusId, pipelineId].every(Number.isInteger)) continue;
    const old = f.old_pipeline_id === undefined ? null : Number(f.old_pipeline_id);
    out.push({
      leadId,
      pipelineId,
      oldPipelineId: old !== null && Number.isInteger(old) ? old : null,
      statusId,
      oldStatusId,
    });
  }
  return out;
}
