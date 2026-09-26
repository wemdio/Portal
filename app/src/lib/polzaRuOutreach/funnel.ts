/**
 * Воронка «Нашего автоаутрича» по строкам журнала — одно правило для экрана
 * (results/route.ts) и для раннера, когда тот пересчитывает счётчики по
 * журналу (перезапуск после исчерпанного лимита на ИИ).
 *
 * «Дошла до этапа» = этап строки не раньше данного. Отсеянная на этапе X
 * строка дошла до X-1; идущая (processing) — до X; готовая — до конца.
 * Очень спорная задержана на своём этапе, как отсеянная: почта не проверена —
 * на «Почте», два признака сомнения — на «Оценке». Строка, которую не пустил
 * лимит готовых, стоит на этапе, до которого не дошла: без писем — на
 * sequence_assembled (оценку прошла), после проверки писем — на ready.
 */

import { STAGES, type Stage } from './types';

export interface FunnelRow {
  row_status: string;
  pipeline_stage: string | null;
}

export function funnelFromRows(rows: Iterable<FunnelRow>): Record<Stage, number> {
  const funnel = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  for (const row of rows) {
    const idx = STAGES.indexOf((row.pipeline_stage ?? 'candidates_loaded') as Stage);
    const reached = row.row_status === 'ready' ? STAGES.length - 1 : row.row_status === 'processing' ? idx : idx - 1;
    for (let i = 0; i <= Math.max(0, reached); i += 1) funnel[STAGES[i]] += 1;
  }
  return funnel;
}
