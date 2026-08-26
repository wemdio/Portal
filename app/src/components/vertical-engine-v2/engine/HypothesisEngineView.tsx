'use client';

/**
 * «Движок вертикалей» (Hypothesis Engine) — корневой клиентский компонент.
 * Список проектов + форма создания; при выборе проекта — детальный вид
 * (ProjectDetail) с поллингом джоб. Шапка — хлебные крошки + заголовок,
 * стили — токены HE из ./design, без иконок.
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

export function VeEngineWorkspace() {
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
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Произошла ошибка');
      } finally {
        setCreating(false);
      }
    },
    [websiteUrl, name, creating],
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
        onBack={() => setSelectedId(null)}
      />
    );
  }

  return (
    <div className="space-y-8 text-left">
      {/* Шапку и хлебные крошки даёт оболочка (VerticalEngineV2View) — здесь сразу контент. */}

      {/* Новый проект */}
      <div className={`${HE.card} ${HE.cardPad}`}>
        <label htmlFor="he-website" className={`block ${HE.secTitle}`}>
          Новый проект
        </label>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
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
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate();
            }}
            placeholder="Название (необязательно)"
            disabled={creating}
            className={`${HE.input} sm:w-56`}
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
        <p className={`mt-2 text-xs ${HE.muted}`}>
          После создания откроется страница проекта: там запускается исследование (5–15 минут).
        </p>
      </div>

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
      {listLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="h-24 rounded-2xl border border-gray-200 bg-gray-50 motion-safe:animate-pulse"
              aria-hidden
            />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <div className="flex min-h-[220px] flex-col items-center justify-center rounded-2xl border border-dashed border-gray-300 bg-gray-50/50 p-10 text-center">
          <p className="text-sm font-semibold text-gray-700">Проектов пока нет</p>
          <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-gray-500">
            Создайте первый проект: укажите сайт клиента. Движок соберёт рынки, письма и шаблон.
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => setSelectedId(p.id)}
                className={`${HE.card} ${HE.cardPad} flex w-full flex-col gap-2 text-left transition hover:border-gray-300 hover:shadow-sm active:scale-[0.98] active:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-gray-900">
                      {prettyProjectName(p.name, p.website_url)}
                    </p>
                    {p.name?.trim() ? (
                      <p className={`truncate text-xs ${HE.muted}`}>{prettyHost(p.website_url)}</p>
                    ) : null}
                  </div>
                  <ProjectStatusBadge status={p.status} />
                </div>
                <p className={`text-[11px] ${HE.muted}`}>Создан: {formatDate(p.created_at)}</p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
