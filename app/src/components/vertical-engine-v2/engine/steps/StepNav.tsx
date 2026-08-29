'use client';

import { Check, LockKeyhole } from 'lucide-react';

export type VeWizardStepState = 'done' | 'active' | 'available' | 'locked';

export interface VeWizardStep {
  id: number;
  label: string;
  subtitle: string;
  state: VeWizardStepState;
}

const BUTTON_CLASS: Record<VeWizardStepState, string> = {
  done: 've2-sn-done',
  active: 've2-sn-act',
  available: '',
  locked: 've2-sn-lock',
};

function StepMarker({ step }: { step: VeWizardStep }) {
  if (step.state === 'done') {
    return (
      <span className="ve2-sn-mk">
        <Check aria-hidden className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (step.state === 'locked') {
    return (
      <span className="ve2-sn-mk">
        <LockKeyhole aria-hidden className="h-3 w-3" />
      </span>
    );
  }
  return <span className="ve2-sn-mk">{String(step.id).padStart(2, '0')}</span>;
}

export function StepNav({
  steps,
  onJump,
}: {
  steps: VeWizardStep[];
  onJump: (step: number) => void;
}) {
  return (
    <nav aria-label="Этапы проекта" className="min-w-0">
      <p className="ve2-eb mb-2 hidden lg:block">Этапы проекта</p>
      <ol className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0">
        {steps.map((step) => (
          <li key={step.id} className="shrink-0 lg:w-full">
            <button
              type="button"
              onClick={() => onJump(step.id)}
              aria-current={step.state === 'active' ? 'step' : undefined}
              className={`ve2-sn min-w-[176px] lg:min-w-0 lg:w-full ${BUTTON_CLASS[step.state]}`.trim()}
            >
              <StepMarker step={step} />
              <span className="min-w-0">
                <span className="ve2-sn-l">{step.label}</span>
                <span className="ve2-sn-s hidden lg:block">{step.subtitle}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
