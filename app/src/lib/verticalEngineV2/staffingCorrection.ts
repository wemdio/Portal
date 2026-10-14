import { veStaffingScopeNote } from './relevanceReview';

/** A targeted repair of saved staffing-only refusals; never a global cache version. */
export const VE_STAFFING_CORRECTION_VERSION = 1;

export interface VeStaffingCorrectionScope {
  hypothesisTitle?: string;
  hypothesisDescription?: string;
  hypothesisOrigin?: 'generated' | 'manual';
}

export function veStaffingCorrectionApplies(target: VeStaffingCorrectionScope): boolean {
  return Boolean(veStaffingScopeNote('Target hypothesis: ' + (target.hypothesisTitle ?? '')
    + '\n' + (target.hypothesisDescription ?? ''), target.hypothesisOrigin));
}

/** The old reviewer must specifically have demanded the prospect's own staffing.
 * Mixed refusals (unproven SaaS/B2B/activity/region as well) are not reopened.
 * This only selects evidence for another independent review; it never admits. */
export function veHasStaffingOnlyRefusal(reason: unknown): boolean {
  if (typeof reason !== 'string') return false;
  const text = reason.replace(/^Смысловое соответствие не подтверждено:\s*/i, '').toLowerCase();
  const missing = /не\s+(?:подтвержд|доказ|показ|установ)|нет(?:\s|$)|отсутств|недостат|неяс|уточнить|не\s+хватает|\b(?:missing|unconfirmed|unclear|no evidence|not (?:shown|proven|established|confirmed)|lack)\b/i;
  const staffing = /remote[\s-]*(?:команд|team)|(?:удал[её]н|распредел[её]н)[а-я-]*\s+(?:команд|сотрудник)|(?:найм|на[йе]м|наним|\bhir(?:e|ing))[^.!?;]{0,65}(?:стран|countr)/i;
  if (!text.split(/[.!?;]/).some((part) => missing.test(part) && staffing.test(part))) return false;
  const required = '(?:saas|b2b|деятельност|тип(?:а|ом)?(?=\\s|[,.:;]|$)|собствен[^.!?;]{0,18}продукт|регион|географ|нахожд|располож|cis|снг)';
  const absence = '(?:не\\s+(?:подтвержд|доказ|показ|установ)|нет(?:\\s|$)|отсутств|недостат|неяс|missing|unconfirmed|not (?:shown|proven|established|confirmed)|no evidence)';
  const missingRequirement = new RegExp(absence + '[^.!?;]{0,85}' + required + '|' + required + '[^.!?;]{0,60}' + absence, 'i');
  return !text.split(/[.!?;]|(?:,\s*)?(?:\bbut\b|\bhowever\b|(?:^|\s)но\s|(?:^|\s)однако\s)/)
    .some((part) => missingRequirement.test(part));
}

/** Lightweight reserve selection; the gate checks the complete paid receipt. */
export function needsVeStaffingCorrection(decision: unknown, target: VeStaffingCorrectionScope): boolean {
  if (!veStaffingCorrectionApplies(target) || !decision || typeof decision !== 'object') return false;
  const value = decision as Record<string, unknown>;
  return value.status === 'needs_review' && value.staffing_correction_version !== VE_STAFFING_CORRECTION_VERSION
    && veHasStaffingOnlyRefusal(value.reason);
}
