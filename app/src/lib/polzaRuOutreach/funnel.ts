/**
 * Воронка «Нашего автоаутрича» по строкам журнала — одно правило для экрана
 * (results/route.ts) и для раннера, когда тот пересчитывает счётчики по
 * журналу (перезапуск после исчерпанного лимита на ИИ), и для «Переписать
 * цепочку», которая переводит строки из спорных в готовые.
 *
 * «Дошла до этапа» = этап строки не раньше данного. Отсеянная на этапе X
 * строка дошла до X-1; идущая (processing) — до X; готовая — до конца.
 * Очень спорная задержана на своём этапе, как отсеянная: почта не проверена —
 * на «Почте», два признака сомнения — на «Оценке», шаблон оффера не прошёл
 * проверку — на «Цепочке», письма не прошли автопроверку — на «QA». Строка,
 * которую не пустил лимит готовых, стоит на этапе, до которого не дошла: без
 * писем — на sequence_assembled (оценку прошла), после проверки писем — на
 * ready.
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

export interface JournalCountRow extends FunnelRow {
  reason_code: string | null;
  chain_type: string | null;
}

export interface JournalCounts {
  funnel: Record<Stage, number>;
  reasons: Record<string, number>;
  chains: Record<string, number>;
  ready: number;
  doubtful: number;
}

/**
 * Счётчики progress_detail по журналу — те же, что раннер ведёт на ходу:
 * воронка, причины отсева, цепочки, готовые и очень спорные.
 */
export function journalCounts(rows: readonly JournalCountRow[]): JournalCounts {
  const reasons: Record<string, number> = {};
  const chains: Record<string, number> = {};
  let ready = 0;
  let doubtful = 0;
  for (const r of rows) {
    if (r.reason_code) reasons[r.reason_code] = (reasons[r.reason_code] ?? 0) + 1;
    if (r.chain_type) chains[r.chain_type] = (chains[r.chain_type] ?? 0) + 1;
    if (r.row_status === 'ready') ready += 1;
    if (r.row_status === 'doubtful') doubtful += 1;
  }
  return { funnel: funnelFromRows(rows), reasons, chains, ready, doubtful };
}
