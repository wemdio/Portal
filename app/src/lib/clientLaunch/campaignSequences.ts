import type { CampaignSequence, SequenceStep } from '@/lib/instantly/types';
import type { ClientLaunchSequenceStep } from './types';

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasUsableStep(step: SequenceStep): boolean {
  if (hasText(step.subject) || hasText(step.body)) return true;
  return (step.variants ?? []).some((variant) => hasText(variant.subject) || hasText(variant.body));
}

export function hasUsableCampaignSequences(sequences?: CampaignSequence[] | null): boolean {
  return (sequences ?? []).some((sequence) => (sequence.steps ?? []).some(hasUsableStep));
}

export function clientLaunchStepsToCampaignSequences(
  steps: ClientLaunchSequenceStep[] | unknown,
  options?: { bodyFormatter?: (body: string) => string },
): CampaignSequence[] | null {
  if (!Array.isArray(steps)) return null;

  const formatBody = options?.bodyFormatter ?? ((body: string) => body);

  const convertedSteps: SequenceStep[] = steps
    .filter((step): step is ClientLaunchSequenceStep => {
      return Boolean(step) && typeof step === 'object' && hasText((step as ClientLaunchSequenceStep).body);
    })
    .map((step, index, allSteps) => ({
      type: 'email',
      delay: index < allSteps.length - 1 ? allSteps[index + 1].wait_days : 1,
      delay_unit: 'days',
      variants: [
        { subject: step.subject ?? '', body: formatBody(step.body) },
        ...(step.variants ?? []).map((variant) => ({
          subject: variant.subject ?? '',
          body: formatBody(variant.body),
        })),
      ],
    }));

  return convertedSteps.length > 0 ? [{ steps: convertedSteps }] : null;
}

export function campaignBodyToEditableText(value?: string): string {
  if (!value) return '';
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    // Hidden links round-trip: <a href="url">text</a> → [text](url) markdown,
    // so loading a campaign into edit mode shows the editable markdown the
    // client typed, and re-saving rebuilds the same <a>. Must run BEFORE the
    // general tag-strip below (else the <a> is stripped to bare text + the URL
    // is lost). Entities inside (&amp; in the URL) are decoded by the entity
    // replacements further down.
    .replace(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    // Bodies are <div>line</div> per line (see toInstantlyHtmlBody). Convert
    // only the CLOSING block tag to a newline; opening <div> is stripped by
    // the general tag-strip below. Converting BOTH would insert a blank line
    // between every adjacent line (<div>A</div><div>B</div> → "A\n\nB" instead
    // of "A\nB"). Closing-only keeps single line breaks faithful and makes the
    // edit round-trip (load → save → load) stable.
    .replace(/<\/(div|p|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function variantsFromCampaignStep(step: SequenceStep): Array<{ subject: string; body: string }> {
  const variants = step.variants?.length
    ? step.variants
    : [{ subject: step.subject ?? '', body: step.body ?? '' }];

  return variants.map((variant) => ({
    subject: variant.subject ?? '',
    body: campaignBodyToEditableText(variant.body),
  }));
}

export function editableStepsFromCampaignSteps(steps: SequenceStep[]): ClientLaunchSequenceStep[] {
  if (steps.length === 0) return [{ subject: '', body: '', wait_days: 0 }];

  return steps.map((step, idx, allSteps) => {
    const variants = variantsFromCampaignStep(step);
    const primary = variants[0] ?? { subject: '', body: '' };
    const previousStep = idx > 0 ? allSteps[idx - 1] : null;
    // Instantly omits delay_unit for day-based steps in GET responses.
    // Delay belongs to the previous step, not this follow-up.
    const waitDays =
      idx === 0
        ? 0
        : previousStep && (previousStep.delay_unit == null || previousStep.delay_unit === 'days') && typeof previousStep.delay === 'number'
          ? previousStep.delay
          : typeof step.wait_days === 'number'
            ? step.wait_days
            : 0;
    const extraVariants = variants
      .slice(1)
      .map((variant) => ({ subject: variant.subject, body: variant.body }))
      .filter((variant) => variant.subject.trim() || variant.body.trim());

    return {
      subject: primary.subject,
      body: primary.body,
      wait_days: Number.isFinite(waitDays) ? Math.max(0, Math.min(60, Math.floor(waitDays))) : 0,
      ...(extraVariants.length ? { variants: extraVariants } : {}),
    };
  });
}
