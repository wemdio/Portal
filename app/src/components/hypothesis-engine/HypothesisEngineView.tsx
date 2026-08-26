'use client';

/**
 * «Движок вертикалей» (Hypothesis Engine) — корневой клиентский компонент.
 * Список проектов + форма создания; при выборе проекта — детальный вид
 * (ProjectDetail) с поллингом джоб. Шапка — хлебные крошки + заголовок,
 * стили — токены HE из ./design, без иконок.
 */

import { useEffect, useState } from 'react';
import type { HeProject } from '@/lib/hypothesisEngine/types';
import {
  HE_API,
  heCall,
  type HeProjectsResponse,
} from './api';
import { HE } from './design';
import { ProjectDetail } from './ProjectDetail';
import { ProjectStatusBadge, formatDate, prettyHost, prettyProjectName } from './ui';

export function HypothesisEngineView() {
  const [projects, setProjects] = useState<HeProject[]>([]);
  const [listLoading, setListLoading] = useState(true);

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

      {/* Переход на v2: новые прогоны только там */}
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-4">
        <p className="text-sm font-semibold text-emerald-900">
          Движок вертикалей переехал в v2
        </p>
        <p className={`mt-1 text-sm ${HE.muted}`}>
          Новые прогоны создаются в новой версии. Здесь доступны только уже созданные проекты.
        </p>
        <a
          href="/tools/vertical-engine-v2"
          className="mt-3 inline-flex items-center justify-center rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
        >
          Открыть Движок вертикалей v2
        </a>
      </div>

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
