'use client';

/**
 * Степпер стадий research-пайплайна: site_profile → competitors → brand_cloud
 * → hypotheses → evidence → clustering. Питается от массива jobs проекта.
 */

import { CheckCircle2, Circle, Clock, XCircle } from 'lucide-react';
import type { HeStage } from '@/lib/hypothesisEngine/types';
import { Spinner } from './ui';
import type { HeJobSummary } from './api';

const RESEARCH_STAGES: Array<{ stage: HeStage; label: string }> = [
  { stage: 'site_profile', label: 'Профиль сайта' },
  { stage: 'competitors', label: 'Конкуренты' },
  { stage: 'brand_cloud', label: 'Brand cloud' },
  { stage: 'hypotheses', label: 'Гипотезы' },
  { stage: 'evidence', label: 'Доказательства' },
  { stage: 'clustering', label: 'Кластеризация' },
];

/** Последняя (по порядку в выдаче) джоба данной стадии. */
function latestJobOf(jobs: HeJobSummary[], stage: HeStage): HeJobSummary | undefined {
  for (let i = jobs.length - 1; i >= 0; i -= 1) {
    if (jobs[i].stage === stage) return jobs[i];
  }
  return undefined;
}

function StageIcon({ job }: { job: HeJobSummary | undefined }) {
  if (!job) return <Circle className="h-4 w-4 text-gray-300" aria-hidden />;
  switch (job.status) {
    case 'running':
      return <Spinner className="h-4 w-4 text-blue-500" />;
    case 'pending':
      return <Clock className="h-4 w-4 text-gray-400" aria-hidden />;
    case 'done':
      return <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden />;
    case 'failed':
      return <XCircle className="h-4 w-4 text-red-500" aria-hidden />;
    default:
      return <Circle className="h-4 w-4 text-gray-300" aria-hidden />;
  }
}

export function ResearchStepper({ jobs }: { jobs: HeJobSummary[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-2">
      {RESEARCH_STAGES.map(({ stage, label }, idx) => {
        const job = latestJobOf(jobs, stage);
        const failed = job?.status === 'failed';
        return (
          <li key={stage} className="flex items-center gap-1">
            {idx > 0 && <span className="mx-1 h-px w-4 bg-gray-200" aria-hidden />}
            <span
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${
                failed
                  ? 'border-red-200 bg-red-50 text-red-700'
                  : job?.status === 'running'
                    ? 'border-blue-200 bg-blue-50 text-blue-700'
                    : job?.status === 'done'
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      : 'border-gray-200 bg-white text-gray-500'
              }`}
              title={failed && job?.error ? job.error : undefined}
            >
              <StageIcon job={job} />
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
