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
