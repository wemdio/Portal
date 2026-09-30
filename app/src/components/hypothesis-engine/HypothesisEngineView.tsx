'use client';

/**
 * «Движок вертикалей» (Hypothesis Engine) — корневой клиентский компонент.
 * Список проектов + форма создания; при выборе проекта — детальный вид
 * (ProjectDetail) с поллингом джоб. Шапка — хлебные крошки + заголовок,
 * стили — токены HE из ./design, без иконок.
 */

import { useCallback, useEffect, useState } from 'react';
import type { HeProject } from '@/lib/hypothesisEngine/types';
import {
  HE_API,
  heCall,
  hePost,
  type HeProjectCreateResponse,
  type HeProjectsResponse,
} from './api';
import { HE, Spinner } from './design';
import { ProjectDetail } from './ProjectDetail';
import { ProjectStatusBadge, StatusBox, formatDate, prettyHost, prettyProjectName } from './ui';

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
    <div className="mx-auto w-full max-w-7xl space-y-8 px-4 py-8 text-left sm:px-6 lg:px-8">
      {/* Шапка: хлебные крошки, заголовок и тихая мета-строка */}
      <div className="border-b border-gray-200 pb-6">
        <nav aria-label="Хлебные крошки" className="flex items-center gap-1.5 text-xs text-gray-400">
          <span>Инструменты</span>
          <span aria-hidden>/</span>
          <span>Движок вертикалей</span>
        </nav>
        <h1 className="mt-2 text-[21px] font-semibold tracking-tight text-gray-900">
          Движок вертикалей
        </h1>
        <p className={`mt-1 ${HE.lead}`}>
          Сайт клиента → исчерпывающие гипотезы рынков с доказательствами, чистые вертикали,
          цепочки писем, вокабуляр и шаблон 85/15 под загруженную базу.
        </p>
      </div>

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

      {/* Список проектов */}
      {listLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-2xl border border-gray-200 bg-gray-50"
              aria-hidden
            />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <div className="flex min-h-[220px] flex-col items-center justify-center rounded-2xl border border-dashed border-gray-300 bg-gray-50/50 p-10 text-center">
          <p className="text-sm font-semibold text-gray-700">Проектов пока нет</p>
          <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-gray-400">
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
                className={`${HE.card} ${HE.cardPad} flex w-full flex-col gap-2 text-left transition hover:border-gray-300`}
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
