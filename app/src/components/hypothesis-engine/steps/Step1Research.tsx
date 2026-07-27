'use client';

/**
 * Шаг 1 мастера «Движка вертикалей» — «Исследование».
 * Три состояния: пустое (объяснение + запуск + оффер), прогресс по стадиям
 * research-пайплайна человеческими формулировками (без технических деталей)
 * и компактное «готово». Навигация между шагами — забота оболочки (ProjectDetail).
 * Питается от массива jobs проекта: состояние стадии = статус её последней джобы.
 */

import { useRef, useState, type JSX } from 'react';
import { AlertCircle, Check, CheckCircle2, FlaskConical, Play, XCircle } from 'lucide-react';
import type { HeStage } from '@/lib/hypothesisEngine/types';
import { Spinner } from '../ui';
import type { HeJobSummary, HeProjectDetailResponse } from '../api';

/** line — строка в чек-листе прогресса; name — короткое имя для сообщения об ошибке. */
const RESEARCH_STAGES: Array<{ stage: HeStage; line: string; name: string }> = [
  { stage: 'site_profile', line: 'Изучаем сайт клиента', name: 'Изучение сайта' },
  { stage: 'competitors', line: 'Ищем конкурентов', name: 'Поиск конкурентов' },
  { stage: 'brand_cloud', line: 'Разбираем клиентов конкурентов', name: 'Разбор клиентов конкурентов' },
  { stage: 'hypotheses', line: 'Генерируем гипотезы рынков', name: 'Генерация гипотез' },
  { stage: 'evidence', line: 'Проверяем каждую гипотезу источниками', name: 'Проверка гипотез' },
  { stage: 'clustering', line: 'Собираем вертикали', name: 'Сборка вертикалей' },
];

const RESEARCH_STAGE_SET: ReadonlySet<HeStage> = new Set(RESEARCH_STAGES.map((s) => s.stage));

/** Последняя (по порядку в выдаче) джоба данной стадии. */
function latestJobOf(jobs: HeJobSummary[], stage: HeStage): HeJobSummary | undefined {
  for (let i = jobs.length - 1; i >= 0; i -= 1) {
    if (jobs[i].stage === stage) return jobs[i];
  }
  return undefined;
}

export interface Step1ResearchProps {
  project: HeProjectDetailResponse['project'];
  jobs: HeJobSummary[];
  busy: boolean;
  onStartResearch: () => void;
  offerValue: string;
  onSaveOffer: (v: string) => Promise<void> | void;
}

export function Step1Research({
  project,
  jobs,
  busy,
  onStartResearch,
  offerValue,
  onSaveOffer,
}: Step1ResearchProps): JSX.Element {
  const status = project?.status;
  const researchJobs = jobs.filter((j) => RESEARCH_STAGE_SET.has(j.stage));
  const hasActiveResearch = researchJobs.some((j) => j.status === 'pending' || j.status === 'running');
  const failedStages = RESEARCH_STAGES.filter(({ stage }) => latestJobOf(jobs, stage)?.status === 'failed');

  const running = busy || hasActiveResearch || status === 'researching';
  const done = !running && status === 'researched';
  const failed = !running && !done && (failedStages.length > 0 || status === 'failed');

  if (running) {
    return (
      <section className="mx-auto max-w-xl rounded-xl border border-gray-800 bg-gray-900 p-6">
        <h2 className="mb-4 text-base font-semibold text-gray-100">Идёт исследование…</h2>
        <StageChecklist jobs={jobs} running />
        {failedStages.length > 0 ? (
          <FailureNote failedStages={failedStages} jobs={jobs} busy={busy} onRetry={onStartResearch} />
        ) : null}
        <p className="mt-4 text-xs text-gray-500">
          Это займёт несколько минут, страницу можно не держать открытой.
        </p>
      </section>
    );
  }

  if (failed) {
    return (
      <section className="mx-auto max-w-xl rounded-xl border border-gray-800 bg-gray-900 p-6">
        <h2 className="mb-4 text-base font-semibold text-gray-100">Исследование остановилось</h2>
        <StageChecklist jobs={jobs} running={false} />
        <FailureNote
          failedStages={failedStages}
          jobs={jobs}
          projectError={failedStages.length === 0 ? project?.error : undefined}
          busy={busy}
          onRetry={onStartResearch}
        />
      </section>
    );
  }

  if (done) {
    return (
      <section className="mx-auto max-w-xl rounded-xl border border-gray-800 bg-gray-900 p-6">
        <div className="flex items-start gap-3 rounded-xl border border-emerald-900/60 bg-emerald-950/40 px-4 py-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" aria-hidden />
          <div>
            <p className="text-sm font-semibold text-emerald-200">Исследование готово</p>
            <p className="mt-0.5 text-sm text-emerald-200/70">
              Вертикали собраны — переходим к выбору направления.
            </p>
          </div>
        </div>
        <div className="mt-4 text-center">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  'Перезапустить исследование? Движок заново пройдёт все стадии — это займёт 10–20 минут.',
                )
              ) {
                onStartResearch();
              }
            }}
            className="text-xs font-medium text-gray-500 underline decoration-dotted underline-offset-4 transition hover:text-gray-300 disabled:opacity-50"
          >
            Перезапустить исследование
          </button>
        </div>
      </section>
    );
  }

  return <NotStarted busy={busy} onStartResearch={onStartResearch} offerValue={offerValue} onSaveOffer={onSaveOffer} />;
}

