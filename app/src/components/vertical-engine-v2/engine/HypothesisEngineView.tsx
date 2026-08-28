'use client';

/**
 * «Движок вертикалей» (Hypothesis Engine) — корневой клиентский компонент.
 * Список проектов + форма создания; при выборе проекта — детальный вид
 * (ProjectDetail) с поллингом джоб. Стили — токены HE из ./design, без иконок.
 */

import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, ChevronDown, Globe2, Plus, TriangleAlert, X } from 'lucide-react';
import type { VeProject } from '@/lib/verticalEngineV2/types';
import {
  VE_API,
  veEngineCall,
  veEnginePost,
  type VeProjectCreateConflictDto,
  type VeProjectCreateResponse,
  type VeProjectsResponse,
} from './api';
import { HE, Spinner } from './design';
import { LaunchPortfolioView } from './LaunchPortfolioView';
import { ProjectDetail } from './ProjectDetail';
import { ProjectStatusBadge, StatusBox, formatDate, prettyHost, prettyProjectName } from './ui';

/** Правильная русская плюрализация (проект / проекта / проектов). */
function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 > 10 && mod100 < 20) return many;
  if (mod10 > 1 && mod10 < 5) return few;
  if (mod10 === 1) return one;
  return many;
}

/** Скелетон карточки проекта — повторяет форму настоящей карточки. */
function ProjectCardSkeleton() {
  return (
    <div className="grid min-h-20 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-gray-200 px-4 py-3 last:border-b-0" aria-hidden>
      <div className="flex min-w-0 items-center gap-3">
        <div className="h-9 w-9 shrink-0 rounded-md bg-gray-100 motion-safe:animate-pulse" />
        <div className="space-y-2">
          <div className="h-3.5 w-40 rounded bg-gray-200 motion-safe:animate-pulse" />
          <div className="h-3 w-24 rounded bg-gray-100 motion-safe:animate-pulse" />
        </div>
      </div>
      <div className="h-5 w-16 rounded-md bg-gray-100 motion-safe:animate-pulse" />
    </div>
  );
}

