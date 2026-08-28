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
  done: 'border-transparent text-gray-700 hover:border-gray-200 hover:bg-gray-50',
  active: 'border-blue-200 bg-blue-50 text-blue-950',
  available: 'border-transparent text-gray-700 hover:border-gray-200 hover:bg-gray-50',
  locked: 'border-transparent text-gray-400 hover:border-gray-200 hover:bg-gray-50 hover:text-gray-600',
};

function StepMarker({ step }: { step: VeWizardStep }) {
  if (step.state === 'done') {
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-100 text-emerald-700">
        <Check aria-hidden className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (step.state === 'locked') {
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-gray-100 text-gray-400">
        <LockKeyhole aria-hidden className="h-3 w-3" />
      </span>
    );
  }
  return (
    <span
      className={`flex h-6 w-6 items-center justify-center rounded-md text-[11px] font-semibold ${
        step.state === 'active' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500'
      }`}
    >
      {String(step.id).padStart(2, '0')}
    </span>
  );
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
      <p className="mb-2 hidden text-[11px] font-semibold text-gray-500 lg:block">Этапы проекта</p>
      <ol className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0">
        {steps.map((step) => (
          <li key={step.id} className="shrink-0 lg:w-full">
            <button
              type="button"
              onClick={() => onJump(step.id)}
              aria-current={step.state === 'active' ? 'step' : undefined}
              className={`grid min-w-[176px] grid-cols-[24px_minmax(0,1fr)] items-start gap-2.5 rounded-lg border px-2.5 py-2.5 text-left transition active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 lg:min-w-0 lg:w-full ${BUTTON_CLASS[step.state]}`}
            >
              <StepMarker step={step} />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold leading-5">{step.label}</span>
                <span
                  className={`mt-0.5 hidden text-[11px] leading-4 lg:block ${
                    step.state === 'active' ? 'text-blue-700' : 'text-gray-500'
                  }`}
                >
                  {step.subtitle}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
