'use client';

/**
 * Шаг 1 мастера «Движка вертикалей» — «Исследование».
 * Три состояния: пустое (объяснение + запуск + оффер), прогресс по стадиям
 * research-пайплайна человеческими формулировками (без технических деталей)
 * и компактное «готово». Навигация между шагами — забота оболочки (ProjectDetail).
 * Питается от массива jobs проекта: состояние стадии = статус её последней джобы.
 */

import { useRef, useState, type JSX } from 'react';
import { Check, CheckCircle2, FlaskConical, Play, XCircle } from 'lucide-react';
import type { HeStage } from '@/lib/hypothesisEngine/types';
import { Spinner, StatusBox } from '../ui';
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
      <section className="mx-auto max-w-xl rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-base font-semibold text-gray-900">Идёт исследование…</h2>
        <StageChecklist jobs={jobs} running />
        {failedStages.length > 0 ? (
          <FailureNote failedStages={failedStages} jobs={jobs} busy={busy} onRetry={onStartResearch} />
        ) : null}
        <p className="mt-4 text-xs text-gray-400">
          Это займёт несколько минут, страницу можно не держать открытой.
        </p>
      </section>
    );
  }

  if (failed) {
    return (
      <section className="mx-auto max-w-xl rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="mb-4 text-base font-semibold text-gray-900">Исследование остановилось</h2>
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
      <section className="mx-auto max-w-xl rounded-xl border border-gray-200 bg-white p-6">
        <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" aria-hidden />
          <div>
            <p className="text-sm font-semibold text-emerald-800">Исследование готово</p>
            <p className="mt-0.5 text-sm text-emerald-700">
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
            className="text-xs font-medium text-gray-400 underline decoration-dotted underline-offset-4 transition hover:text-gray-600 disabled:opacity-50"
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
    <section className="mx-auto max-w-xl rounded-xl border border-gray-200 bg-white px-6 py-10 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
        <FlaskConical className="h-6 w-6" aria-hidden />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-gray-900">Исследование рынка</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-gray-600">
        Движок изучит сайт, найдёт конкурентов и их клиентов, соберёт 25–40 гипотез рынков с доказательствами
        и сложит их в вертикали. Обычно 10–20 минут.
      </p>
      <button
        type="button"
        onClick={onStartResearch}
        disabled={busy}
        className="mt-6 inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
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
    <div className="mt-8 rounded-xl border border-gray-200 bg-gray-50/50 p-4 text-left">
      <label htmlFor="he-step1-offer" className="text-xs font-semibold uppercase tracking-widest text-gray-400">
        Оффер (необязательно)
      </label>
      <p className="mt-1 text-xs leading-relaxed text-gray-400">
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
        className="mt-2 w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || !dirty}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
          Сохранить
        </button>
        {saved ? <span className="text-xs text-emerald-600">Сохранено ✓</span> : null}
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
                ? 'font-medium text-blue-700'
                : state === 'done'
                  ? 'text-gray-600'
                  : state === 'failed'
                    ? 'text-red-600'
                    : 'text-gray-400'
            }`}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              {state === 'done' ? (
                <Check className="h-4 w-4 text-emerald-500" aria-hidden />
              ) : state === 'current' ? (
                <Spinner className="h-4 w-4 text-blue-500" />
              ) : state === 'failed' ? (
                <XCircle className="h-4 w-4 text-red-500" aria-hidden />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-gray-300" aria-hidden />
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
          <StatusBox key={stage} tone="error">
            Стадия „{name}“ не удалась: {job?.error || 'неизвестная ошибка'}
          </StatusBox>
        );
      })}
      {failedStages.length === 0 && projectError ? (
        <StatusBox tone="error">Исследование не удалось: {projectError}</StatusBox>
      ) : null}
      <button
        type="button"
        onClick={onRetry}
        disabled={busy}
        className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? <Spinner className="h-4 w-4" /> : null}
        Попробовать снова
      </button>
    </div>
  );
}