/* ─────────────────────────── Состояния ─────────────────────────── */

function NotStarted({
  busy,
  onStartResearch,
  offerValue,
  onSaveOffer,
}: {
  busy: boolean;
  onStartResearch: () => void;
  offerValue: string;
  onSaveOffer: (v: string) => Promise<void> | void;
}) {
  return (
    <section className="mx-auto max-w-xl rounded-xl border border-gray-800 bg-gray-900 px-6 py-10 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-950/60 text-emerald-400">
        <FlaskConical className="h-6 w-6" aria-hidden />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-gray-100">Исследование рынка</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-gray-400">
        Движок изучит сайт, найдёт конкурентов и их клиентов, соберёт 25–40 гипотез рынков с доказательствами
        и сложит их в вертикали. Обычно 10–20 минут.
      </p>
      <button
        type="button"
        onClick={onStartResearch}
        disabled={busy}
        className="mt-6 inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? <Spinner className="h-4 w-4" /> : <Play className="h-4 w-4" aria-hidden />}
        Запустить исследование
      </button>
      <OfferBlock offerValue={offerValue} onSaveOffer={onSaveOffer} />
    </section>
  );
}

/** Оффер: необязательная формулировка, которую движок использует в письмах. */
function OfferBlock({
  offerValue,
  onSaveOffer,
}: {
  offerValue: string;
  onSaveOffer: (v: string) => Promise<void> | void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSaveOffer(taRef.current?.value ?? '');
      setSaved(true);
      setDirty(false);
      window.setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-8 rounded-xl border border-gray-800 bg-gray-950/50 p-4 text-left">
      <label htmlFor="he-step1-offer" className="text-xs font-semibold uppercase tracking-widest text-gray-500">
        Оффер (необязательно)
      </label>
      <p className="mt-1 text-xs leading-relaxed text-gray-500">
        Как именно продаём: кому, что и в какие сроки — движок использует эту формулировку в письмах
      </p>
      <textarea
        id="he-step1-offer"
        ref={taRef}
        rows={2}
        defaultValue={offerValue}
        onChange={() => {
          setDirty(true);
          setSaved(false);
        }}
        placeholder="Например: 3–5 встреч в месяц с HRD крупных работодателей, тест за 2 недели"
        className="mt-2 w-full resize-y rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-900/60"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || !dirty}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs font-medium text-gray-300 transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
          Сохранить
        </button>
        {saved ? <span className="text-xs text-emerald-400">Сохранено ✓</span> : null}
      </div>
    </div>
  );
}

type StageState = 'done' | 'current' | 'upcoming' | 'failed';

/** Вертикальный чек-лист стадий: сделано / идёт / впереди / не удалось. */
function StageChecklist({ jobs, running }: { jobs: HeJobSummary[]; running: boolean }) {
  const states: StageState[] = RESEARCH_STAGES.map(({ stage }) => {
    const job = latestJobOf(jobs, stage);
    if (!job) return 'upcoming';
    switch (job.status) {
      case 'done':
        return 'done';
      case 'failed':
        return 'failed';
      case 'running':
      case 'pending':
        return 'current';
      default:
        return 'upcoming';
    }
  });
  // Исследование идёт, но активной джобы ещё нет в выдаче (между стадиями) —
  // подсвечиваем первую несделанную как текущую.
  if (running && !states.includes('current') && !states.includes('failed')) {
    const idx = states.indexOf('upcoming');
    if (idx >= 0) states[idx] = 'current';
  }

  return (
    <ol className="space-y-2.5">
      {RESEARCH_STAGES.map(({ stage, line }, i) => {
        const state = states[i];
        return (
          <li
            key={stage}
            className={`flex items-center gap-2.5 text-sm ${
              state === 'current'
                ? 'font-medium text-emerald-300'
                : state === 'done'
                  ? 'text-gray-300'
                  : state === 'failed'
                    ? 'text-red-300'
                    : 'text-gray-500'
            }`}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              {state === 'done' ? (
                <Check className="h-4 w-4 text-emerald-400" aria-hidden />
              ) : state === 'current' ? (
                <Spinner className="h-4 w-4 text-emerald-400" />
              ) : state === 'failed' ? (
                <XCircle className="h-4 w-4 text-red-400" aria-hidden />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-gray-700" aria-hidden />
              )}
            </span>
            {line}
          </li>
        );
      })}
    </ol>
  );
}

/** Ошибки стадий простым русским языком + кнопка повтора. Без id/попыток/стека. */
function FailureNote({
  failedStages,
  jobs,
  projectError,
  busy,
  onRetry,
}: {
  failedStages: Array<{ stage: HeStage; line: string; name: string }>;
  jobs: HeJobSummary[];
  projectError?: string | null;
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="mt-4 space-y-2">
      {failedStages.map(({ stage, name }) => {
        const job = latestJobOf(jobs, stage);
        return (
          <div
            key={stage}
            role="alert"
            className="flex items-start gap-2.5 rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              Стадия „{name}“ не удалась: {job?.error || 'неизвестная ошибка'}
            </span>
          </div>
        );
      })}
      {failedStages.length === 0 && projectError ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>Исследование не удалось: {projectError}</span>
        </div>
      ) : null}
      <button
        type="button"
        onClick={onRetry}
        disabled={busy}
        className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? <Spinner className="h-4 w-4" /> : null}
        Попробовать снова
      </button>
    </div>
  );
}
