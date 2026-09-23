/**
 * Широкие гипотезы уровня сектора — общее для сервера и интерфейса (без
 * серверных импортов). В уже исследованный проект их добавляет отдельная
 * задача воркера (стадия broad_hypotheses): она только дописывает новые
 * гипотезы и вертикали и ничего не удаляет.
 */

import type { VeHypothesisCandidate } from './schemas';

/** Стадия ve_jobs: добавить широкие гипотезы в исследованный проект. */
export const VE_BROAD_HYPOTHESES_STAGE = 'broad_hypotheses';

/** Больше широких в проекте не берём: каждая — отдельная база и ежедневный добор. */
export const VE_BROAD_HYPOTHESES_MAX = 5;

/** Отказ, пока исследование перестраивает вертикали проекта. */
export const VE_BROAD_RESEARCH_BUSY_TEXT = 'Идёт исследование проекта — широкие гипотезы можно добавить после него';

/** Ключ сверки названий: регистр, «ё», кавычки, дефисы и лишние пробелы не различаем. */
export function veBroadTitleKey(title: string): string {
  return title.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Широкие, которые занимают место в пределе; отклонённая место освобождает. */
export function countActiveBroadHypotheses(rows: ReadonlyArray<{ broad?: boolean | null; status?: string | null }>): number {
  return rows.filter((row) => row.broad === true && row.status !== 'rejected').length;
}

export interface VeBroadSelection {
  added: VeHypothesisCandidate[];
  /** Отброшены как повтор гипотезы или вертикали проекта либо другой широкой из ответа. */
  duplicates: string[];
}

/**
 * Новые широкие из ответа модели: без названий, которые уже есть в проекте
 * (гипотезы, вертикали, их синонимы) или повторяются в ответе, и не больше
 * свободных мест. Гипотезы связываются с вертикалями по названию, поэтому
 * совпадение названия — всегда повтор.
 */
export function selectNewBroadCandidates(
  candidates: readonly VeHypothesisCandidate[],
  existingTitles: Iterable<string>,
  slots: number,
): VeBroadSelection {
  const seen = new Set<string>();
  for (const title of existingTitles) {
    const key = veBroadTitleKey(title);
    if (key) seen.add(key);
  }
  const added: VeHypothesisCandidate[] = [];
  const duplicates: string[] = [];
  for (const candidate of candidates) {
    const title = candidate.title.trim();
    const key = veBroadTitleKey(title);
    if (!key) continue;
    if (seen.has(key)) {
      duplicates.push(title);
      continue;
    }
    if (added.length >= slots) break;
    seen.add(key);
    added.push({ ...candidate, title, tier: 1, broad: true });
  }
  return { added, duplicates };
}
