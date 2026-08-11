'use client';

/**
 * Мастер проекта клиентского ENG-кабинета: 5 шагов (Brief → Verticals →
 * Letters → Bases & Launch → Review & Launch) поверх деталки
 * GET /api/client/eng/projects/[id]. Шаг 5 — единое окно приёмки автопилота
 * («Start outreach» на шаге 2). Поллинг каждые 4с, пока есть активные джобы
 * (research, chain, base_collect, template); «Cancel all jobs» останавливает
 * прогоны проекта.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Ban, LayoutDashboard } from 'lucide-react';
import Link from 'next/link';
import type { Route } from 'next';
import { useSearchParams } from 'next/navigation';
import type { HeProject } from '@/lib/hypothesisEngine/types';
import { cancelEngProject, fetchEngProjectDetail, type HeProjectDetailResponse } from './api-client';
import { EngBadge, EngSpinner, fmtDate, projectStatusTone } from './ui';
import { EngStepBrief } from './EngStepBrief';
import { EngStepVerticals } from './EngStepVerticals';
import { EngStepLetters } from './EngStepLetters';
import { EngStepBases } from './EngStepBases';
import { EngStepReview } from './EngStepReview';

const POLL_INTERVAL_MS = 4000;

const STEPS = [
  { id: 1, label: 'Brief' },
  { id: 2, label: 'Verticals' },
  { id: 3, label: 'Letters' },
  { id: 4, label: 'Bases & Launch' },
  { id: 5, label: 'Review & Launch' },
] as const;

export type EngDetail = HeProjectDetailResponse & { project: HeProject };

export function EngProjectWizard({ projectId }: { projectId: string }) {
  const searchParams = useSearchParams();
  const [detail, setDetail] = useState<EngDetail | null>(null);
  const [error, setError] = useState('');
  // Глубокая ссылка вида ?step=3 (дашборд ведёт на нужный шаг по этапу
  // вертикали); вне диапазона — стартовый шаг 1.
  const [step, setStep] = useState<number>(() => {
    const raw = Number(searchParams?.get('step'));
    return Number.isInteger(raw) && raw >= 1 && raw <= STEPS.length ? raw : 1;
  });
  const [cancelling, setCancelling] = useState(false);
  const loadingRef = useRef(false);

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      // Тихий полл не должен плодить параллельные запросы при медленной БД.
      if (loadingRef.current) return;
      loadingRef.current = true;
      try {
        const data = await fetchEngProjectDetail(projectId);
        if (data.project) {
          setDetail(data as EngDetail);
          setError('');
        } else if (!opts.silent) {
          setError(data.error ?? 'Project not found');
        }
      } catch (e) {
        if (!opts.silent) {
          setError(e instanceof Error ? e.message : 'Failed to load the project');
        }
      } finally {
        loadingRef.current = false;
      }
    },
    [projectId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const jobs = useMemo(() => detail?.jobs ?? [], [detail]);
  const hasActiveJobs = jobs.some((j) => j.status === 'pending' || j.status === 'running');

  // Поллим, пока есть активные джобы — прогресс шагов подъезжает сам.
  useEffect(() => {
    if (!hasActiveJobs) return;
    const timer = setInterval(() => void load({ silent: true }), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasActiveJobs, load]);

  const onCancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    try {
      await cancelEngProject(projectId);
      await load({ silent: true });
    } catch {
      // 409 «нет активных задач» и гонки отмены — просто перечитываем деталку.
      await load({ silent: true });
    } finally {
      setCancelling(false);
    }
  };

  const project = detail?.project;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--cp-text-l)' }}>
        <Link
          href={'/client/eng' as Route}
          prefetch={false}
          className="inline-flex items-center gap-1 hover:underline"
        >
          <ArrowLeft className="h-3 w-3" /> Outreach
        </Link>
        <Link
          href={'/client/eng/dashboard' as Route}
          prefetch={false}
          className="inline-flex items-center gap-1 hover:underline"
        >
          <LayoutDashboard className="h-3 w-3" /> Command Center
        </Link>
      </div>

      {error && !detail ? (
        <div className="neu-card p-5 text-sm" style={{ color: 'var(--cp-red)' }}>
          {error}
        </div>
      ) : !detail ? (
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--cp-text-m)' }}>
          <EngSpinner /> Loading project…
        </div>
      ) : (
        <>
          <header className="flex flex-wrap items-center gap-2.5">
            <h1 className="truncate text-xl font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
              {project?.name}
            </h1>
            {project && <EngBadge label={project.status} tone={projectStatusTone(project.status)} />}
            {hasActiveJobs && (
              <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--cp-amber)' }}>
                <EngSpinner className="h-3 w-3" /> working…
              </span>
            )}
            <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
              {project?.website_url}
            </span>
            {hasActiveJobs && (
              <button
                type="button"
                onClick={() => void onCancel()}
                disabled={cancelling}
                className="neu-pill ml-auto px-3 py-1.5 text-[11px] font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
                style={{ color: 'var(--cp-red)' }}
                title="Stop all active project jobs (research, chains, base collect, templates)"
              >
                <Ban className="h-3 w-3" />
                {cancelling ? 'Cancelling…' : 'Cancel all jobs'}
              </button>
            )}
          </header>

          {project?.error && (
            <div className="neu-card p-3 text-xs" style={{ color: 'var(--cp-red)' }}>
              Last error: {project.error}
            </div>
          )}

          <nav className="flex flex-wrap gap-1.5" aria-label="Wizard steps">
            {STEPS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setStep(s.id)}
                className={`neu-pill px-3 py-1.5 text-xs font-semibold ${step === s.id ? 'active' : ''}`}
                style={{ color: step === s.id ? 'var(--cp-paper)' : 'var(--cp-text-m)' }}
                aria-current={step === s.id ? 'step' : undefined}
              >
                {String(s.id).padStart(2, '0')} · {s.label}
              </button>
            ))}
          </nav>

          {step === 1 && <EngStepBrief detail={detail} onChanged={() => void load({ silent: true })} />}
          {step === 2 && <EngStepVerticals detail={detail} onChanged={() => void load({ silent: true })} />}
          {step === 3 && <EngStepLetters detail={detail} onChanged={() => void load({ silent: true })} />}
          {step === 4 && <EngStepBases detail={detail} onChanged={() => void load({ silent: true })} />}
          {step === 5 && <EngStepReview detail={detail} onChanged={() => void load({ silent: true })} />}

          <div className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
            Updated {fmtDate(project?.updated_at)}
            {hasActiveJobs ? ' · auto-refreshing every 4s' : ''}
          </div>
        </>
      )}
    </div>
  );
}