export function VeEngineWorkspace({
  onProjectOpenChange,
}: {
  /** Уведомляем оболочку, что открыт мастер — та прячет свой хром. */
  onProjectOpenChange?: (open: boolean) => void;
} = {}) {
  const [projects, setProjects] = useState<VeProject[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');

  const [websiteUrl, setWebsiteUrl] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [pendingConflict, setPendingConflict] = useState<VeProjectCreateConflictDto | null>(null);
  const [createPanelOpen, setCreatePanelOpen] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [workspaceView, setWorkspaceView] = useState<'projects' | 'launch-queue'>('projects');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await veEngineCall<VeProjectsResponse>(`${VE_API}/projects`);
        if (!cancelled) setProjects(Array.isArray(data.projects) ? data.projects : []);
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const createProject = useCallback(
    async (confirm: boolean) => {
      const url = websiteUrl.trim();
      if (!url || creating) return;
      setErrorMsg('');
      setCreating(true);
      try {
        const body: { website_url: string; name?: string; confirm?: boolean } = {
          website_url: url,
        };
        if (name.trim()) body.name = name.trim();
        if (confirm) body.confirm = true;
        const { ok, status, data } = await veEnginePost<VeProjectCreateResponse>(
          `${VE_API}/projects`,
          body,
        );
        if (status === 409 && data.conflict) {
          setPendingConflict(data.conflict);
          return;
        }
        if (!ok || !data.project) {
          throw new Error(data.error || 'Не удалось создать проект');
        }
        setProjects((prev) => [data.project as VeProject, ...prev]);
        setWebsiteUrl('');
        setName('');
        setCreatePanelOpen(false);
        setSelectedId(data.project.id);
        onProjectOpenChange?.(true);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Произошла ошибка');
      } finally {
        setCreating(false);
      }
    },
    [websiteUrl, name, creating, onProjectOpenChange],
  );

  const handleCreate = useCallback(async () => {
    setPendingConflict(null);
    await createProject(false);
  }, [createProject]);

  const handleConfirmCreate = useCallback(async () => {
    setPendingConflict(null);
    await createProject(true);
  }, [createProject]);

  if (selectedId) {
    return (
      <ProjectDetail
        projectId={selectedId}
        onBack={() => {
          setSelectedId(null);
          onProjectOpenChange?.(false);
        }}
      />
    );
  }

  const mobileCreateExpanded =
    createPanelOpen || pendingConflict !== null || (!listLoading && projects.length === 0);

  return (
    <div className="text-left">
      <div
        className="mb-5 inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1"
        aria-label="Раздел Vertical Engine"
      >
        <button
          type="button"
          aria-pressed={workspaceView === 'projects'}
          onClick={() => setWorkspaceView('projects')}
          className={`min-h-9 rounded-md px-3 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
            workspaceView === 'projects'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-500 hover:text-gray-900'
          }`}
        >
          Проекты
        </button>
        <button
          type="button"
          aria-pressed={workspaceView === 'launch-queue'}
          onClick={() => setWorkspaceView('launch-queue')}
          className={`min-h-9 rounded-md px-3 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
            workspaceView === 'launch-queue'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-500 hover:text-gray-900'
          }`}
        >
          Очередь запусков
        </button>
      </div>

      {workspaceView === 'launch-queue' ? (
        <LaunchPortfolioView
          onProjectOpen={(projectId) => {
            setSelectedId(projectId);
            onProjectOpenChange?.(true);
          }}
        />
      ) : (
        <>
          {errorMsg ? <div className="mb-5"><StatusBox tone="error">{errorMsg}</StatusBox></div> : null}

          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <section className="min-w-0">
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <h2 className={HE.sectionTitle}>Рабочие проекты</h2>
              <p className={`mt-1 ${HE.muted}`}>
                Продолжайте с этапа, на котором остановились.
              </p>
            </div>
            {!listLoading ? (
              <span className={HE.faint}>
                {projects.length} {pluralRu(projects.length, 'проект', 'проекта', 'проектов')}
              </span>
            ) : null}
          </div>

          {listLoading ? (
            <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
              {[1, 2, 3].map((i) => (
                <ProjectCardSkeleton key={i} />
              ))}
            </div>
          ) : projects.length === 0 ? (
            <div className={`${HE.emptyState} flex min-h-[320px] flex-col items-center justify-center`}>
              <Globe2 aria-hidden className="mb-4 h-8 w-8 text-gray-300" />
              <p className={HE.cardTitle}>Здесь появятся проекты</p>
              <p className={`mt-2 max-w-sm ${HE.lead}`}>
                Добавьте сайт клиента в форме нового проекта. Первый этап начнётся внутри проекта.
              </p>
            </div>
          ) : (
            <ul className="overflow-hidden rounded-lg border border-gray-200 bg-white">
              {projects.map((p) => (
                <li key={p.id} className="border-b border-gray-200 last:border-b-0">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedId(p.id);
                      onProjectOpenChange?.(true);
                    }}
                    className="group grid min-h-20 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 text-left transition hover:bg-gray-50/80 active:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400 sm:grid-cols-[minmax(0,1fr)_auto_auto] md:grid-cols-[minmax(0,1fr)_140px_150px_20px]"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-500">
                        <Globe2 aria-hidden className="h-4 w-4" />
                      </span>
                      <span className="min-w-0">
                        <span className={`block truncate ${HE.cardTitle}`}>
                          {prettyProjectName(p.name, p.website_url)}
                        </span>
                        <span className={`mt-0.5 block truncate ${HE.faint}`}>
                          {prettyHost(p.website_url)}
                        </span>
                        <span className="mt-2 inline-flex sm:hidden">
                          <ProjectStatusBadge status={p.status} />
                        </span>
                      </span>
                    </span>
                    <span className="hidden sm:block md:text-left">
                      <ProjectStatusBadge status={p.status} />
                    </span>
                    <span className={`hidden md:block ${HE.faint}`}>
                      Создан {formatDate(p.created_at)}
                    </span>
                    <ArrowRight
                      aria-hidden
                      className="h-4 w-4 text-gray-300 transition group-hover:translate-x-0.5 group-hover:text-gray-700"
                    />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="order-first lg:order-last lg:sticky lg:top-6">
          {listLoading || projects.length > 0 ? (
            <button
              type="button"
              onClick={() => setCreatePanelOpen((open) => !open)}
              aria-expanded={mobileCreateExpanded}
              aria-controls="ve-create-project-panel"
              className="flex h-11 w-full items-center justify-between rounded-lg border border-gray-200 bg-white px-3.5 text-sm font-semibold text-gray-800 transition hover:bg-gray-50 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 lg:hidden"
            >
              <span className="inline-flex items-center gap-2">
                <Plus aria-hidden className="h-4 w-4" />
                Новый проект
              </span>
              <ChevronDown
                aria-hidden
                className={`h-4 w-4 text-gray-400 transition-transform ${mobileCreateExpanded ? 'rotate-180' : ''}`}
              />
            </button>
          ) : null}

          <section
            id="ve-create-project-panel"
            className={`${mobileCreateExpanded ? 'block' : 'hidden'} mt-3 rounded-lg border border-gray-200 bg-gray-50/70 p-5 lg:mt-0 lg:block`}
          >
            <div className="flex items-start gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-gray-900 text-white">
                <Plus aria-hidden className="h-4 w-4" />
              </span>
              <div>
                <h2 className={HE.sectionTitle}>Новый проект</h2>
                <p className={`mt-1 ${HE.muted}`}>
                  Достаточно сайта. Название можно добавить для удобства команды.
                </p>
              </div>
            </div>

            <div className="mt-5 space-y-4">
              <label htmlFor="he-website" className="block">
                <span className="mb-1.5 block text-xs font-medium text-gray-700">Сайт клиента</span>
                <input
                  id="he-website"
                  type="text"
                  value={websiteUrl}
                  onChange={(e) => setWebsiteUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleCreate();
                  }}
                  placeholder="acme.com"
                  disabled={creating}
                  className={HE.input}
                />
              </label>
              <label htmlFor="he-project-name" className="block">
                <span className="mb-1.5 block text-xs font-medium text-gray-700">
                  Название <span className="font-normal text-gray-400">необязательно</span>
                </span>
                <input
                  id="he-project-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleCreate();
                  }}
                  placeholder="Например, Acme RU"
                  disabled={creating}
                  className={HE.input}
                />
              </label>

              {pendingConflict ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <div className="flex items-start gap-2">
                    <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-amber-800">Сайт уже прогоняли в v1</p>
                      <p className="mt-1 text-xs leading-5 text-amber-700">
                        Найдено {pendingConflict.legacy_projects?.length ?? 0} прогон(ов) для{' '}
                        {pendingConflict.domain ?? 'этого домена'}.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPendingConflict(null)}
                      aria-label="Закрыть предупреждение"
                      title="Закрыть"
                      className="rounded p-0.5 text-amber-700 hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                    >
                      <X aria-hidden className="h-4 w-4" />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleConfirmCreate()}
                    disabled={creating}
                    className="mt-3 text-xs font-semibold text-amber-800 underline underline-offset-2 hover:text-amber-950"
                  >
                    Всё равно создать в v2
                  </button>
                </div>
              ) : null}

              <button
                type="button"
                onClick={() => void handleCreate()}
                disabled={creating || !websiteUrl.trim()}
                className={`${HE.btnPrimary} w-full`}
              >
                {creating ? <Spinner className="h-3.5 w-3.5" /> : <Plus aria-hidden className="h-4 w-4" />}
                Создать проект
              </button>
            </div>
            <p className={`mt-3 ${HE.faint}`}>
              Исследование запускается отдельно внутри проекта и занимает 10–20 минут.
            </p>
          </section>
        </aside>
          </div>
        </>
      )}
    </div>
  );
}
