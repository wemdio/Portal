'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Clock, Activity, Hourglass } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';

interface ActiveJob {
  id: string;
  status: 'pending' | 'running';
  tg_chat_id: number;
  tg_message_id: number;
  created_at: string;
  started_at: string | null;
  sender_name: string;
  filename: string;
  file_size_bytes: number | null;
  duration_seconds: number | null;
  chat_title: string | null;
}

function formatBytes(bytes: number | null) {
  if (bytes == null || !Number.isFinite(bytes)) return '';
  const sizes = ['Б', 'КБ', 'МБ', 'ГБ'];
  if (bytes === 0) return '0 Б';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
}

function formatDuration(seconds: number | null) {
  if (seconds == null) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatElapsed(fromIso: string | null, nowMs: number): string {
  if (!fromIso) return '';
  const elapsedSec = Math.max(0, Math.floor((nowMs - new Date(fromIso).getTime()) / 1000));
  if (elapsedSec < 60) return `${elapsedSec}с`;
  const m = Math.floor(elapsedSec / 60);
  const s = elapsedSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface Props {
  /** Called when an active job completes (transitions from running → not in list). Lets parent refresh the list. */
  onJobCompleted?: () => void;
}

export default function ActiveJobsPanel({ onJobCompleted }: Props) {
  const [jobs, setJobs] = useState<ActiveJob[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const prevIdsRef = useRef<Set<string>>(new Set());

  const fetchJobs = useCallback(async () => {
    try {
      const res = await authFetch('/api/tools/tg-transcribe/active');
      if (!res.ok) return;
      const json = (await res.json()) as { jobs: ActiveJob[] };
      const next = json.jobs ?? [];

      // Detect transitions: if a previously-running id disappears, notify parent
      const nextIds = new Set(next.map((j) => j.id));
      const prevIds = prevIdsRef.current;
      let anyCompleted = false;
      for (const id of prevIds) {
        if (!nextIds.has(id)) anyCompleted = true;
      }
      prevIdsRef.current = nextIds;

      setJobs(next);
      setLoaded(true);

      if (anyCompleted && onJobCompleted) onJobCompleted();
    } catch {
      // ignore
    }
  }, [onJobCompleted]);

  // Poll every 5s
  useEffect(() => {
    void fetchJobs();
    const t = setInterval(() => void fetchJobs(), 5000);
    return () => clearInterval(t);
  }, [fetchJobs]);

  // Tick "elapsed" every second (only when there are running jobs to show)
  useEffect(() => {
    const hasRunning = jobs.some((j) => j.status === 'running');
    if (!hasRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [jobs]);

  // Hide entirely until first load to avoid flash
  if (!loaded || jobs.length === 0) return null;

  const runningCount = jobs.filter((j) => j.status === 'running').length;
  const pendingCount = jobs.length - runningCount;

  return (
    <aside className="hidden lg:block w-72 shrink-0">
      <div className="sticky top-4 space-y-3">
        <div className="rounded-xl border border-indigo-100 bg-white/95 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-indigo-50 bg-indigo-50/40">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-indigo-700">
              <Activity className="h-3.5 w-3.5" />
              Транскрибация в фоне
            </div>
            <span className="text-[10px] text-indigo-500/80">
              {runningCount > 0 && `${runningCount} в работе`}
              {runningCount > 0 && pendingCount > 0 && ' · '}
              {pendingCount > 0 && `${pendingCount} в очереди`}
            </span>
          </div>

          <ul className="divide-y divide-gray-100">
            {jobs.map((j) => {
              const isRunning = j.status === 'running';
              const elapsed = isRunning ? formatElapsed(j.started_at, now) : null;
              return (
                <li key={j.id} className="px-3 py-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {isRunning ? (
                      <Loader2 className="h-3 w-3 animate-spin text-indigo-500 shrink-0" />
                    ) : (
                      <Hourglass className="h-3 w-3 text-gray-400 shrink-0" />
                    )}
                    <span className="text-xs font-medium text-gray-800 truncate">
                      {j.sender_name || 'Unknown'}
                    </span>
                    {!isRunning && (
                      <span className="ml-auto text-[10px] text-gray-400 shrink-0">в очереди</span>
                    )}
                    {isRunning && elapsed && (
                      <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-indigo-600 shrink-0">
                        <Clock className="h-2.5 w-2.5" />
                        {elapsed}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[10px] text-gray-400 truncate" title={j.filename}>
                    {j.filename || '—'}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-gray-400">
                    {j.duration_seconds != null && <span>{formatDuration(j.duration_seconds)}</span>}
                    {j.file_size_bytes != null && <span>{formatBytes(j.file_size_bytes)}</span>}
                    {j.chat_title && (
                      <span className="truncate" title={j.chat_title}>
                        · {j.chat_title}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </aside>
  );
}
