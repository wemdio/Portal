'use client';

/**
 * «Движок вертикалей» (Hypothesis Engine) — корневой клиентский компонент.
 * Список проектов + форма создания; при выборе проекта — детальный вид
 * (ProjectDetail) с поллингом джоб. Стили — токены HE из ./design, без иконок.
 */

import { useCallback, useEffect, useState } from 'react';
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
    <div className={`${HE.card} ${HE.cardPad}`} aria-hidden>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="h-3.5 w-36 rounded bg-gray-200 motion-safe:animate-pulse" />
          <div className="h-3 w-24 rounded bg-gray-100 motion-safe:animate-pulse" />
        </div>
        <div className="h-5 w-16 rounded-md bg-gray-100 motion-safe:animate-pulse" />
      </div>
      <div className="mt-7 h-3 w-20 rounded bg-gray-100 motion-safe:animate-pulse" />
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

  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  return (
    <div className="space-y-9 text-left">
      {/* Шапку и хлебные крошки даёт оболочка (VerticalEngineV2View) — здесь сразу контент. */}

      {/* Быстрое создание проекта */}
      <section className={`${HE.card} ${HE.cardPad}`}>
        <h2 className={HE.sectionTitle}>Новый проект</h2>
        <p className={`mt-1 ${HE.muted}`}>
          Укажите сайт клиента — движок соберёт рынки, гипотезы, письма и шаблон.
        </p>
        <div className="mt-4 flex flex-col gap-2.5 sm:flex-row">
          <label htmlFor="he-website" className="sr-only">
            Сайт клиента
          </label>
          <input
            id="he-website"
            type="text"
            value={websiteUrl}
            onChange={(e) => setWebsiteUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate();
            }}
            placeholder="Сайт клиента: acme.com"
            disabled={creating}
            className={`${HE.input} flex-1`}
          />
          <label htmlFor="he-project-name" className="sr-only">
            Название проекта (необязательно)
          </label>
          <input
            id="he-project-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate();
            }}
            placeholder="Название (необязательно)"
            disabled={creating}
            className={`${HE.input} sm:w-60`}
          />
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={creating || !websiteUrl.trim()}
            className={`${HE.btnPrimary} inline-flex shrink-0 items-center justify-center gap-2`}
          >
            {creating ? <Spinner className="h-3.5 w-3.5" /> : null}
            Создать проект
          </button>
        </div>
        <p className={`mt-3 ${HE.faint}`}>
          После создания откроется страница проекта: там запускается исследование (5–15 минут).
        </p>
      </section>

      {errorMsg && <StatusBox tone="error">{errorMsg}</StatusBox>}

      {pendingConflict ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl border border-amber-200 bg-white p-6 shadow-xl">
            <h3 className="text-base font-semibold text-gray-900">
              Этот сайт уже прогоняли в v1
            </h3>
            <p className="mt-2 text-sm text-gray-600">
              В Движке вертикалей v1 уже есть {pendingConflict.legacy_projects?.length ?? 0} прогон(ов)
              для домена {pendingConflict.domain ?? ''}:
            </p>
            <ul className="mt-2 space-y-1">
              {(pendingConflict.legacy_projects ?? []).map((p) => (
                <li key={p.id} className="text-sm text-gray-500">
                  {p.name || p.website_url}
                </li>
              ))}
            </ul>
            <div className="mt-5 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setPendingConflict(null)}
                disabled={creating}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmCreate()}
                disabled={creating}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Всё равно создать в v2
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Список проектов */}
      <section>
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <h2 className={HE.sectionTitle}>Проекты</h2>
          {!listLoading && projects.length > 0 ? (
            <span className={HE.faint}>
              {projects.length} {pluralRu(projects.length, 'проект', 'проекта', 'проектов')}
            </span>
          ) : null}
        </div>

        {listLoading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <ProjectCardSkeleton key={i} />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="flex min-h-[240px] flex-col items-center justify-center rounded-2xl border border-dashed border-gray-300 bg-gray-50/50 px-10 py-12 text-center">
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full border border-gray-200 bg-white text-lg text-gray-300">
              +
            </div>
            <p className={HE.cardTitle}>Проектов пока нет</p>
            <p className={`mt-1.5 max-w-sm ${HE.lead}`}>
              Создайте первый проект выше: укажите сайт клиента. Движок соберёт рынки, гипотезы,
              письма и шаблон.
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {projects.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(p.id);
                    onProjectOpenChange?.(true);
                  }}
                  className={`${HE.card} ${HE.cardPad} ${HE.cardHover} group flex w-full flex-col text-left transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className={`truncate ${HE.cardTitle}`}>
                        {prettyProjectName(p.name, p.website_url)}
                      </p>
                      {p.name?.trim() ? (
                        <p className={`mt-1 truncate ${HE.faint}`}>{prettyHost(p.website_url)}</p>
                      ) : null}
                    </div>
                    <ProjectStatusBadge status={p.status} />
                  </div>
                  <div className="mt-6 flex items-center justify-between gap-2">
                    <span className={HE.faint}>Создан {formatDate(p.created_at)}</span>
                    <span
                      aria-hidden
                      className="text-sm leading-none text-gray-300 transition group-hover:translate-x-0.5 group-hover:text-blue-500 group-hover:opacity-100"
                    >
                      →
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
