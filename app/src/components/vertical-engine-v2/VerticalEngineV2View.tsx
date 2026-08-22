'use client';

import { useCallback, useEffect, useState } from 'react';

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
  type VeProjectCreateResponse,
  type VeProjectsResponse,
} from './api';
import { VeEngineWorkspace } from './engine/HypothesisEngineView';
import { LegacyArchivePanel } from './LegacyArchivePanel';
import { LegacyReviewPanel } from './LegacyReviewPanel';

type Tab = 'projects' | 'archive' | 'review';

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      {message}
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

  const [websiteUrl, setWebsiteUrl] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

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

  const createProject = useCallback(async () => {
    if (!websiteUrl.trim() || creating) return;
    setCreating(true);
    setError('');
    try {
      const result = await vePost<VeProjectCreateResponse>(`${VE_API}/projects`, {
        website_url: websiteUrl.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      if (!result.ok || !result.data.project) {
        throw new Error(result.data.error || 'Не удалось создать проект');
      }
      setProjects((current) => [result.data.project as VeProject, ...current]);
      setWebsiteUrl('');
      setName('');
    } catch (createError) {
      setError(
        createError instanceof Error ? createError.message : 'Не удалось создать проект',
      );
    } finally {
      setCreating(false);
    }
  }, [creating, name, websiteUrl]);

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
    { id: 'projects', label: 'Проекты v2', count: projects.length },
    { id: 'archive', label: 'Архив', count: archive.length },
    ...(canManageArchive
      ? [{ id: 'review' as const, label: 'Проверка архива', count: candidates.length }]
      : []),
  ];

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="border-b border-slate-200 pb-6">
        <nav className="text-xs text-slate-400" aria-label="Хлебные крошки">
          Инструменты / Движок вертикалей / v2
        </nav>
        <div className="mt-2 flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
                Движок вертикалей v2
              </h1>
              <span className="rounded-full bg-violet-50 px-3 py-1 text-xs font-semibold text-violet-700">
                скрытая разработка
              </span>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
              Изолированная копия внутреннего движка. Правки моделей, писем и сбора
              баз делаются здесь и не трогают ENG. Старый инструмент пока остаётся
              рабочим для специалистов.
            </p>
          </div>
          <a
            href="/tools/hypothesis-engine"
            className="shrink-0 text-sm font-medium text-slate-500 hover:text-slate-950"
          >
            Открыть legacy-инструмент ↗
          </a>
        </div>
      </header>

      <div className="mt-6 flex flex-wrap gap-2 border-b border-slate-200 pb-3">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              setTab(item.id);
              if (item.id !== 'archive') setLegacyDetail(null);
            }}
            className={`rounded-full px-4 py-2 text-sm font-medium transition ${
              tab === item.id
                ? 'bg-slate-950 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {item.label}
            {typeof item.count === 'number' ? ` · ${item.count}` : ''}
          </button>
        ))}
      </div>

      <div className="mt-6 space-y-5">
        {error ? <ErrorNotice message={error} /> : null}

        {tab === 'projects' ? <VeEngineWorkspace /> : null}

        {loading && tab !== 'projects' ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
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
