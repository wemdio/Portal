import { CLIENT_LAUNCH_MAX_VARIANTS_PER_STEP, type ClientLaunchSequenceStep } from './types';

/** Минимальная форма письма цепочки, нужная для раскладки в шаги кампании. */
export interface HandoffLetter {
  subject?: string | null;
  body: string;
  wait_days?: number | null;
}

/**
 * Превращает цепочку писем в шаги кампании для мастера запуска.
 *
 * Логика (по решению 07.07): темы НЕ дублируются на каждый шаг (иначе каждый
 * фоллоу-ап стартует новый тред). Вместо этого:
 *  - разные темы писем цепочки собираются в A/B-варианты ПЕРВОГО шага
 *    (одинаковое тело = тело первого письма), максимум maxVariants (A/B/C/D);
 *  - тела фоллоу-апов остаются отдельными шагами с ПУСТОЙ темой — в Instantly
 *    это «продолжить ту же ветку», получатель видит историю переписки.
 *
 * Первое письмо всегда «сразу» (wait_days=0); у фоллоу-апов задержка своя.
 */
export function buildSequenceHandoffSteps(
  letters: HandoffLetter[],
  maxVariants: number = CLIENT_LAUNCH_MAX_VARIANTS_PER_STEP,
): ClientLaunchSequenceStep[] {
  if (letters.length === 0) return [];

  const firstBody = letters[0]?.body ?? '';

  // Уникальные непустые темы в порядке появления, максимум maxVariants (>=1).
  const cap = Math.max(1, maxVariants);
  const subjectPool: string[] = [];
  for (const l of letters) {
    const s = (l.subject ?? '').trim();
    if (s && !subjectPool.includes(s)) subjectPool.push(s);
  }
  const subjects = subjectPool.slice(0, cap);

  const firstStep: ClientLaunchSequenceStep = {
    subject: subjects[0] ?? (letters[0]?.subject ?? '').trim(),
    body: firstBody,
    wait_days: 0,
    ...(subjects.length > 1
      ? { variants: subjects.slice(1).map((s) => ({ subject: s, body: firstBody })) }
      : {}),
  };

  const followUps: ClientLaunchSequenceStep[] = letters.slice(1).map((l) => ({
    subject: '',
    body: l.body,
    wait_days: Math.max(0, l.wait_days ?? 2),
  }));

  return [firstStep, ...followUps];
}
