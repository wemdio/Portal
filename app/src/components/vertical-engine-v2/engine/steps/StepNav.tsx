'use client';

/**
 * Горизонтальный степпер мастера «Движка вертикалей»: нумерованные кружки
 * (StepNum, номер виден всегда — без галочек), подпись и короткий подзаголовок
 * у каждого шага. Активный шаг — синее подчёркивание 2px под подписью.
 * Плашка липкая (sticky top-0 + backdrop-blur): шаги остаются на экране
 * при скролле длинных досок и писем.
 * Чисто презентационный компонент: состояния шагов считает ProjectDetail,
 * клик по шагу → onJump(step.id). «Locked»-шаги приглушены, но остаются
 * кликабельными — навигация никогда не блокируется.
 * Палитра: белая подложка, один blue-акцент для пройденных/активного шага.
 */

import { StepNum } from '../design';

export type VeWizardStepState = 'done' | 'active' | 'available' | 'locked';

export interface VeWizardStep {
  id: number;
  label: string;
  subtitle: string;
  state: VeWizardStepState;
}

const LABEL_CLASS: Record<VeWizardStepState, string> = {
  done: 'text-gray-900',
  active: 'text-blue-700',
  available: 'text-gray-600 group-hover:text-gray-900',
  locked: 'text-gray-500 group-hover:text-gray-700',
};

/** 4 состояния мастера → 3 состояния кружка: available и locked делят idle. */
function stepNumState(state: VeWizardStepState): 'done' | 'active' | 'idle' {
  if (state === 'done') return 'done';
  if (state === 'active') return 'active';
  return 'idle';
}

export function StepNav({
  steps,
  onJump,
}: {
  steps: VeWizardStep[];
  onJump: (step: number) => void;
}) {
  return (
    // Липкая плашка поверх длинных экранов шагов: отрицательные margin
    // компенсируют responsive-отступы контейнера ProjectDetail
    // (px-4 / sm:px-6 / lg:px-8), так что при скролле полоса идёт во всю
    // ширину оболочки — с backdrop-blur и нижней границей, как TopNav.
    <nav
      aria-label="Шаги мастера"
      className="sticky top-14 z-20 -mx-4 border-b border-gray-200 bg-white/90 px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6 sm:py-4 md:top-0 lg:-mx-8 lg:px-8"
    >
      {/* Колонки flex-1 равной ширины: на широкой оболочке шаги сами
          разъезжаются по краям (тот же эффект, что justify-between), а
          геометрия соединительных линий (calc(-50% …)) не ломается —
          gap/justify-between здесь разорвали бы стыковку линий с кружками. */}
      <ol className="flex w-full items-start">
        {steps.map((step, idx) => (
          <li key={step.id} className="relative min-w-0 flex-1">
            {/* Соединительная линия к предыдущему шагу (центр кружка h-7: top-3.5) */}
            {idx > 0 ? (
              <span
                aria-hidden
                className={`absolute left-[calc(-50%+1rem)] right-[calc(50%+1rem)] top-3.5 h-0.5 transition-colors ${
                  steps[idx - 1]?.state === 'done' ? 'bg-blue-600' : 'bg-gray-200'
                }`}
              />
            ) : null}
            <button
              type="button"
              onClick={() => onJump(step.id)}
              aria-current={step.state === 'active' ? 'step' : undefined}
              className="group relative flex w-full min-w-0 flex-col items-center gap-1.5 rounded-lg transition active:scale-[0.97] focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
            >
              <StepNum n={step.id} state={stepNumState(step.state)} />
              <span
                className={`min-w-0 max-w-full text-[11px] font-semibold leading-tight transition-colors sm:text-xs md:text-sm ${LABEL_CLASS[step.state]}`}
              >
                {step.label}
              </span>
              {/* Подзаголовок прячется на узких экранах */}
              <span className="hidden max-w-full text-[11px] leading-tight text-gray-500 transition-colors md:block">
                {step.subtitle}
              </span>
              {/* Активный шаг: синее подчёркивание 2px (у остальных — прозрачная
                  полоса той же высоты, чтобы геометрия шагов совпадала) */}
              <span
                aria-hidden
                className={`h-1 w-12 rounded-full transition-colors ${step.state === 'active' ? 'bg-blue-600' : 'bg-transparent'}`}
              />
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
