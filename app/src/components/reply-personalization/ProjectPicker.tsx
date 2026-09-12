'use client';

import { useEffect, useState } from 'react';
import { fetchProjects, type ProjectListItem } from './api';

export function ProjectPicker({ onSelect }: { onSelect: (project: ProjectListItem) => void }) {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchProjects()
      .then((res) => setProjects(res.projects))
      .catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить проекты'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="p-6 text-sm text-zinc-500">Загрузка проектов...</div>;
  if (error) return <div className="p-6 text-sm text-red-600">{error}</div>;
  if (!projects.length) return <div className="p-6 text-sm text-zinc-500">Нет доступных проектов.</div>;

  return (
    <div className="max-w-xl mx-auto py-10">
      <h1 className="text-xl font-semibold text-zinc-900 mb-4">Персонализированные ответы — выберите проект</h1>
      <div className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white">
        {projects.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelect(p)}
            className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-zinc-50"
          >
            <span className="text-sm font-medium text-zinc-900">{p.client}</span>
            {!p.hasKnowledgeBase ? (
              <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                настройте базу знаний
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
