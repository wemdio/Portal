'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Archive as ArchiveIcon, ExternalLink } from 'lucide-react';

import type {
  VeProject,
} from '@/lib/verticalEngineV2/types';
import type {
  VeLegacyCandidate,
  VeLegacyProjectDetail,
  VeLegacyProjectSummary,
} from '@/lib/verticalEngineV2/types.legacy';

import {
  VE_API,
  veCall,
  veDelete,
  vePost,
  type VeLegacyCandidatesResponse,
  type VeLegacyProjectDetailResponse,
  type VeLegacyProjectsResponse,
  type VeProjectsResponse,
} from './api';
import { VeEngineWorkspace } from './engine/HypothesisEngineView';
import { LegacyArchivePanel } from './LegacyArchivePanel';
import { LegacyReviewPanel } from './LegacyReviewPanel';
import styles from './VerticalEngineV2View.module.css';

type Tab = 'projects' | 'archive' | 'review';

function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

export function VerticalEngineV2View() {
  const [tab, setTab] = useState<Tab>('projects');
  const [projects, setProjects] = useState<VeProject[]>([]);
  const [archive, setArchive] = useState<VeLegacyProjectSummary[]>([]);
  const [candidates, setCandidates] = useState<VeLegacyCandidate[]>([]);
  const [canManageArchive, setCanManageArchive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Открыт ли конкретный проект (мастер) — тогда прячем хром оболочки (шапку и вкладки).
  const [projectOpen, setProjectOpen] = useState(false);

  const [legacyDetail, setLegacyDetail] = useState<VeLegacyProjectDetail | null>(null);
  const [legacyDetailLoading, setLegacyDetailLoading] = useState(false);
  const [busyCandidateId, setBusyCandidateId] = useState<string | null>(null);

  const loadArchive = useCallback(async () => {
    const result = await veCall<VeLegacyProjectsResponse>(
      `${VE_API}/legacy/projects`,
    );
    if (!result.ok) {
      throw new Error(result.data.error || 'Не удалось загрузить архив');
    }
    setArchive(Array.isArray(result.data.projects) ? result.data.projects : []);
  }, []);

  const loadCandidates = useCallback(async () => {
    const result = await veCall<VeLegacyCandidatesResponse>(
      `${VE_API}/legacy/candidates`,
    );
    if (!result.ok) {
      throw new Error(result.data.error || 'Не удалось загрузить кандидатов архива');
    }
    setCandidates(
      Array.isArray(result.data.candidates) ? result.data.candidates : [],
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const [projectResult, archiveResult] = await Promise.all([
          veCall<VeProjectsResponse>(`${VE_API}/projects`),
          veCall<VeLegacyProjectsResponse>(`${VE_API}/legacy/projects`),
        ]);
        if (!projectResult.ok) {
          throw new Error(projectResult.data.error || 'Не удалось загрузить проекты v2');
        }
        if (!archiveResult.ok) {
          throw new Error(archiveResult.data.error || 'Не удалось загрузить архив');
        }
        if (cancelled) return;

        setProjects(
          Array.isArray(projectResult.data.projects) ? projectResult.data.projects : [],
        );
        setArchive(
          Array.isArray(archiveResult.data.projects) ? archiveResult.data.projects : [],
        );
        const canManage =
          projectResult.data.permissions?.can_manage_legacy_links === true;
        setCanManageArchive(canManage);
        if (canManage) {
          const candidateResult = await veCall<VeLegacyCandidatesResponse>(
            `${VE_API}/legacy/candidates`,
          );
          if (!cancelled && candidateResult.ok) {
            setCandidates(
              Array.isArray(candidateResult.data.candidates)
                ? candidateResult.data.candidates
                : [],
            );
          }
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error ? loadError.message : 'Не удалось загрузить v2',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openLegacyProject = useCallback(async (projectId: string) => {
    setLegacyDetailLoading(true);
    setError('');
    try {
      const result = await veCall<VeLegacyProjectDetailResponse>(
        `${VE_API}/legacy/projects/${encodeURIComponent(projectId)}`,
      );
      if (!result.ok || !result.data.detail) {
        throw new Error(result.data.error || 'Не удалось загрузить архивный проект');
      }
      setLegacyDetail(result.data.detail);
    } catch (detailError) {
      setError(
        detailError instanceof Error
          ? detailError.message
          : 'Не удалось загрузить архивный проект',
      );
    } finally {
      setLegacyDetailLoading(false);
    }
  }, []);

  const approveCandidate = useCallback(
    async (candidate: VeLegacyCandidate, notes: string) => {
      setBusyCandidateId(candidate.id);
      setError('');
      try {
        const result = await vePost<{ error?: string }>(`${VE_API}/legacy/links`, {
          legacy_he_project_id: candidate.id,
          review_notes: notes,
          backfill_batch_id: `ui-${new Date().toISOString().slice(0, 7)}`,
        });
        if (!result.ok) {
          throw new Error(result.data.error || 'Не удалось добавить проект в архив');
        }
        await Promise.all([loadArchive(), loadCandidates()]);
      } catch (approveError) {
        setError(
          approveError instanceof Error
            ? approveError.message
            : 'Не удалось добавить проект в архив',
        );
      } finally {
        setBusyCandidateId(null);
      }
    },
    [loadArchive, loadCandidates],
  );

  const removeCandidate = useCallback(
    async (candidate: VeLegacyCandidate) => {
      setBusyCandidateId(candidate.id);
      setError('');
      try {
        const result = await veDelete<{ error?: string }>(
          `${VE_API}/legacy/links/${encodeURIComponent(candidate.id)}`,
        );
        if (!result.ok) {
          throw new Error(result.data.error || 'Не удалось убрать проект из архива');
        }
        if (legacyDetail?.project.id === candidate.id) setLegacyDetail(null);
        await Promise.all([loadArchive(), loadCandidates()]);
      } catch (removeError) {
        setError(
          removeError instanceof Error
            ? removeError.message
            : 'Не удалось убрать проект из архива',
        );
      } finally {
        setBusyCandidateId(null);
      }
    },
    [legacyDetail, loadArchive, loadCandidates],
  );

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: 'projects', label: 'Проекты', count: projects.length },
    { id: 'archive', label: 'Архив', count: archive.length },
    ...(canManageArchive
      ? [{ id: 'review' as const, label: 'Проверка архива', count: candidates.length }]
      : []),
  ];

  // Когда открыт проект — мастер в фокусе, хром оболочки не нужен.
  const showChrome = !(tab === 'projects' && projectOpen);

  return (
    <main
      className={`mx-auto w-full max-w-[1480px] px-4 sm:px-6 lg:px-8 ${
        showChrome ? 'py-6 lg:py-8' : 'py-4 lg:py-6'
      }`}
    >
      {showChrome ? (
        <>
          <header>
            <nav className="text-xs text-gray-500" aria-label="Хлебные крошки">
              Инструменты / Движок вертикалей
            </nav>
            <div className="mt-3 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
              <div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <h1 className="text-[28px] font-semibold leading-tight text-gray-950">
                    Движок вертикалей
                  </h1>
                  <span className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] font-semibold text-blue-700">
                    V2 · внутренний контур
                  </span>
                </div>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-500">
                  От исследования рынка до готовой базы и шаблона для запуска.
                </p>
              </div>
              <a
                href="/tools/hypothesis-engine"
                className="inline-flex h-9 shrink-0 items-center gap-2 self-start rounded-md border border-gray-300 bg-white px-3 text-xs font-medium text-gray-600 transition hover:border-gray-400 hover:bg-gray-50 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 sm:self-auto"
              >
                <ArchiveIcon aria-hidden className="h-3.5 w-3.5" />
                Legacy
                <ExternalLink aria-hidden className="h-3.5 w-3.5" />
              </a>
            </div>
          </header>

          <div className={`mt-6 ${styles.tabs}`} role="tablist" aria-label="Разделы движка">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                onClick={() => {
                  setTab(item.id);
                  if (item.id !== 'archive') setLegacyDetail(null);
                }}
                aria-selected={tab === item.id}
                className={`flex items-center gap-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${styles.tab} ${
                  tab === item.id ? styles.tabActive : ''
                }`}
              >
                {item.label}
                {typeof item.count === 'number' ? (
                  <span className="min-w-5 rounded-md bg-gray-100 px-1.5 py-0.5 text-center text-[11px] text-gray-500">
                    {item.count}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </>
      ) : null}

      <div className={`${showChrome ? 'mt-6' : ''} space-y-5`}>
        {error ? <ErrorNotice message={error} /> : null}

        {tab === 'projects' ? (
          <VeEngineWorkspace onProjectOpenChange={setProjectOpen} />
        ) : null}

        {loading && tab !== 'projects' ? (
          <div className="rounded-lg border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
            Загружаем изолированный контур…
          </div>
        ) : null}

        {!loading && tab === 'archive' ? (
          <LegacyArchivePanel
            projects={archive}
            detail={legacyDetail}
            detailLoading={legacyDetailLoading}
            onSelect={(id) => void openLegacyProject(id)}
            onBack={() => setLegacyDetail(null)}
          />
        ) : null}

        {!loading && tab === 'review' && canManageArchive ? (
          <LegacyReviewPanel
            candidates={candidates}
            busyId={busyCandidateId}
            onApprove={approveCandidate}
            onRemove={removeCandidate}
          />
        ) : null}
      </div>
    </main>
  );
}
