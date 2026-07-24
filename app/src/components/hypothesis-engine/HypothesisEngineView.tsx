'use client';

/**
 * «Движок вертикалей» (Hypothesis Engine) — корневой клиентский компонент.
 * Список проектов + форма создания; при выборе проекта — детальный вид
 * (ProjectDetail) с поллингом джоб.
 */

import { useCallback, useEffect, useState } from 'react';
import { Globe, Loader2, Plus, Telescope } from 'lucide-react';
import type { HeProject } from '@/lib/hypothesisEngine/types';
import {
  HE_API,
  heCall,
  hePost,
  type HeProjectCreateResponse,
  type HeProjectsResponse,
} from './api';
import { ProjectDetail } from './ProjectDetail';
import { ProjectStatusBadge, formatDate, prettyHost } from './ui';

export function HypothesisEngineView() {
  const [projects, setProjects] = useState<HeProject[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');

  const [websiteUrl, setWebsiteUrl] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await heCall<HeProjectsResponse>(`${HE_API}/projects`);
        if (!cancelled) setProjects(Array.isArray(data.projects) ? data.projects : []);
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCreate = useCallback(async () => {
    const url = websiteUrl.trim();
    if (!url || creating) return;
    setErrorMsg('');
    setCreating(true);
    try {
      const body: { website_url: string; name?: string } = { website_url: url };
      if (name.trim()) body.name = name.trim();
      const { ok, data } = await hePost<HeProjectCreateResponse>(`${HE_API}/projects`, body);
      if (!ok || !data.project) {
        throw new Error(data.error || 'Не удалось создать проект');
      }
      setProjects((prev) => [data.project as HeProject, ...prev]);
      setWebsiteUrl('');
      setName('');
      setSelectedId(data.project.id);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Произошла ошибка');
    } finally {
      setCreating(false);
    }
  }, [websiteUrl, name, creating]);

  if (selectedId) {
    return (
      <ProjectDetail
        projectId={selectedId}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 text-left">
      {/* Заголовок */}
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
          <Telescope className="h-5 w-5" aria-hidden />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Движок вертикалей</h1>
          <p className="text-sm text-gray-500">
            Сайт клиента → исчерпывающие гипотезы рынков с доказательствами, чистые вертикали,
            цепочки писем, вокабуляр и шаблон 85/15 под загруженную базу.
          </p>
        </div>
      </div>

      {/* Новый проект */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <label htmlFor="he-website" className="block text-sm font-medium text-gray-700">
          Новый проект
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Globe
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
              aria-hidden
            />
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
              className="w-full rounded-lg border border-gray-300 py-2.5 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:bg-gray-50"
            />
          </div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate();
            }}
            placeholder="Название (необязательно)"
            disabled={creating}
            className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:bg-gray-50 sm:w-56"
          />
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={creating || !websiteUrl.trim()}
            className="inline-flex h-[42px] items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creating ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Plus className="h-4 w-4" aria-hidden />
            )}
            Создать проект
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-400">
          После создания откроется страница проекта — там запускается исследование (5–15 минут).
        </p>
      </div>

      {errorMsg && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
          {errorMsg}
        </div>
      )}

      {/* Список проектов */}
      {listLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-2xl border border-gray-200 bg-gray-50"
              aria-hidden
            />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <div className="flex min-h-[200px] flex-col items-center justify-center rounded-2xl border border-dashed border-gray-200 bg-gray-50/50 p-10 text-center">
          <Telescope className="mb-3 h-8 w-8 text-gray-300" aria-hidden />
          <p className="text-sm font-medium text-gray-500">Проектов пока нет</p>
          <p className="mt-1 text-xs text-gray-400">
            Создайте первый проект по сайту клиента — AI соберёт профиль и найдёт вертикали.
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {projects.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => setSelectedId(p.id)}
                className="flex w-full flex-col gap-2 rounded-2xl border border-gray-200 bg-white p-5 text-left transition hover:border-blue-300 hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-gray-900">
                      {p.name?.trim() ? p.name : prettyHost(p.website_url)}
                    </p>
                    {p.name?.trim() ? (
                      <p className="truncate text-xs text-gray-400">{prettyHost(p.website_url)}</p>
                    ) : null}
                  </div>
                  <ProjectStatusBadge status={p.status} />
                </div>
                <p className="text-[11px] text-gray-400">Создан: {formatDate(p.created_at)}</p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
