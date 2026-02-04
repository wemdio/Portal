'use client';

import type { ParserJob } from '@/types';
import { JobStatus } from './JobStatus';
import { ChevronRight, RefreshCw } from 'lucide-react';

type Props = {
  jobs: ParserJob[];
  activeJobId: string | null;
  onSelect: (jobId: string) => void;
  onRefresh: () => void;
  busy: boolean;
};

function formatDate(dateStr: string) {
  try {
    return new Date(dateStr).toLocaleString('ru-RU');
  } catch {
    return dateStr;
  }
}

export function JobsList({ jobs, activeJobId, onSelect, onRefresh, busy }: Props) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">История запусков</h3>
          <p className="text-sm text-gray-500">{jobs.length} jobs</p>
        </div>
        <button
          onClick={onRefresh}
          disabled={busy}
          className="inline-flex items-center rounded-lg px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${busy ? 'animate-spin' : ''}`} />
          Обновить
        </button>
      </div>

      {jobs.length === 0 ? (
        <div className="px-6 py-10 text-center text-gray-500">Запусков пока нет</div>
      ) : (
        <div className="divide-y divide-gray-100">
          {jobs.map((job) => {
            const isActive = activeJobId === job.id;
            return (
              <button
                key={job.id}
                onClick={() => onSelect(job.id)}
                className={`w-full text-left px-6 py-4 hover:bg-gray-50 transition-colors ${
                  isActive ? 'bg-blue-50' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <JobStatus status={job.status} />
                      <span className="text-xs text-gray-400">{formatDate(job.created_at)}</span>
                    </div>
                    <div className="mt-2 text-sm text-gray-700 line-clamp-2">
                      <span className="font-medium text-gray-900">text:</span> {job.config?.text}
                    </div>
                    <div className="mt-1 text-xs text-gray-500 flex flex-wrap gap-x-3 gap-y-1">
                      <span>found: {job.total_found ?? '—'}</span>
                      <span>parsed: {job.total_parsed ?? '—'}</span>
                      {job.error_message ? <span className="text-red-600 line-clamp-1">{job.error_message}</span> : null}
                    </div>
                  </div>
                  <ChevronRight className={`h-5 w-5 text-gray-400 flex-shrink-0 ${isActive ? 'text-blue-600' : ''}`} />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

