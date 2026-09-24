'use client';

import { JobRail, JOB_RAIL_STATUS_LABELS, type JobRailItem } from '@/components/ui/JobRail';
import { fmtDateTime, type RuJob } from './shared';

export const JOB_STATUS = JOB_RAIL_STATUS_LABELS;

interface Props {
  jobs: RuJob[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRepeat: (job: RuJob) => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
}

function toItem(job: RuJob): JobRailItem {
  const target = job.config?.limit ?? null;
  const done = job.total_parsed ?? 0;
  return {
    id: job.id,
    status: job.status,
    title: target ? `На ${target} компаний` : 'Запуск',
    subtitle: `${fmtDateTime(job.created_at)} · готово ${done}${target ? ` из ${target}` : ''}`,
    percent: job.status === 'completed' ? 100 : job.progress_percent ?? 0,
    deletable: job.status !== 'running' && job.status !== 'pending',
  };
}

/** Колонка запусков русского автоаутрича: подписи свои, раскладка общая. */
export function JobList({ jobs, activeId, onSelect, onNew, onRepeat, onDelete, onRefresh }: Props) {
  return (
    <JobRail
      items={jobs.map(toItem)}
      activeId={activeId}
      onSelect={onSelect}
      onNew={onNew}
      onRefresh={onRefresh}
      onRepeat={(id) => {
        const job = jobs.find((j) => j.id === id);
        if (job) onRepeat(job);
      }}
      onDelete={onDelete}
    />
  );
}
