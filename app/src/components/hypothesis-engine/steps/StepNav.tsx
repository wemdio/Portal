'use client';

/**
 * Горизонтальный степпер мастера «Движка вертикалей»: нумерованные кружки
 * с соединительными линиями, подпись и короткий подзаголовок у каждого шага.
 * Чисто презентационный компонент: состояния шагов считает ProjectDetail,
 * клик по шагу → onJump(step.id). «Locked»-шаги приглушены, но остаются
 * кликабельными — навигация никогда не блокируется.
 * Палитра — как у соседних инструментов: белая подложка, тёмный (gray-900)
 * активный шаг, emerald-акценты для пройденных.
 */

import { Check } from 'lucide-react';

export type HeWizardStepState = 'done' | 'active' | 'available' | 'locked';

export interface HeWizardStep {
  id: number;
  label: string;
  subtitle: string;
  state: HeWizardStepState;
}

const CIRCLE_CLASS: Record<HeWizardStepState, string> = {
  done: 'border-emerald-500 bg-emerald-500 text-white',
  active: 'border-gray-900 bg-gray-900 text-white shadow-sm',
  available:
    'border-gray-300 bg-white text-gray-500 group-hover:border-gray-400 group-hover:text-gray-700',
  locked:
    'border-gray-200 bg-gray-50 text-gray-300 group-hover:border-gray-300 group-hover:text-gray-400',
};

const LABEL_CLASS: Record<HeWizardStepState, string> = {
  done: 'text-emerald-700',
  active: 'text-gray-900',
  available: 'text-gray-600 group-hover:text-gray-800',
  locked: 'text-gray-400 group-hover:text-gray-500',
};

export function StepNav({
  steps,
  onJump,
}: {
  steps: HeWizardStep[];
  onJump: (step: number) => void;
}) {
  return (
    <nav aria-label="Шаги мастера">
      <ol className="flex w-full items-start">
        {steps.map((step, idx) => (
          <li key={step.id} className="relative min-w-0 flex-1">
            {/* Соединительная линия к предыдущему шагу; зеленеет вслед за пройденными */}
            {idx > 0 ? (
              <span
                aria-hidden
                className={`absolute left-[calc(-50%+1.375rem)] right-[calc(50%+1.375rem)] top-5 h-0.5 ${
                  steps[idx - 1].state === 'done' ? 'bg-emerald-300' : 'bg-gray-200'
                }`}
              />
            ) : null}
            <button
              type="button"
              onClick={() => onJump(step.id)}
              aria-current={step.state === 'active' ? 'step' : undefined}
              className="group relative flex w-full min-w-0 flex-col items-center gap-1.5 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
            >
              <span
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border text-sm font-semibold transition-colors ${CIRCLE_CLASS[step.state]}`}
              >
                {step.state === 'done' ? <Check className="h-5 w-5" aria-hidden /> : step.id}
              </span>
              <span
                className={`min-w-0 max-w-full text-[11px] font-semibold leading-tight sm:text-xs md:text-sm ${LABEL_CLASS[step.state]}`}
              >
                {step.label}
              </span>
              {/* Подзаголовок прячется на узких экранах */}
              <span className="hidden max-w-full text-[11px] leading-tight text-gray-400 md:block">
                {step.subtitle}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
