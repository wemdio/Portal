import type {
  ClientLaunchSequenceStep,
  ClientLaunchSequenceVariant,
} from './types';

export function normalizeClientLaunchSequenceSteps(raw: unknown): ClientLaunchSequenceStep[] {
  const sequenceSteps = Array.isArray(raw) ? raw : [];

  return sequenceSteps.map((s) => {
    const step = (s ?? {}) as Record<string, unknown>;
    const rawVariants = Array.isArray(step.variants) ? step.variants : [];
    const variants: ClientLaunchSequenceVariant[] = rawVariants
      .map((v) => {
        const variant = (v ?? {}) as Record<string, unknown>;
        return {
          subject: typeof variant.subject === 'string' ? variant.subject : '',
          body: typeof variant.body === 'string' ? variant.body : '',
        };
      })
      .filter((v) => (v.subject ?? '').trim() !== '' || v.body.trim() !== '');

    return {
      subject: typeof step.subject === 'string' ? step.subject : '',
      body: typeof step.body === 'string' ? step.body : '',
      wait_days: Number.isFinite(Number(step.wait_days))
        ? Math.max(0, Math.floor(Number(step.wait_days)))
        : 0,
      ...(variants.length > 0 ? { variants } : {}),
    };
  });
}
