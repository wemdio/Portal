/** Порядок блоков на шаге «Гипотезы»: широкие отдельным блоком сверху, узкие — по вертикалям, как раньше. */

import {
  VE_BROAD_HYPOTHESES_MAX,
  VE_BROAD_HYPOTHESES_STAGE,
  countActiveBroadHypotheses,
} from '@/lib/verticalEngineV2/broadHypotheses';

export const VE_BROAD_HYPOTHESES_TITLE = 'Широкие — для ежедневного добора';
export const VE_BROAD_HYPOTHESES_NOTE = 'Рынок большой, база пополняется каждый день.';
export const VE_BROAD_HYPOTHESES_EMPTY_NOTE =
  'Их пока нет. Добавим 3–5 секторов с большим рынком — текущие гипотезы, базы и выбор не изменятся.';
export const VE_BROAD_ADD_LABEL = 'Добавить широкие гипотезы';
export const VE_BROAD_RUNNING_LABEL = 'Генерируем широкие гипотезы…';
export const VE_BROAD_FAILED_TEXT = 'Не удалось добавить широкие гипотезы. Попробуйте ещё раз.';

export interface VeHypothesisGroups<V, H> {
  /** Широкие гипотезы; пусто у старых проектов — тогда блока нет. */
  broad: H[];
  /** Вертикали с их узкими гипотезами; вертикаль из одних широких сюда не входит. */
  verticals: Array<{ vertical: V; hypotheses: H[] }>;
}

export function groupVeHypotheses<
  V extends { id: string },
  H extends { vertical_id: string | null; broad?: boolean },
>(verticals: V[], hypotheses: H[]): VeHypothesisGroups<V, H> {
  // Без вертикали гипотезу нельзя подготовить (база привязана к вертикали) — как и раньше, не показываем.
  const known = new Set(verticals.map((vertical) => vertical.id));
  const broad = hypotheses.filter((h) => h.broad === true && h.vertical_id !== null && known.has(h.vertical_id));
  const groups = verticals.flatMap((vertical) => {
    const own = hypotheses.filter((h) => h.vertical_id === vertical.id);
    const narrow = own.filter((h) => h.broad !== true);
    return own.length > 0 && narrow.length === 0 ? [] : [{ vertical, hypotheses: narrow }];
  });
  return { broad, verticals: groups };
}

export interface VeBroadActionState {
  label: string;
  disabled: boolean;
  /** Задача добавления идёт (или запрос на неё ещё в пути). */
  running: boolean;
  /** Ошибка последней задачи простыми словами. */
  error: string | null;
  /** Итог последней задачи без новых гипотез или предел широких. */
  note: string | null;
}

/**
 * Состояние кнопки «Добавить широкие гипотезы» по последней задаче
 * broad_hypotheses (jobs приходят от новых к старым) и числу широких.
 */
export function veBroadHypothesesAction(input: {
  jobs: ReadonlyArray<{ stage: string; status: string; progress?: { done?: number; label?: string } | null }>;
  hypotheses: ReadonlyArray<{ broad?: boolean; status?: string }>;
  requesting?: boolean;
  researchRunning?: boolean;
}): VeBroadActionState {
  const latest = input.jobs.find((job) => job.stage === VE_BROAD_HYPOTHESES_STAGE);
  if (input.requesting || (latest && ['pending', 'running'].includes(latest.status))) {
    return { label: VE_BROAD_RUNNING_LABEL, disabled: true, running: true, error: null, note: null };
  }
  const limitReached = countActiveBroadHypotheses(input.hypotheses) >= VE_BROAD_HYPOTHESES_MAX;
  const outcome = latest?.status === 'done' && latest.progress?.done === 0 ? latest.progress.label?.trim() || null : null;
  return {
    label: VE_BROAD_ADD_LABEL,
    disabled: limitReached || Boolean(input.researchRunning),
    running: false,
    error: latest?.status === 'failed' ? VE_BROAD_FAILED_TEXT : null,
    note: limitReached ? `В проекте уже ${VE_BROAD_HYPOTHESES_MAX} широких гипотез — это предел` : outcome,
  };
}
