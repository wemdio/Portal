import { detectVeClinicSourceProfile } from './clinicSourcePolicy';

export interface VeMedicalTarget {
  hypothesisTitle?: string;
  hypothesisDescription?: string;
  hypothesisOrigin?: 'generated' | 'manual';
}

/** A clarification next to the target, not a new policy/cache version. */
export function veMedicalScopeNote(scope: string, origin?: VeMedicalTarget['hypothesisOrigin']): string {
  if (origin !== 'generated') return '';
  const title = /Target hypothesis: ([^\n]+)/.exec(scope)?.[1] ?? '';
  if (!detectVeClinicSourceProfile([{ title }])) return '';
  // A generated profile can still repeat an explicit specialist constraint.
  // Ambiguous mandatory language keeps the existing policy unchanged.
  if (/обязательн|строго|только\s+с(?:\s|$)|\b(?:mandatory|must|required|only with)\b/i.test(scope)) return '';
  return 'MEDICAL PROVIDERS: require affirmative evidence that this organization actually provides the target clinical service or operates the specialist unit. A clinic name, directory category, navigation label, price alone, equipment supplier, appointment directory, educational support or adjacent non-surgical cosmetology is not that evidence. '
    + 'For a generated buyer profile, an unpublished licence, doctor count or dental-chair count is missing regulatory/size context, not a missing clinical service. Do not withhold a proven clinic solely for this missing context; an explicitly smaller size or a single-person practice remains unresolved. '
    + 'Keep actual structural requirements: private/state ownership, geography, a network and an operating block or other own facility explicitly required by the target must still be evidenced. Do not infer an operating block merely from surgery, or private ownership merely from prices. A manual or explicitly mandatory condition is never relaxed by this clarification.';
}
