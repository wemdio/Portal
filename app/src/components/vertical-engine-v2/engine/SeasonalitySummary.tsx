'use client';

import type { JSX } from 'react';
import { evaluateRuSeasonality } from '@/lib/verticalEngineV2/ruSeasonality';
import type {
  VeRuSeasonality,
  VeRuSeasonalityState,
  VeRuSeasonalityWindow,
} from '@/lib/verticalEngineV2/types';
import { HE } from './design';

type SeasonalityConfidence = 'high' | 'medium' | 'low';

const STATUS_META: Record<
  VeRuSeasonalityState,
  { label: string; dot: string; outcome: string }
> = {
  launch_now: {
    label: 'Запускать сейчас',
    dot: 'bg-emerald-500',
    outcome: 'Можно запускать: подтверждённое окно outreach уже открыто.',
  },
  prepare_now: {
    label: 'Готовить сейчас',
    dot: 'bg-blue-500',
    outcome: 'Соберите PAUSED-кампании сейчас, активируйте в запланированную дату.',
  },
  neutral: {
    label: 'Круглый год',
    dot: 'bg-sky-500',
    outcome: 'Выраженного сезонного ограничения не подтверждено.',
  },
  wait: {
    label: 'Ждать',
    dot: 'bg-amber-500',
    outcome: 'Подготовку можно планировать, но sending пока рано активировать.',
  },
  avoid: {
    label: 'Избегать',
    dot: 'bg-red-500',
    outcome: 'Сейчас действует подтверждённое нежелательное окно.',
  },
  unknown: {
    label: 'Нужно решение',
    dot: 'bg-gray-400',
    outcome: 'Проверенных данных недостаточно — автоматическая активация закрыта.',
  },
};

function confidenceOf(assessment: VeRuSeasonality): SeasonalityConfidence {
  const explicit = (assessment as VeRuSeasonality & { confidence?: unknown }).confidence;
  if (explicit === 'high' || explicit === 'medium' || explicit === 'low') return explicit;
  if (assessment.classification === 'unknown' || assessment.evidence.length === 0) return 'low';
  return assessment.evidence.length > 1 ? 'high' : 'medium';
}

function confidenceLabel(confidence: SeasonalityConfidence): string {
  if (confidence === 'high') return 'Высокая уверенность';
  if (confidence === 'medium') return 'Средняя уверенность';
  return 'Низкая уверенность';
}

function formatDateKey(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(date);
}

function monthDayLabel(value: string): string {
  const match = /^(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const date = new Date(Date.UTC(2026, Number(match[1]) - 1, Number(match[2]), 12));
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(date);
}

function windowDateLabel(window: VeRuSeasonalityWindow): string {
  return `${monthDayLabel(window.start_mm_dd)} — ${monthDayLabel(window.end_mm_dd)}`;
}

export function SeasonalityStatus({ state }: { state: VeRuSeasonalityState }): JSX.Element {
  const meta = STATUS_META[state];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-800">
      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  );
}

/** Short hypothesis-level signal. The detailed evidence stays on the base step. */
export function HypothesisSeasonalitySummary({
  assessment,
}: {
  assessment: VeRuSeasonality;
}): JSX.Element {
  const evaluation = evaluateRuSeasonality(assessment);
  const planned = formatDateKey(evaluation.planned_activation_date);
  return (
    <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50/70 px-3 py-2.5">
      <p className={HE.eyebrow}>Предварительная сезонная оценка</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <SeasonalityStatus state={evaluation.state} />
        <span className={HE.faint}>{confidenceLabel(confidenceOf(assessment))}</span>
        {planned && evaluation.state !== 'launch_now' && evaluation.state !== 'neutral' ? (
          <span className="text-xs font-medium text-gray-700">Активировать с {planned}</span>
        ) : null}
      </div>
      <p className={`mt-1.5 text-xs leading-5 ${HE.muted}`}>{assessment.rationale}</p>
    </div>
  );
}

function WindowList({
  title,
  windows,
}: {
  title: string;
  windows: VeRuSeasonalityWindow[];
}): JSX.Element | null {
  if (windows.length === 0) return null;
  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-800">{title}</h3>
      <ul className="mt-1.5 space-y-1.5">
        {windows.map((window, index) => (
          <li key={`${window.kind}-${window.start_mm_dd}-${index}`} className="text-xs text-gray-600">
            <span className="font-medium text-gray-800">{window.label}</span>
            <span> · {windowDateLabel(window)}</span>
            {window.kind === 'peak' && window.lead_days > 0 ? (
              <span> · outreach за {window.lead_days} дн.</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Structured base-step view: decision first, then windows and verified sources. */
export function SeasonalityDetail({
  assessment,
}: {
  assessment: VeRuSeasonality;
}): JSX.Element {
  const evaluation = evaluateRuSeasonality(assessment);
  const meta = STATUS_META[evaluation.state];
  const peakWindows = assessment.windows.filter((window) => window.kind === 'peak');
  const avoidWindows = assessment.windows.filter((window) => window.kind === 'avoid');

  return (
    <section
      aria-label="Сезонность и время запуска"
      className="rounded-lg border border-gray-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className={HE.eyebrow}>Сезонность и время запуска</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <SeasonalityStatus state={evaluation.state} />
            <span className={HE.faint}>{confidenceLabel(confidenceOf(assessment))}</span>
          </div>
        </div>
        <p className="max-w-xl text-xs leading-5 text-gray-600">{meta.outcome}</p>
      </div>
      <p className="mt-3 text-sm leading-6 text-gray-700">{assessment.rationale}</p>

      {peakWindows.length > 0 || avoidWindows.length > 0 ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <WindowList title="Благоприятные окна" windows={peakWindows} />
          <WindowList title="Нежелательные окна" windows={avoidWindows} />
        </div>
      ) : null}

      {assessment.evidence.length > 0 ? (
        <div className="mt-4 border-t border-gray-100 pt-3">
          <h3 className="text-xs font-semibold text-gray-800">Проверенные источники</h3>
          <ul className="mt-2 space-y-2">
            {assessment.evidence.map((evidence, index) => (
              <li key={`${evidence.source_url}-${index}`} className="text-xs leading-5 text-gray-600">
                <a
                  href={evidence.source_url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-blue-700 underline underline-offset-2 hover:text-blue-900"
                >
                  {evidence.claim}
                </a>
                <p className="mt-0.5 text-gray-500">{evidence.quote}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
