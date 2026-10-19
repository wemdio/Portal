import type { ClientLaunchSequenceStep } from './types';

/** Минимальная форма письма цепочки, нужная для раскладки в шаги кампании. */
export interface HandoffLetter {
  subject?: string | null;
  body: string;
  wait_days?: number | null;
}

/**
 * Превращает цепочку писем в шаги кампании для мастера запуска.
 *
 * У каждого письма остаются его тема, текст и интервал. Темы следующих
 * писем не являются A/B-вариантами первого. Пустая тема сохраняется только
 * если она пустая в исходном письме (продолжение прежней переписки).
 * Первое письмо всегда «сразу» (wait_days=0); у фоллоу-апов задержка своя.
 */
export function buildSequenceHandoffSteps(
  letters: HandoffLetter[],
): ClientLaunchSequenceStep[] {
  return letters.map((letter, index) => ({
    subject: (letter.subject ?? '').trim(),
    body: letter.body,
    wait_days: index === 0 ? 0 : Math.max(0, letter.wait_days ?? 2),
  }));
}
