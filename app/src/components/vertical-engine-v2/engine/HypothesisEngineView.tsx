'use client';

/**
 * «Движок вертикалей» (Hypothesis Engine) — корневой клиентский компонент.
 * Список проектов + форма создания; при выборе проекта — детальный вид
 * (ProjectDetail) с поллингом джоб. Стили — токены HE и scoped-классы
 * ../ve2.css, без иконок-декора: статус = точка + моно-тег.
 */

import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, ChevronDown, Plus, X } from 'lucide-react';
import type { VeProject } from '@/lib/verticalEngineV2/types';
import {
  VE_API,
  veEngineCall,
  veEnginePost,
  type VeProjectCreateConflictDto,
  type VeProjectCreateResponse,
  type VeProjectsResponse,
} from './api';
import { HE, Spinner, StatusDot } from './design';
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

/** Скелетон строки проекта — повторяет форму настоящей строки. */
function ProjectCardSkeleton() {
  return (
    <div className="ve2-row" aria-hidden>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="ve2-skel h-3.5 w-40 motion-safe:animate-pulse" />
        <div className="ve2-skel h-3 w-24 motion-safe:animate-pulse" />
      </div>
      <div className="ve2-skel h-5 w-16 motion-safe:animate-pulse" />
    </div>
  );
}

export function VeEngineWorkspace({
  view,
  onProjectOpenChange,
}: {
  view?: 'projects' | 'launch-queue';
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
  const [internalView, setInternalView] = useState<'projects' | 'launch-queue'>('projects');
  const activeView = view ?? internalView;
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
        const { ok, status, data } = await veEnginePost<VeProjectCreateResponse>(`${VE_API}/projects`, body);
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

  const mobileCreateExpanded = createPanelOpen || pendingConflict !== null || (!listLoading && projects.length === 0);

  return (
    <div className="text-left">
      {view === undefined ? (
        <div className="ve2-tabs mb-5" role="tablist" aria-label="Раздел Vertical Engine">
          <button
            type="button"
            role="tab"
            aria-selected={activeView === 'projects'}
            onClick={() => setInternalView('projects')}
            className="ve2-tab"
          >
            Проекты
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeView === 'launch-queue'}
            onClick={() => setInternalView('launch-queue')}
            className="ve2-tab"
          >
            Очередь запусков
          </button>
        </div>
      ) : null}

      {activeView === 'launch-queue' ? (
        <LaunchPortfolioView
          onProjectOpen={(projectId) => {
            setSelectedId(projectId);
            onProjectOpenChange?.(true);
          }}
        />
      ) : (
        <>
          {errorMsg ? (
            <div className="mb-5">
              <StatusBox tone="error">{errorMsg}</StatusBox>
            </div>
          ) : null}

          <div className="ve2-home-grid">
            <section className="min-w-0">
              <div className="mb-4 flex items-end justify-between gap-4">
                <div>
                  <p className="ve2-eb">01 → Рабочие проекты</p>
                  <p className={`mt-1 ${HE.muted}`}>Продолжайте с этапа, на котором остановились.</p>
                </div>
                {!listLoading ? (
                  <span className={HE.faint}>
                    {projects.length} {pluralRu(projects.length, 'проект', 'проекта', 'проектов')}
                  </span>
                ) : null}
              </div>

              {listLoading ? (
                <div className="ve2-rows">
                  {[1, 2, 3].map((i) => (
                    <ProjectCardSkeleton key={i} />
                  ))}
                </div>
              ) : projects.length === 0 ? (
                <div className={`${HE.emptyState} flex min-h-[320px] flex-col items-center justify-center`}>
                  <p className={HE.cardTitle}>Здесь появятся проекты</p>
                  <p className={`mt-2 max-w-sm ${HE.lead}`}>
                    Добавьте сайт клиента в форме нового проекта. Первый этап начнётся внутри проекта.
                  </p>
                </div>
              ) : (
                <ul className="ve2-rows">
                  {projects.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedId(p.id);
                          onProjectOpenChange?.(true);
                        }}
                        className="ve2-row group"
                      >
                        <span className="min-w-0 flex-1">
                          <span className={`block truncate ${HE.cardTitle}`}>
                            {prettyProjectName(p.name, p.website_url)}
                          </span>
                          <span className={`mt-0.5 block truncate ${HE.faint}`}>{prettyHost(p.website_url)}</span>
                          <span className="mt-2 inline-flex sm:hidden">
                            <ProjectStatusBadge status={p.status} />
                          </span>
                        </span>
                        <span className={`hidden w-[170px] shrink-0 md:block ${HE.faint}`}>
                          Создан {formatDate(p.created_at)}
                        </span>
                        <span className="hidden w-[130px] shrink-0 sm:block">
                          <ProjectStatusBadge status={p.status} />
                        </span>
                        <ArrowRight
                          aria-hidden
                          className="ve2-t-q h-4 w-4 shrink-0 transition group-hover:translate-x-0.5"
                        />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <aside className="order-first lg:order-last">
              {listLoading || projects.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setCreatePanelOpen((open) => !open)}
                  aria-expanded={mobileCreateExpanded}
                  aria-controls="ve-create-project-panel"
                  className="ve2-card flex h-11 w-full items-center justify-between px-3.5 text-sm font-semibold lg:hidden"
                >
                  <span className="inline-flex items-center gap-2">
                    <Plus aria-hidden className="h-4 w-4" />
                    Новый проект
                  </span>
                  <ChevronDown
                    aria-hidden
                    className={`ve2-t-q h-4 w-4 transition-transform ${mobileCreateExpanded ? 'rotate-180' : ''}`}
                  />
                </button>
              ) : null}

              <section
                id="ve-create-project-panel"
                className={`${mobileCreateExpanded ? 'block' : 'hidden'} ve2-create-panel mt-3 lg:mt-0 lg:block`}
              >
                <p className="ve2-eb">02 → Новый проект</p>
                <p className={`mt-2 ${HE.muted}`}>Достаточно сайта. Название можно добавить для удобства команды.</p>

                <div className="mt-5 space-y-4">
                  <label htmlFor="he-website" className="block">
                    <span className={`mb-1.5 block text-xs font-medium ${HE.muted}`}>Сайт клиента</span>
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
                    <span className={`mb-1.5 block text-xs font-medium ${HE.muted}`}>
                      Название <span className="ve2-faint">необязательно</span>
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
                    <div className="ve2-nt ve2-nt-warn p-3">
                      <div className="flex items-start gap-2.5">
                        <StatusDot tone="warn" className="mt-[7px] shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-semibold">Сайт уже прогоняли в v1</p>
                          <p className={`mt-1 text-xs leading-5 ${HE.muted}`}>
                            Найдено {pendingConflict.legacy_projects?.length ?? 0} прогон(ов) для{' '}
                            {pendingConflict.domain ?? 'этого домена'}.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setPendingConflict(null)}
                          aria-label="Закрыть предупреждение"
                          title="Закрыть"
                          className="ve2-b-quiet"
                        >
                          <X aria-hidden className="h-4 w-4" />
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleConfirmCreate()}
                        disabled={creating}
                        className="ve2-b-quiet mt-3 text-xs font-semibold underline underline-offset-2"
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
