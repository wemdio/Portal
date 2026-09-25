'use client';

import { AlertCircle, Check, Loader2 } from 'lucide-react';

/**
 * Конвейер аутрича как цепочка этапов (общий для английского и русского).
 * Смысл и история решения — в шапке PolzaOutreachStages.tsx.
 */

export type StageState = 'done' | 'active' | 'error' | 'stopped' | 'pending';

export interface StageView {
  label: string;
  hint: string;
  count: number;
}

const MARKER_CLASS: Record<StageState, string> = {
  done: 'bg-emerald-100 text-emerald-700',
  active: 'bg-indigo-100 text-indigo-700',
  error: 'bg-rose-100 text-rose-700',
  stopped: 'bg-amber-100 text-amber-700',
  pending: 'bg-gray-100 text-gray-400',
};

/**
 * Текущий этап выделяется рамкой и цветной полосой слева, а не заливкой.
 *
 * Заливка вида bg-rose-50 в тёмной теме превращается в светлый прямоугольник,
 * на котором приглушённый серый текст пояснения становится нечитаемым — ровно
 * это и вышло с первым вариантом. Рамка и полоса работают в обеих темах
 * одинаково, потому что берут цвет границы, а не фона.
 */
const ROW_CLASS: Record<StageState, string> = {
  done: 'border-gray-200 border-l-2 border-l-emerald-400',
  active: 'border-indigo-400 border-l-2 border-l-indigo-500',
  error: 'border-rose-400 border-l-2 border-l-rose-500',
  stopped: 'border-amber-400 border-l-2 border-l-amber-500',
  pending: 'border-gray-200 border-l-2 border-l-transparent',
};

/** Первый этап с нулём — текущий (или вставший). Правило из PolzaOutreachStages. */
export function stageStatesFromCounts(
  counts: number[],
  run: { running: boolean; failed: boolean } | null,
): StageState[] {
  let frontier = counts.findIndex((value) => value === 0);
  if (frontier === -1) frontier = counts.length; // всё прошло до конца

  return counts.map((_, index) => {
    if (index < frontier) return 'done';
    if (index > frontier) return 'pending';
    if (run?.failed) return 'error';
    if (run?.running) return 'active';
    return run ? 'stopped' : 'pending';
  });
}

function Marker({ state, index }: { state: StageState; index: number }) {
  return (
    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${MARKER_CLASS[state]}`}>
      {state === 'done' ? (
        <Check aria-hidden className="h-4 w-4" />
      ) : state === 'active' ? (
        <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
      ) : state === 'error' ? (
        <AlertCircle aria-hidden className="h-4 w-4" />
      ) : (
        String(index + 1).padStart(2, '0')
      )}
    </span>
  );
}

export function OutreachStages({
  stages,
  run,
  error,
  onOpenStage,
}: {
  stages: StageView[];
  /** Текущий запуск: идёт он или упал. null — запусков ещё не было. */
  run: { running: boolean; failed: boolean } | null;
  /** Текст ошибки запуска — показываем у того этапа, на котором встали. */
  error?: string | null;
  /** Открыть разбор этапа: кто прошёл, кто нет и почему. */
  onOpenStage?: (index: number) => void;
}) {
  const counts = stages.map((s) => s.count);
  const states = stageStatesFromCounts(counts, run);

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-gray-900">Как идёт работа</h3>
        <span className="text-xs text-gray-500">
          {!run
            ? 'Запусков ещё не было'
            : run.failed
              ? 'Запуск остановился с ошибкой'
              : run.running
                ? 'Запуск идёт'
                : 'Запуск завершён'}
        </span>
      </div>

      <ol className="space-y-1.5">
        {stages.map((stage, index) => {
          const state = states[index];
          const value = counts[index];
          const prev = index === 0 ? null : counts[index - 1];
          // Отсев считаем только между пройденными этапами: пока до этапа
          // никто не дошёл, «отсеяно» — это не ноль, а «неизвестно».
          const dropped = prev !== null && state === 'done' ? Math.max(0, prev - value) : null;

          return (
            <li key={index}>
              {/* Строка — кнопка: за числом «домен нашёлся у 32 из 100» сразу
                  встаёт вопрос «а у кого не нашёлся», и ответ должен быть в
                  одном клике, а не в выгрузке CSV. */}
              <button
                type="button"
                onClick={() => onOpenStage?.(index)}
                disabled={!onOpenStage}
                className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition enabled:hover:border-indigo-400 ${ROW_CLASS[state]}`}
              >
              <Marker state={state} index={index} />

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-medium text-gray-900">{stage.label}</span>
                  {dropped !== null && dropped > 0 ? (
                    <span className="text-[11px] text-gray-500">отсеяно {dropped}</span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-gray-500">{stage.hint}</p>
                {state === 'error' && error ? (
                  <p className="mt-1 break-words text-xs leading-relaxed text-rose-500">{error}</p>
                ) : null}
              </div>

              <span
                className={`shrink-0 text-base font-semibold tabular-nums ${
                  state === 'pending' ? 'text-gray-300' : 'text-gray-900'
                }`}
              >
                {value}
              </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
