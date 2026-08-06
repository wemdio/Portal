'use client';

/**
 * Список проектов клиентского ENG-кабинета + форма «New project».
 * Данные — GET/POST /api/client/eng/projects (роут сам скоупит: только свои).
 * После создания — переход на мастер проекта (research стартует сразу на
 * бэкенде, мастер его поллит).
 *
 * Дефолтная точка ENG-кабинета — Command Center (/client/eng/dashboard):
 * если проекты уже есть, список перенаправляет туда (обратно — «All projects»
 * с дашборда, он же ?list=1, который редирект отключает).
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, Globe, LayoutDashboard } from 'lucide-react';
import {
  createEngProject,
  fetchEngProjects,
  type EngProjectListItem,
} from './api-client';
import { EngBadge, EngCard, EngSpinner, fmtDate, projectStatusTone } from './ui';

export function EngProjectsList() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // ?list=1 — явный заход на список (кнопка «All projects» с дашборда):
  // авто-редирект на Command Center отключён, иначе кнопка зациклится.
  const forceList = searchParams?.get('list') === '1';
  const [projects, setProjects] = useState<EngProjectListItem[] | null>(null);
  const [error, setError] = useState('');
  const [website, setWebsite] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setProjects(await fetchEngProjects());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load projects');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Дефолтная точка после логина: с проектами — сразу Command Center.
  useEffect(() => {
    if (!forceList && projects && projects.length > 0) {
      router.replace('/client/eng/dashboard' as Route);
    }
  }, [forceList, projects, router]);

  const redirecting = !forceList && projects !== null && projects.length > 0;

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creating || !website.trim()) return;
    setCreating(true);
    setError('');
    try {
      const res = await createEngProject({ website_url: website.trim(), name: name.trim() || undefined });
      if (res.project?.id) {
        router.push(`/client/eng/projects/${res.project.id}` as Route);
        return;
      }
      setError(res.error ?? 'Failed to create the project');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create the project');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* New project */}
      <EngCard>
        <h3 className="ds-eyebrow mb-3">New project</h3>
        <form onSubmit={(e) => void onCreate(e)} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex-1 flex flex-col gap-1">
            <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
              Website <span aria-hidden>*</span>
            </span>
            <input
              type="text"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="acme.com"
              required
              className="neu-pill w-full px-3 py-2 text-sm bg-transparent outline-none"
              style={{ color: 'var(--cp-paper)' }}
            />
          </label>
          <label className="flex-1 flex flex-col gap-1">
            <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
              Project name (optional)
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme outbound"
              className="neu-pill w-full px-3 py-2 text-sm bg-transparent outline-none"
              style={{ color: 'var(--cp-paper)' }}
            />
          </label>
          <button
            type="submit"
            disabled={creating || !website.trim()}
            className="neu-pill active px-4 py-2 text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
            style={{ color: 'var(--cp-paper)' }}
          >
            {creating && <EngSpinner />}
            Create &amp; start research
          </button>
        </form>
        <p className="mt-2 text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
          Research starts right away: we profile the site, map competitors and draft market verticals for your offer.
        </p>
      </EngCard>

      {error && (
        <div className="text-sm" style={{ color: 'var(--cp-red)' }}>
          {error}
        </div>
      )}

      {/* Projects list */}
      {projects === null && !error ? (
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--cp-text-m)' }}>
          <EngSpinner /> Loading projects…
        </div>
      ) : redirecting ? (
        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--cp-text-m)' }}>
          <EngSpinner /> Opening the Command Center…
        </div>
      ) : projects && projects.length === 0 ? (
        <EngCard>
          <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
            No projects yet — create your first one above.
          </p>
        </EngCard>
      ) : (
        <div className="flex flex-col gap-3">
          {forceList && (
            <div className="flex justify-end">
              <Link
                href={'/client/eng/dashboard' as Route}
                prefetch={false}
                className="neu-pill px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5"
                style={{ color: 'var(--cp-paper)' }}
              >
                <LayoutDashboard className="h-3.5 w-3.5" />
                Command Center
              </Link>
            </div>
          )}
        <div className="grid gap-3 md:grid-cols-2">
          {(projects ?? []).map((p) => (
            <Link
              key={p.id}
              href={`/client/eng/projects/${p.id}` as Route}
              prefetch={false}
              className="neu-card p-4 flex flex-col gap-2 transition-colors hover:border-[var(--cp-divider-strong)]"
            >
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 shrink-0" style={{ color: 'var(--cp-text-l)' }} />
                <span className="truncate text-sm font-semibold" style={{ color: 'var(--cp-paper)' }}>
                  {p.name}
                </span>
                <span className="ml-auto shrink-0">
                  <EngBadge label={p.status} tone={projectStatusTone(p.status)} />
                </span>
              </div>
              <div className="truncate text-xs" style={{ color: 'var(--cp-text-l)' }}>
                {p.website_url}
              </div>
              <div
                className="mt-1 flex items-center gap-3 text-[11px] ds-mono"
                style={{ color: 'var(--cp-text-m)' }}
              >
                <span>{p.vertical_count} verticals</span>
                <span>{p.base_count} bases</span>
                <span className="ml-auto inline-flex items-center gap-1">
                  {fmtDate(p.created_at)}
                  <ArrowRight className="h-3 w-3" />
                </span>
              </div>
              {p.error && (
                <div className="text-[11px]" style={{ color: 'var(--cp-red)' }}>
                  {p.error}
                </div>
              )}
            </Link>
          ))}
        </div>
        </div>
      )}
    </div>
  );
}
