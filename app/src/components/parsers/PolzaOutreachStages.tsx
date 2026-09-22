'use client';

import { AlertCircle, Check, Loader2 } from 'lucide-react';
import type { PolzaOutreachFunnel } from '@/types';

/**
 * Конвейер англ. аутрича как цепочка этапов, а не как ряд цифр.
 *
 * Плоская воронка отвечала на вопрос «сколько», но не отвечала на главный:
 * ГДЕ сейчас работа и где она встала. Шесть чисел подряд, все нули — и по ним
 * не понять, то ли конвейер не запускался, то ли упал на первом шаге, то ли
 * честно не нашёл ни одной вакансии. Ровно на этом 22.09 и споткнулись:
 * запрос падал на первом же шаге, а воронка показывала просто нули.
 *
 * Поэтому у каждого этапа три вещи: что он делает, сколько прошло дальше и
 * сколько отсеялось между ним и предыдущим. Отсев — это и есть содержательная
 * часть: «из 80 вакансий домен нашёлся у 62» говорит больше, чем оба числа
 * по отдельности.
 */

type StageState = 'done' | 'active' | 'error' | 'stopped' | 'pending';

interface StageDef {
  key: keyof PolzaOutreachFunnel;
  label: string;
  hint: string;
}

const STAGES: StageDef[] = [
  { key: 'vacancies', label: 'Вакансии', hint: 'Свежие SDR/BDR-вакансии из кэша: одна компания — одна самая свежая' },
  { key: 'domain_found', label: 'Домен компании', hint: 'Ищем официальный сайт компании — без него дальше идти некуда' },
  { key: 'icp_passed', label: 'Фильтр ICP', hint: 'Отсеиваем тех, кто нам не подходит по профилю' },
  { key: 'geo_confirmed', label: 'Гео продаж', hint: 'ИИ читает вакансию и находит гео с дословной цитатой-доказательством' },
  { key: 'email_found', label: 'Корпоративная почта', hint: 'Ищем адрес на сайте компании' },
  { key: 'ready', label: 'Цепочка писем', hint: 'Четыре письма по утверждённым шаблонам с проверкой правил' },
];

const MARKER_CLASS: Record<StageState, string> = {
  done: 'bg-emerald-100 text-emerald-700',
  active: 'bg-indigo-100 text-indigo-700',
  error: 'bg-rose-100 text-rose-700',
  stopped: 'bg-amber-100 text-amber-700',
  pending: 'bg-gray-100 text-gray-400',
};

const ROW_CLASS: Record<StageState, string> = {
  done: 'border-gray-200 bg-white',
  active: 'border-indigo-300 bg-indigo-50/50',
  error: 'border-rose-300 bg-rose-50/50',
  stopped: 'border-amber-300 bg-amber-50/50',
  pending: 'border-gray-200 bg-gray-50/60',
};

/**
 * Состояние этапов по числам воронки и по тому, что сейчас с запуском.
 *
 * Правило простое: этап пройден, если до него что-то дошло. Первый этап,
 * до которого не дошло ничего, — это и есть место, где работа находится
 * сейчас (или где она встала). Отдельно вынесены «ещё не запускали» и
 * «запуск упал»: без этого пустая воронка выглядит одинаково во всех
 * трёх случаях.
 */
export function stageStates(
  funnel: PolzaOutreachFunnel | null | undefined,
  run: { running: boolean; failed: boolean } | null,
): StageState[] {
  const counts = STAGES.map((stage) => (funnel ? Number(funnel[stage.key] ?? 0) : 0));
  let frontier = counts.findIndex((value) => value === 0);
  if (frontier === -1) frontier = STAGES.length; // всё прошло до конца

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

export function PolzaOutreachStages({
  funnel,
  run,
  error,
}: {
  funnel: PolzaOutreachFunnel | null | undefined;
  /** Текущий запуск: идёт он или упал. null — запусков ещё не было. */
  run: { running: boolean; failed: boolean } | null;
  /** Текст ошибки запуска — показываем у того этапа, на котором встали. */
  error?: string | null;
}) {
  const states = stageStates(funnel, run);
  const counts = STAGES.map((stage) => (funnel ? Number(funnel[stage.key] ?? 0) : 0));

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
        {STAGES.map((stage, index) => {
          const state = states[index];
          const value = counts[index];
          const prev = index === 0 ? null : counts[index - 1];
          // Отсев считаем только между пройденными этапами: пока до этапа
          // никто не дошёл, «отсеяно» — это не ноль, а «неизвестно».
          const dropped = prev !== null && state === 'done' ? Math.max(0, prev - value) : null;

          return (
            <li key={stage.key} className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 ${ROW_CLASS[state]}`}>
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
                  <p className="mt-1 text-xs leading-relaxed text-rose-700">{error}</p>
                ) : null}
              </div>

              <span
                className={`shrink-0 text-base font-semibold tabular-nums ${
                  state === 'pending' ? 'text-gray-300' : 'text-gray-900'
                }`}
              >
                {value}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
